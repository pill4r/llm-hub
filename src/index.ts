/**
 * LLM-Hub - Main Entry Point
 *
 * Cloudflare Workers gateway with hub-and-spoke IR architecture.
 * Supports both OpenAI (/v1/chat/completions) and Anthropic (/v1/messages)
 * consumer-facing APIs, routing to any configured provider.
 */

import { Hono } from "hono";
import { stream } from "hono/streaming";
import { authMiddleware } from "./middleware/auth";
import { rateLimitMiddleware } from "./middleware/rate-limiter";
import { billingMiddleware } from "./middleware/billing";
import {
  buildIRRequest,
  buildIRRequestFromAnthropic,
  buildOpenAIResponse,
  buildAnthropicResponse,
  buildAnthropicError,
  buildOpenAIStreamChunk,
  buildAnthropicStreamChunk,
  forwardToProvider,
  resolveTarget,
  streamEventsFromProvider,
} from "./core/gateway";
import { registry } from "./core/converter";
import type { BaseConverter } from "./core/converter";
import type { KeyRecord, ProviderKeyRecord } from "./middleware/auth";
import type { StreamEvent } from "./core/ir";
import "./providers";

const app = new Hono<{ Bindings: { KV: KVNamespace; DB: D1Database } }>();

// ========================================================================
// CORS
// ========================================================================

app.use("*", async (c, next) => {
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  c.header("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-key, anthropic-version");
  if (c.req.method === "OPTIONS") return c.body(null, 204);
  await next();
});

// ========================================================================
// Health & Info
// ========================================================================

