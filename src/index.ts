/**
 * LLM-Hub - Main Entry Point
 *
 * Cloudflare Workers gateway with hub-and-spoke IR architecture.
 * Consumer plugins: OpenAI, Anthropic (extensible)
 * Provider formats: OpenAI, Anthropic (extensible via transforms)
 */

import { Hono } from "hono";
import { stream } from "hono/streaming";
import { authMiddleware } from "./middleware/auth";
import { rateLimitMiddleware } from "./middleware/rate-limiter";
import { billingMiddleware } from "./middleware/billing";
import { forwardToProvider, resolveTarget, streamEventsFromProvider } from "./core/gateway";
import type { KeyRecord, ProviderKeyRecord } from "./middleware/auth";
import { consumerRegistry } from "./consumers";
import { detectClient } from "./lib/client-detector";
import { resolveProviderById, getProviderApiKey, listProviderFormats } from "./lib/provider-resolver";
import { LoadBalancer, parseProviderKeys } from "./lib/load-balancer";
import {
  providerResponseToIR,
  parseProviderError,
  getProviderCapabilities,
  type ProviderInstanceConfig,
} from "./lib/provider-engine";

import testApp from "./routes/test";
import adminProviders from "./routes/admin-providers";
import adminKeys from "./routes/admin-keys";
import { getAllProviderConfigs } from "./lib/provider-config";

const app = new Hono<{ Bindings: { KV: KVNamespace; DB: D1Database } }>();

// Mount routes
app.route("/test", testApp);
app.route("/admin/providers", adminProviders);
app.route("/admin/keys", adminKeys);

// ========================================================================
// CORS
// ========================================================================

app.use("*", async (c, next) => {
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  c.header("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-key, anthropic-version, x-hub-provider, user-agent");
  if (c.req.method === "OPTIONS") return c.body(null, 204);
  await next();
});

// ========================================================================
// Health & Info
// ========================================================================

app.get("/", (c) =>
  c.json({
    name: "llm-hub",
    version: "0.1.2",
    consumers: consumerRegistry.list(),
    providers: listProviderFormats(),
  })
);

app.get("/v1/models", authMiddleware(), async (c) => {
  const keyRecord = c.get("keyRecord") as KeyRecord;
  const kv = c.env.KV;

  // Built-in formats
  const formats = listProviderFormats().filter((fmt) =>
    keyRecord.allowedProviders.length === 0 || keyRecord.allowedProviders.includes(fmt.id)
  );

  const models: { id: string; object: string; owned_by: string }[] = [];
  for (const fmt of formats) {
    // Built-in formats don't have predefined models; they're determined by the user's key config
    // For now, we skip built-in format models unless explicitly configured
  }

  // Dynamic providers
  const dynamicConfigs = await getAllProviderConfigs(kv);
  for (const cfg of dynamicConfigs) {
    if (keyRecord.allowedProviders.length > 0 && !keyRecord.allowedProviders.includes(cfg.providerId)) {
      continue;
    }
    for (const m of cfg.models) {
      models.push({ id: m, object: "model", owned_by: cfg.providerId });
    }
  }

  return c.json({ object: "list", data: models });
});

// ========================================================================
// Universal API route - handles all consumer formats
// ========================================================================

