/**
 * Admin Provider Management API
 *
 * Dynamic provider registration without code changes.
 */

import { Hono } from "hono";
import {
  parseProviderConfig,
  type ProviderConfig,
  type ProviderValidation,
  TEST_PAYLOAD,
  buildEndpoint,
  buildAuthHeaders,
  getAllProviderConfigs,
  saveProviderConfigs,
} from "../lib/provider-config";
import { registry } from "../core/converter";
import { adminAuthMiddleware } from "../middleware/admin-auth";

const admin = new Hono<{ Bindings: { KV: KVNamespace; ADMIN_TOKEN: string } }>();

// Apply auth to all routes
admin.use("*", adminAuthMiddleware());

// ========================================================================
// Helpers
// ========================================================================

function findConfig(configs: ProviderConfig[], providerId: string): ProviderConfig | undefined {
  return configs.find((c) => c.providerId === providerId);
}

/**
 * Discover models from a provider's /models endpoint.
 * Supports OpenAI-compatible and Anthropic-compatible formats.
 */
async function discoverModels(
  baseUrl: string,
  protocol: string,
  authType: string,
  apiKey: string
): Promise<{ id: string; name: string }[]> {
  const modelsEndpoint = `${baseUrl.replace(/\/$/, "")}/models`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };

  switch (authType) {
    case "bearer":
      headers["Authorization"] = `Bearer ${apiKey}`;
      break;
    case "api-key":
      headers["api-key"] = apiKey;
      break;
    case "x-api-key":
      headers["x-api-key"] = apiKey;
      break;
  }

  const resp = await fetch(modelsEndpoint, { headers });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}`);
  }

  const data = await resp.json() as Record<string, unknown>;

  // OpenAI-compatible: { data: [{ id: "gpt-4", ... }] }
  const openaiData = data.data as any[] | undefined;
  if (Array.isArray(openaiData)) {
    return openaiData.map((m) => ({
      id: String(m.id || m.model || ""),
      name: String(m.id || m.model || m.display_name || ""),
    })).filter((m) => m.id);
  }

  // Anthropic-compatible: { data: [{ type: "model", id: "claude-...", display_name: "..." }] }
  const anthropicData = (data as any).data as any[] | undefined;
  if (Array.isArray(anthropicData)) {
    return anthropicData.map((m) => ({
      id: String(m.id || ""),
      name: String(m.display_name || m.id || ""),
    })).filter((m) => m.id);
  }

  // Fallback: try top-level array
  if (Array.isArray(data)) {
    return data.map((m) => ({
      id: String(m.id || m.model || ""),
      name: String(m.id || m.model || m.display_name || ""),
    })).filter((m) => m.id);
  }

  return [];
}

// ========================================================================
// List all providers
// ========================================================================

admin.get("/", async (c) => {
  const kv = c.env.KV;
  const configs = await getAllProviderConfigs(kv);

  // Also include hardcoded providers
  const hardcoded = registry.list().map((r) => ({
    providerId: r.id,
    displayName: r.name,
    protocol: r.id === "anthropic" ? "anthropic-compatible" : "custom",
    source: "builtin",
    capabilities: r.capabilities,
  }));

  const dynamic = configs.map((cfg) => ({
    providerId: cfg.providerId,
    displayName: cfg.displayName,
    protocol: cfg.protocol,
    source: "dynamic",
    baseUrl: cfg.baseUrl,
    authType: cfg.authType,
    models: cfg.models.length,
    autoFetchModels: cfg.autoFetchModels,
    createdAt: cfg.createdAt,
  }));

  return c.json({ providers: [...hardcoded, ...dynamic] });
});

// ========================================================================
// Get single provider config
// ========================================================================

admin.get("/:providerId", async (c) => {
  const kv = c.env.KV;
  const providerId = c.req.param("providerId");
  const configs = await getAllProviderConfigs(kv);
  const cfg = findConfig(configs, providerId);

  if (!cfg) {
    return c.json({ error: { message: `Provider "${providerId}" not found`, type: "not_found" } }, 404);
  }

  return c.json({ config: cfg });
});

// ========================================================================
// Register / Update provider
// ========================================================================

admin.post("/", async (c) => {
  const kv = c.env.KV;
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));

  const config = parseProviderConfig(body);
  if (!config) {
    return c.json({ error: { message: "Invalid provider config", type: "invalid_request" } }, 400);
  }

  if (!config.providerId || !config.baseUrl) {
    return c.json({ error: { message: "providerId and baseUrl are required", type: "invalid_request" } }, 400);
  }

  const configs = await getAllProviderConfigs(kv);
  const existingIndex = configs.findIndex((c) => c.providerId === config.providerId);

  if (existingIndex >= 0) {
    configs[existingIndex] = config;
  } else {
    configs.push(config);
  }

  await saveProviderConfigs(kv, configs);

  return c.json({
    success: true,
    providerId: config.providerId,
    action: existingIndex >= 0 ? "updated" : "created",
  });
});

// ========================================================================
// Discover models (works before provider is saved)
// ========================================================================

admin.post("/discover", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  const baseUrl = String(body.baseUrl || "");
  const protocol = String(body.protocol || "openai-compatible");
  const authType = String(body.authType || "bearer");
  const apiKey = String(body.apiKey || "");

  if (!baseUrl) {
    return c.json({ error: { message: "baseUrl is required", type: "invalid_request" } }, 400);
  }
  if (!apiKey) {
    return c.json({ error: { message: "apiKey is required", type: "invalid_request" } }, 400);
  }

  try {
    const models = await discoverModels(baseUrl, protocol, authType, apiKey);
    return c.json({ models, count: models.length });
  } catch (err) {
    return c.json({ error: { message: String(err), type: "provider_error" } }, 502);
  }
});

// ========================================================================
// Test provider connectivity (by saved provider ID)
// ========================================================================

admin.post("/:providerId/test", async (c) => {
  const kv = c.env.KV;
  const providerId = c.req.param("providerId");
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  const apiKey = String(body.apiKey || "");

  const configs = await getAllProviderConfigs(kv);
  const cfg = findConfig(configs, providerId);

  if (!cfg) {
    return c.json({ error: { message: `Provider "${providerId}" not found`, type: "not_found" } }, 404);
  }

  if (!apiKey) {
    return c.json({ error: { message: "apiKey is required for testing", type: "invalid_request" } }, 400);
  }

  const result: ProviderValidation = { ok: false };
  const startTime = Date.now();

  try {
    const endpoint = buildEndpoint(cfg);
    const headers = buildAuthHeaders(cfg, apiKey);

    const testBody: Record<string, unknown> = {
      model: cfg.models[0]?.id || "default",
      max_tokens: 50,
    };

    if (cfg.protocol === "anthropic-compatible") {
      testBody.messages = [{ role: "user", content: "Say hi" }];
      testBody.max_tokens = 50;
    } else {
      testBody.messages = [{ role: "user", content: "Say hi" }];
    }

    const resp = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(testBody),
    });

    result.latencyMs = Date.now() - startTime;

    if (!resp.ok) {
      const errBody = await resp.json().catch(() => ({}));
      result.error = `HTTP ${resp.status}: ${JSON.stringify(errBody).slice(0, 200)}`;
      return c.json({ connected: false, result }, 200);
    }

    result.ok = true;
    return c.json({ connected: true, latency: result.latencyMs, result }, 200);
  } catch (err) {
    result.latencyMs = Date.now() - startTime;
    result.error = `Network error: ${(err as Error).message}`;
    return c.json({ connected: false, result }, 200);
  }
});

// ========================================================================
// Test provider connectivity (by raw config, not saved)
// ========================================================================

admin.post("/test", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  const apiKey = String(body.apiKey || "");
  const config = parseProviderConfig(body.config || body);

  if (!config) {
    return c.json({ error: { message: "Invalid provider config", type: "invalid_request" } }, 400);
  }
  if (!apiKey) {
    return c.json({ error: { message: "apiKey is required for testing", type: "invalid_request" } }, 400);
  }

  const result: ProviderValidation = { ok: false };
  const startTime = Date.now();

  try {
    const endpoint = buildEndpoint(config);
    const headers = buildAuthHeaders(config, apiKey);

    const testBody: Record<string, unknown> = {
      model: config.models[0]?.id || "default",
      max_tokens: 50,
    };

    if (config.protocol === "anthropic-compatible") {
      testBody.messages = [{ role: "user", content: "Say hi" }];
      testBody.max_tokens = 50;
    } else {
      testBody.messages = [{ role: "user", content: "Say hi" }];
    }

    const resp = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(testBody),
    });

    result.latencyMs = Date.now() - startTime;

    if (!resp.ok) {
      const errBody = await resp.json().catch(() => ({}));
      result.error = `HTTP ${resp.status}: ${JSON.stringify(errBody).slice(0, 200)}`;
      return c.json({ result }, 200);
    }

    const respBody = await resp.json() as Record<string, unknown>;

    // Check if content was returned
    const choices = respBody.choices as any[] | undefined;
    const content = choices?.[0]?.message?.content;
    if (content === undefined || content === null) {
      const anthropicContent = (respBody as any).content;
      if (!anthropicContent) {
        result.error = "Response received but no content field found";
        return c.json({ result }, 200);
      }
    }

    result.ok = true;

    // Auto-fetch models if enabled
    if (config.autoFetchModels) {
      try {
        const models = await discoverModels(config.baseUrl, config.protocol, config.authType, apiKey);
        result.models = models;
      } catch {
        // Silently ignore model fetch failure
      }
    }

    return c.json({ result, response: respBody });
  } catch (err) {
    result.latencyMs = Date.now() - startTime;
    result.error = `Network error: ${(err as Error).message}`;
    return c.json({ result }, 200);
  }
});

// ========================================================================
// Delete provider
// ========================================================================

admin.delete("/:providerId", async (c) => {
  const kv = c.env.KV;
  const providerId = c.req.param("providerId");

  const configs = await getAllProviderConfigs(kv);
  const filtered = configs.filter((c) => c.providerId !== providerId);

  if (filtered.length === configs.length) {
    return c.json({ error: { message: `Provider "${providerId}" not found`, type: "not_found" } }, 404);
  }

  await saveProviderConfigs(kv, filtered);
  return c.json({ success: true, deleted: providerId });
});

// ========================================================================
// Fetch models from provider (for saved providers)
// ========================================================================

admin.post("/:providerId/fetch-models", async (c) => {
  const kv = c.env.KV;
  const providerId = c.req.param("providerId");
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  const apiKey = String(body.apiKey || "");

  const configs = await getAllProviderConfigs(kv);
  const cfg = findConfig(configs, providerId);

  if (!cfg) {
    return c.json({ error: { message: `Provider "${providerId}" not found`, type: "not_found" } }, 404);
  }

  if (!apiKey) {
    return c.json({ error: { message: "apiKey required", type: "invalid_request" } }, 400);
  }

  try {
    const models = await discoverModels(cfg.baseUrl, cfg.protocol, cfg.authType, apiKey);

    // Update config with fetched models
    cfg.models = models;
    const idx = configs.findIndex((c) => c.providerId === providerId);
    if (idx >= 0) configs[idx] = cfg;
    await saveProviderConfigs(kv, configs);

    return c.json({ models, saved: true });
  } catch (err) {
    return c.json({ error: { message: String(err), type: "network_error" } }, 502);
  }
});

export default admin;