app.get("/", (c) =>
  c.json({
    name: "llm-hub",
    version: "0.1.1",
    supportedFormats: registry.list(),
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
// Shared request handler
// ========================================================================

interface HandleRequestOptions {
  c: any; // Hono Context
  body: Record<string, unknown>;
  consumerFormat: "openai" | "anthropic";
}

async function resolveProvider(
  c: any,
  body: Record<string, unknown>
): Promise<
  | { ok: false; response: Response }
  | {
      ok: true;
      converter: BaseConverter;
      providerKeyRecord: ProviderKeyRecord;
      providerId: string;
      model: string;
    }
> {
  const keyRecord = c.get("keyRecord") as KeyRecord;
  const providerKeys = c.get("providerKeys") as Record<string, ProviderKeyRecord>;

  const { providerId, model } = resolveTarget(c.req.raw.headers, String(body.model || ""));

  // Check provider permission
  if (keyRecord.allowedProviders.length > 0 && !keyRecord.allowedProviders.includes(providerId)) {
    return {
      ok: false,
      response: c.json(
        {
          error: {
            message: `Provider "${providerId}" not allowed for this key`,
            type: "auth_error",
            code: "provider_denied",
          },
        },
        403
      ),
    };
  }

  // Get converter
  const ConverterClass = registry.get(providerId);
  if (!ConverterClass) {
    return {
      ok: false,
      response: c.json(
        {
          error: {
            message: `Unknown provider "${providerId}"`,
            type: "invalid_request_error",
            code: "unknown_provider",
          },
        },
        400
      ),
    };
  }
  const converter = new ConverterClass() as BaseConverter;

  // Get provider API key
  const providerKeyRecord = providerKeys[providerId];
  if (!providerKeyRecord) {
    return {
      ok: false,
      response: c.json(
        {
          error: {
            message: `No API key configured for provider "${providerId}"`,
            type: "auth_error",
            code: "missing_provider_key",
          },
        },
        400
      ),
    };
  }

  // Override base URL if configured
  if (providerKeyRecord.baseUrl) {
    converter.options.baseUrl = providerKeyRecord.baseUrl;
  }

  // Check model permission
  const actualModel = String(body.model || "");
  if (keyRecord.allowedModels.length > 0) {
    const fullModel = `${providerId}:${actualModel}`;
    if (!keyRecord.allowedModels.includes(fullModel) && !keyRecord.allowedModels.includes(actualModel)) {
      return {
        ok: false,
        response: c.json(
          {
            error: {
              message: `Model "${actualModel}" not allowed for this key`,
              type: "auth_error",
              code: "model_denied",
            },
          },
          403
        ),
      };
    }
  }

  // Set context for billing
  c.set("providerId", providerId);
  c.set("model", actualModel);

  return { ok: true, converter, providerKeyRecord, providerId, model };
}

// ========================================================================
// Chat Completions (OpenAI-compatible consumer)
// ========================================================================

app.post("/v1/chat/completions",
  authMiddleware(),
  rateLimitMiddleware(),
  billingMiddleware(),
  async (c) => {
    const body = await c.req.json<Record<string, unknown>>();

    const resolved = await resolveProvider(c, body);
    if (!resolved.ok) return resolved.response;

    const { converter, providerKeyRecord, providerId, model } = resolved;

    // Build IR request
    const irRequest = buildIRRequest(body);
    irRequest.model = model || irRequest.model;

    // Forward to provider
    const providerResponse = await forwardToProvider(converter, irRequest, providerKeyRecord.apiKey);

    if (!providerResponse.ok) {
      const errBody = await providerResponse.json().catch(() => ({}));
      const err = converter.parseError(errBody);
      return c.json({
        error: { message: err.message, type: err.type, code: err.code },
      }, providerResponse.status as 400 | 401 | 429 | 500);
    }

    // Streaming
    if (body.stream && converter.capabilities.streaming) {
      c.header("Content-Type", "text/event-stream");
      c.header("Cache-Control", "no-cache");
      c.header("Connection", "keep-alive");

      return stream(c, async (s) => {
        const completionId = `chatcmpl-${crypto.randomUUID()}`;
        let totalPromptTokens = 0;
        let totalCompletionTokens = 0;

        try {
          for await (const { event } of streamEventsFromProvider(converter, providerResponse)) {
            if (!event) continue;

            // Track usage
            if (event.type === "usage") {
              totalPromptTokens = event.usage.promptTokens;
              totalCompletionTokens = event.usage.completionTokens;
            }

            const chunk = buildOpenAIStreamChunk(event, irRequest.model, completionId);
            if (chunk) {
              await s.write(`data: ${JSON.stringify(chunk)}\n\n`);
            }
          }

          // Store usage for billing
          c.set("usage", {
            promptTokens: totalPromptTokens,
            completionTokens: totalCompletionTokens,
            totalTokens: totalPromptTokens + totalCompletionTokens,
          });
        } catch (err) {
          await s.write(`data: ${JSON.stringify({ error: { message: String(err), type: "stream_error" } })}\n\n`);
        } finally {
          await s.write("data: [DONE]\n\n");
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

    return c.json(buildOpenAIResponse(irResponse));
  }
);

// ========================================================================
// Messages (Anthropic-compatible consumer)
// ========================================================================

app.post("/v1/messages",
  authMiddleware(),
  rateLimitMiddleware(),
  billingMiddleware(),
  async (c) => {
    const body = await c.req.json<Record<string, unknown>>();

    // Anthropic uses "model" field same as OpenAI
    const resolved = await resolveProvider(c, body);
    if (!resolved.ok) {
      // Return Anthropic-format error
      const err = await resolved.response.json().catch(() => ({
        error: { message: "Unknown error", type: "api_error" },
      }));
      return c.json(buildAnthropicError(err.error?.message || "Unknown error", err.error?.type || "api_error"), resolved.response.status);
    }

    const { converter, providerKeyRecord, providerId, model } = resolved;

    // Build IR request from Anthropic format
    const irRequest = buildIRRequestFromAnthropic(body);
    irRequest.model = model || irRequest.model;

    // Forward to provider
    const providerResponse = await forwardToProvider(converter, irRequest, providerKeyRecord.apiKey);

    if (!providerResponse.ok) {
      const errBody = await providerResponse.json().catch(() => ({}));
      const err = converter.parseError(errBody);
      return c.json(buildAnthropicError(err.message, err.type || "api_error"), providerResponse.status as 400 | 401 | 429 | 500);
    }

    // Streaming
    if (body.stream && converter.capabilities.streaming) {
      c.header("Content-Type", "text/event-stream");
      c.header("Cache-Control", "no-cache");
      c.header("Connection", "keep-alive");

      return stream(c, async (s) => {
        const msgId = `msg_${crypto.randomUUID().replace(/-/g, "")}`;
        let totalPromptTokens = 0;
        let totalCompletionTokens = 0;
        let hasStarted = false;

        try {
          for await (const { event } of streamEventsFromProvider(converter, providerResponse)) {
            if (!event) continue;

            if (event.type === "stream_start" && !hasStarted) {
              hasStarted = true;
              const startChunk = buildAnthropicStreamChunk(
                { type: "stream_start", id: msgId, model: irRequest.model },
                irRequest.model
              );
              if (startChunk) await s.write(startChunk);
            }

            // Track usage
            if (event.type === "usage") {
              totalPromptTokens = event.usage.promptTokens;
              totalCompletionTokens = event.usage.completionTokens;
            }

            const chunk = buildAnthropicStreamChunk(event, irRequest.model);
            if (chunk) {
              await s.write(chunk);
            }
          }

          // End signal
          await s.write(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);

          // Store usage for billing
          c.set("usage", {
            promptTokens: totalPromptTokens,
            completionTokens: totalCompletionTokens,
            totalTokens: totalPromptTokens + totalCompletionTokens,
          });
        } catch (err) {
          await s.write(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "stream_error", message: String(err) } })}\n\n`);
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

    return c.json(buildAnthropicResponse(irResponse));
  }
);

// ========================================================================
// Admin API (for frontend management)
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