app.post("/v1/*", authMiddleware(), rateLimitMiddleware(), billingMiddleware(), async (c) => {
  const path = c.req.path;
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));

  // Detect consumer format
  const consumer = consumerRegistry.find(path, c.req.raw.headers, body);
  if (!consumer) {
    return c.json({ error: { message: `Unsupported endpoint: ${path}`, type: "not_found" } }, 404);
  }

  // Detect client (Claude Code, Codex, etc.)
  const client = detectClient(c.req.raw.headers);
  c.set("client", client);

  // Parse consumer request to IR
  const irRequest = consumer.parseRequest(body);
  const model = consumer.getModel(body);

  // Resolve provider
  const resolved = await resolveProvider(c, model);
  if (!resolved.ok) return resolved.response;

  const { providerConfig, providerKeyRecord, providerId } = resolved;

  // Override model if provider prefix was stripped
  irRequest.model = resolved.model || irRequest.model;

  // Override base URL if configured
  if (providerKeyRecord.baseUrl) {
    providerConfig.baseUrl = providerKeyRecord.baseUrl;
  }

  // Forward to provider
  const providerResponse = await forwardToProvider(providerConfig, irRequest, providerKeyRecord.apiKey);

  if (!providerResponse.ok) {
    const errBody = await providerResponse.json().catch(() => ({}));
    const err = parseProviderError(errBody, providerConfig);
    return c.json(consumer.buildError({
      ...err,
      message: `${err.message} (provider: ${providerId}, status: ${providerResponse.status})`,
    }), providerResponse.status as 400 | 401 | 429 | 500);
  }

  // Streaming
  const capabilities = getProviderCapabilities(providerConfig);
  if (consumer.isStreaming(body) && capabilities.streaming) {
    c.header("Content-Type", "text/event-stream");
    c.header("Cache-Control", "no-cache");
    c.header("Connection", "keep-alive");

    return stream(c, async (s) => {
      const streamId = `${consumer.id}_${crypto.randomUUID()}`;
      let totalPromptTokens = 0;
      let totalCompletionTokens = 0;

      try {
        for await (const { event } of streamEventsFromProvider(providerConfig, providerResponse)) {
          if (!event) continue;

          if (event.type === "usage") {
            totalPromptTokens = event.usage.promptTokens;
            totalCompletionTokens = event.usage.completionTokens;
          }

          const chunk = consumer.buildStreamChunk(event, {
            model: irRequest.model,
            id: streamId,
          });
          if (chunk) {
            await s.write(chunk);
          }
        }

        // Consumer-specific end signal
        if (consumer.id === "openai") {
          await s.write("data: [DONE]\n\n");
        } else if (consumer.id === "anthropic") {
          await s.write(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
        }

        c.set("usage", {
          promptTokens: totalPromptTokens,
          completionTokens: totalCompletionTokens,
          totalTokens: totalPromptTokens + totalCompletionTokens,
        });
      } catch (err) {
        const errorChunk = consumer.buildError({
          message: String(err),
          type: "stream_error",
        });
        await s.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
      }
    });
  }

  // Non-streaming
  const responseBody = await providerResponse.json();
  const irResponse = providerResponseToIR(responseBody, providerConfig);

  if (irResponse.usage) {
    c.set("usage", irResponse.usage);
  } else {
    c.set("usage", { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
  }

  return c.json(consumer.buildResponse(irResponse));
});

// ========================================================================
// Provider resolution with load balancing
// ========================================================================

interface ResolveError {
  ok: false;
  response: Response;
}

interface ResolveSuccess {
  ok: true;
  providerConfig: ProviderInstanceConfig;
  providerKeyRecord: ProviderKeyRecord;
  providerId: string;
  model: string;
}

type ResolveResult = ResolveError | ResolveSuccess;

async function resolveProvider(c: any, model: string): Promise<ResolveResult> {
  const keyRecord = c.get("keyRecord") as KeyRecord;
  const providerKeys = c.get("providerKeys") as Record<string, ProviderKeyRecord>;
  const kv = c.env.KV as KVNamespace;

  const { providerId, model: resolvedModel } = resolveTarget(c.req.raw.headers, model);

  // Check provider permission
  if (keyRecord.allowedProviders.length > 0 && !keyRecord.allowedProviders.includes(providerId)) {
    return {
      ok: false,
      response: c.json({
        error: {
          message: `Provider "${providerId}" not allowed for this key`,
          type: "auth_error",
          code: "provider_denied",
        },
      }, 403),
    };
  }

  // Resolve provider (built-in or dynamic)
  const resolved = await resolveProviderById(providerId, kv);
  if (!resolved.ok) {
    return {
      ok: false,
      response: c.json({
        error: {
          message: resolved.error.message,
          type: resolved.error.type,
          code: resolved.error.code,
        },
      }, resolved.status),
    };
  }

  let providerConfig = resolved.config;

  // Get provider API key (with load balancing)
  const keyData = providerKeys[providerId];
  if (!keyData) {
    return {
      ok: false,
      response: c.json({
        error: {
          message: `No API key configured for provider "${providerId}"`,
          type: "auth_error",
          code: "missing_provider_key",
        },
      }, 400),
    };
  }

  // Parse provider key config (single or load-balanced)
  const keyConfig = parseProviderKeys(keyData as unknown as Record<string, unknown>);
  let providerKeyRecord: ProviderKeyRecord;

  if (keyConfig instanceof LoadBalancer) {
    const slot = keyConfig.next();
    if (!slot) {
      return {
        ok: false,
        response: c.json({
          error: {
            message: `All keys for provider "${providerId}" are unhealthy`,
            type: "service_error",
            code: "all_keys_unhealthy",
          },
        }, 503),
      };
    }
    providerKeyRecord = { apiKey: slot.apiKey, baseUrl: slot.baseUrl };
  } else {
    providerKeyRecord = { apiKey: keyConfig!.apiKey, baseUrl: keyConfig!.baseUrl };
  }

  // For dynamic providers, apply config overrides
  if (resolved.dynamicConfig) {
    const cfg = resolved.dynamicConfig;
    if (cfg.baseUrl) providerConfig.baseUrl = cfg.baseUrl;
    if (cfg.chatEndpoint) providerConfig.endpoint = cfg.chatEndpoint;
    if (cfg.authType) providerConfig.auth = { type: cfg.authType };
    if (cfg.capabilities) providerConfig.capabilities = { ...providerConfig.capabilities, ...cfg.capabilities };
    if (cfg.extraHeaders) providerConfig.extraHeaders = cfg.extraHeaders;
  }

  // Override with user's configured baseUrl if set
  if (providerKeyRecord.baseUrl) {
    providerConfig.baseUrl = providerKeyRecord.baseUrl;
  }

  // Check model permission
  if (keyRecord.allowedModels.length > 0) {
    const fullModel = `${providerId}:${resolvedModel}`;
    if (!keyRecord.allowedModels.includes(fullModel) && !keyRecord.allowedModels.includes(resolvedModel)) {
      return {
        ok: false,
        response: c.json({
          error: {
            message: `Model "${resolvedModel}" not allowed for this key`,
            type: "auth_error",
            code: "model_denied",
          },
        }, 403),
      };
    }
  }

  // Set context for billing
  c.set("providerId", providerId);
  c.set("model", resolvedModel);

  return { ok: true, providerConfig, providerKeyRecord, providerId, model: resolvedModel };
}

// ========================================================================
// Admin API
// ========================================================================

app.get("/admin/usage", authMiddleware(), async (c) => {
  const keyRecord = c.get("keyRecord") as KeyRecord;
  const kv = c.env.KV;

  const results: Record<string, unknown>[] = [];
  const now = new Date();
  for (let i = 0; i < 6; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const spend = await kv.get(`key:${keyRecord.keyId}:spend:${monthKey}`);
    if (spend) {
      results.push({
        date: monthKey,
        cost: Number(spend),
        requests: null,
        prompt_tokens: null,
        completion_tokens: null,
        total_tokens: null,
      });
    }
  }

  return c.json({ data: results });
});

app.get("/admin/keys", authMiddleware(), async (c) => {
  const keyRecord = c.get("keyRecord") as KeyRecord;
  return c.json({ key: keyRecord });
});

// ========================================================================
// Error Handler
// ========================================================================

app.onError((err, c) => {
  console.error("Gateway error:", err);
  return c.json({
    error: { message: err.message || "Internal server error", type: "internal_error" },
  }, 500);
});

app.notFound((c) =>
  c.json({ error: { message: "Not found", type: "not_found" } }, 404)
);

export default app;
