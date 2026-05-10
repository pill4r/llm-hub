/**
 * LLM-Hub - Main Entry Point
 *
 * Cloudflare Workers gateway with hub-and-spoke IR architecture.
 * Consumer plugins: OpenAI, Anthropic (extensible)
 * Provider plugins: OpenAI, DeepSeek, Anthropic (extensible)
 */

import { Hono } from "hono";
import { stream } from "hono/streaming";
import { authMiddleware } from "./middleware/auth";
import { rateLimitMiddleware } from "./middleware/rate-limiter";
import { billingMiddleware } from "./middleware/billing";
import { forwardToProvider, resolveTarget, streamEventsFromProvider } from "./core/gateway";
import { registry } from "./core/converter";
import type { BaseConverter } from "./core/converter";
import type { KeyRecord, ProviderKeyRecord } from "./middleware/auth";
import { consumerRegistry } from "./consumers";
import type { ConsumerPlugin } from "./consumers";
import { detectClient } from "./lib/client-detector";
import { LoadBalancer, parseProviderKeys } from "./lib/load-balancer";

import "./providers";
import testApp from "./routes/test";

const app = new Hono<{ Bindings: { KV: KVNamespace; DB: D1Database } }>();

// Mount test routes
app.route("/test", testApp);
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
    providers: registry.list(),
  })
);

app.get("/v1/models", authMiddleware(), async (c) => {
  const keyRecord = c.get("keyRecord") as KeyRecord;
  const formats = registry.list().filter((fmt) =>
    keyRecord.allowedProviders.length === 0 || keyRecord.allowedProviders.includes(fmt.id)
  );

  const models: { id: string; object: string; owned_by: string }[] = [];
  for (const fmt of formats) {
    const ConverterClass = registry.get(fmt.id);
    if (!ConverterClass) continue;
    const conv = new ConverterClass();
    for (const m of conv.getSupportedModels()) {
      models.push({ id: m.id, object: "model", owned_by: fmt.name });
    }
  }

  return c.json({ object: "list", data: models });
});

// ========================================================================
// Universal API route - handles all consumer formats
// ========================================================================

app.post("/*", authMiddleware(), rateLimitMiddleware(), billingMiddleware(), async (c) => {
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

  const { converter, providerKeyRecord, providerId } = resolved;

  // Override model if provider prefix was stripped
  irRequest.model = resolved.model || irRequest.model;

  // Override base URL if configured
  if (providerKeyRecord.baseUrl) {
    converter.options.baseUrl = providerKeyRecord.baseUrl;
  }

  // Forward to provider
  const providerResponse = await forwardToProvider(converter, irRequest, providerKeyRecord.apiKey);

  if (!providerResponse.ok) {
    const errBody = await providerResponse.json().catch(() => ({}));
    const err = converter.parseError(errBody);
    return c.json(consumer.buildError({
      ...err,
      message: `${err.message} (provider: ${providerId}, status: ${providerResponse.status})`,
    }), providerResponse.status as 400 | 401 | 429 | 500);
  }

  // Streaming
  if (consumer.isStreaming(body) && converter.capabilities.streaming) {
    c.header("Content-Type", "text/event-stream");
    c.header("Cache-Control", "no-cache");
    c.header("Connection", "keep-alive");

    return stream(c, async (s) => {
      const streamId = `${consumer.id}_${crypto.randomUUID()}`;
      let totalPromptTokens = 0;
      let totalCompletionTokens = 0;

      try {
        for await (const { event } of streamEventsFromProvider(converter, providerResponse)) {
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
  const irResponse = converter.responseFromProvider(responseBody);

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
  converter: BaseConverter;
  providerKeyRecord: ProviderKeyRecord;
  providerId: string;
  model: string;
}

type ResolveResult = ResolveError | ResolveSuccess;

async function resolveProvider(c: any, model: string): Promise<ResolveResult> {
  const keyRecord = c.get("keyRecord") as KeyRecord;
  const providerKeys = c.get("providerKeys") as Record<string, ProviderKeyRecord>;

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

  // Get converter
  const ConverterClass = registry.get(providerId);
  if (!ConverterClass) {
    return {
      ok: false,
      response: c.json({
        error: {
          message: `Unknown provider "${providerId}"`,
          type: "invalid_request_error",
          code: "unknown_provider",
        },
      }, 400),
    };
  }
  const converter = new ConverterClass() as BaseConverter;

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

  return { ok: true, converter, providerKeyRecord, providerId, model: resolvedModel };
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
