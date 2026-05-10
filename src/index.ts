/**
 * LLM-Hub - Main Entry Point
 *
 * Cloudflare Workers gateway with hub-and-spoke IR architecture.
 */

import { Hono } from "hono";
import { stream } from "hono/streaming";
import { authMiddleware } from "./middleware/auth";
import { rateLimitMiddleware } from "./middleware/rate-limiter";
import { billingMiddleware } from "./middleware/billing";
import { buildIRRequest, forwardToProvider, resolveTarget, streamFromProvider } from "./core/gateway";
import { registry } from "./core/converter";
import type { BaseConverter } from "./core/converter";
import type { KeyRecord, ProviderKeyRecord } from "./middleware/auth";
import "./providers";

const app = new Hono<{ Bindings: { KV: KVNamespace; DB: D1Database } }>();

// ========================================================================
// Health & Info
// ========================================================================

app.get("/", (c) =>
  c.json({
    name: "llm-hub",
    version: "0.1.0",
    providers: registry.list(),
  })
);

app.get("/v1/models", authMiddleware(), async (c) => {
  const keyRecord = c.get("keyRecord") as KeyRecord;
  const providers = registry.list().filter((id) =>
    keyRecord.allowedProviders.length === 0 || keyRecord.allowedProviders.includes(id)
  );

  const models: { id: string; object: string; owned_by: string }[] = [];
  for (const pid of providers) {
    const ConverterClass = registry.get(pid);
    if (!ConverterClass) continue;
    const conv = new ConverterClass();
    // Simplified model list - in production, load from KV
    models.push({ id: `${pid}:default`, object: "model", owned_by: pid });
  }

  return c.json({ object: "list", data: models });
});

// ========================================================================
// Chat Completions (OpenAI-compatible)
// ========================================================================

app.post("/v1/chat/completions",
  authMiddleware(),
  rateLimitMiddleware(),
  billingMiddleware(),
  async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const keyRecord = c.get("keyRecord") as KeyRecord;
    const providerKeys = c.get("providerKeys") as Record<string, ProviderKeyRecord>;

    // Resolve target
    const { providerId, model } = resolveTarget(c.req.raw.headers, String(body.model || ""));

    // Check provider permission
    if (keyRecord.allowedProviders.length > 0 && !keyRecord.allowedProviders.includes(providerId)) {
      return c.json({
        error: { message: `Provider "${providerId}" not allowed for this key`, type: "auth_error", code: "provider_denied" }
      }, 403);
    }

    // Get converter
    const ConverterClass = registry.get(providerId);
    if (!ConverterClass) {
      return c.json({
        error: { message: `Unknown provider "${providerId}"`, type: "invalid_request_error", code: "unknown_provider" }
      }, 400);
    }
    const converter = new ConverterClass() as BaseConverter;

    // Get provider API key
    const providerKeyRecord = providerKeys[providerId];
    if (!providerKeyRecord) {
      return c.json({
        error: { message: `No API key configured for provider "${providerId}"`, type: "auth_error", code: "missing_provider_key" }
      }, 400);
    }

    // Build IR request
    const irRequest = buildIRRequest(body);
    irRequest.model = model || irRequest.model;

    // Override base URL if configured
    if (providerKeyRecord.baseUrl) {
      converter.options.baseUrl = providerKeyRecord.baseUrl;
    }

    // Check model permission
    if (keyRecord.allowedModels.length > 0) {
      const fullModel = `${providerId}:${irRequest.model}`;
      if (!keyRecord.allowedModels.includes(fullModel) && !keyRecord.allowedModels.includes(irRequest.model)) {
        return c.json({
          error: { message: `Model "${irRequest.model}" not allowed for this key`, type: "auth_error", code: "model_denied" }
        }, 403);
      }
    }

    // Set context for billing
    c.set("providerId", providerId);
    c.set("model", irRequest.model);

    // Forward to provider
    const providerResponse = await forwardToProvider(converter, irRequest, providerKeyRecord.apiKey);

    if (!providerResponse.ok) {
      const errBody = await providerResponse.json().catch(() => ({}));
      const err = converter.parseError(errBody);
      return c.json({
        error: { message: err.message, type: err.type, code: err.code }
      }, providerResponse.status as 400 | 401 | 429 | 500);
    }

    // Streaming
    if (body.stream && converter.capabilities.streaming) {
      c.header("Content-Type", "text/event-stream");
      c.header("Cache-Control", "no-cache");
      c.header("Connection", "keep-alive");

      return stream(c, async (s) => {
        let totalPromptTokens = 0;
        let totalCompletionTokens = 0;

        try {
          for await (const chunk of streamFromProvider(converter, providerResponse)) {
            await s.write(chunk);

            // Try to extract usage from last chunk
            try {
              if (chunk.includes('"usage"')) {
                const parsed = JSON.parse(chunk.replace(/^data: /, ""));
                if (parsed.usage) {
                  totalPromptTokens = parsed.usage.prompt_tokens || 0;
                  totalCompletionTokens = parsed.usage.completion_tokens || 0;
                }
              }
            } catch {
              // Ignore parse errors in usage extraction
            }
          }

          // Store usage for billing middleware
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

    // Store usage for billing middleware
    if (irResponse.usage) {
      c.set("usage", irResponse.usage);
    } else {
      c.set("usage", { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
    }

    // Convert back to OpenAI format
    const openAIResponse = {
      id: irResponse.id,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: irResponse.model,
      choices: irResponse.choices.map((choice) => ({
        index: choice.index,
        message: {
          role: "assistant",
          content: choice.message.content
            .filter((p) => p.type === "text")
            .map((p) => (p as { text: string }).text)
            .join(""),
          refusal: choice.message.refusal,
        },
        finish_reason: choice.finishReason,
      })),
      usage: irResponse.usage,
    };

    return c.json(openAIResponse);
  }
);

// ========================================================================
// Admin API (for frontend management)
// ========================================================================

app.get("/admin/usage", authMiddleware(), async (c) => {
  const keyRecord = c.get("keyRecord") as KeyRecord;
  const kv = c.env.KV;

  // Fetch last 6 months of spend from KV
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
  // In production, this should be admin-only
  const keyRecord = c.get("keyRecord") as KeyRecord;
  return c.json({ key: keyRecord });
});

// ========================================================================
// Error Handler
// ========================================================================

app.onError((err, c) => {
  console.error("Gateway error:", err);
  return c.json({
    error: { message: err.message || "Internal server error", type: "internal_error" }
  }, 500);
});

app.notFound((c) =>
  c.json({ error: { message: "Not found", type: "not_found" } }, 404)
);

export default app;
