/**
 * Provider Configuration System
 *
 * Dynamic provider registration via KV. No code changes needed to add providers.
 */

import type { ConverterCapabilities, ConverterOptions } from "../core/converter";

/** Supported protocol types */
export type ProviderProtocol = "openai-compatible" | "anthropic-compatible" | "custom";

/** Provider configuration stored in KV */
export interface ProviderConfig {
  providerId: string;
  displayName: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  authType: "bearer" | "api-key" | "x-api-key";
  /** Optional: endpoint path suffix (default /chat/completions) */
  chatEndpoint?: string;
  /** Whether to automatically fetch model list from /models */
  autoFetchModels: boolean;
  /** Manually specified models (used when autoFetchModels=false or fetch fails) */
  models: { id: string; name: string }[];
  /** Provider capabilities override (defaults from protocol) */
  capabilities?: Partial<ConverterCapabilities>;
  /** Extra headers to send with every request */
  extraHeaders?: Record<string, string>;
  /** When this config was created */
  createdAt: string;
}

/** Validation result */
export interface ProviderValidation {
  ok: boolean;
  error?: string;
  models?: { id: string; name: string }[];
  latencyMs?: number;
}

/** Test payload for provider validation */
export const TEST_PAYLOAD = {
  messages: [{ role: "user" as const, content: "Say hi" }],
  max_tokens: 50,
};

/**
 * Default capabilities per protocol
 */
export function getDefaultCapabilities(protocol: ProviderProtocol): ConverterCapabilities {
  switch (protocol) {
    case "openai-compatible":
      return {
        streaming: true,
        tools: true,
        vision: true,
        systemMessages: true,
        reasoning: false,
        jsonMode: true,
        maxContextLength: 128_000,
      };
    case "anthropic-compatible":
      return {
        streaming: true,
        tools: true,
        vision: true,
        systemMessages: true,
        reasoning: true,
        jsonMode: true,
        maxContextLength: 200_000,
      };
    case "custom":
      return {
        streaming: false,
        tools: false,
        vision: false,
        systemMessages: true,
        reasoning: false,
        jsonMode: false,
      };
  }
}

/**
 * Build chat completions endpoint from config
 */
export function buildEndpoint(config: ProviderConfig): string {
  const suffix = config.chatEndpoint || "/chat/completions";
  // Remove trailing slash from baseUrl
  const base = config.baseUrl.replace(/\/$/, "");
  return `${base}${suffix}`;
}

/**
 * Build auth headers from config
 */
export function buildAuthHeaders(config: ProviderConfig, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  switch (config.authType) {
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

  if (config.extraHeaders) {
    Object.assign(headers, config.extraHeaders);
  }

  return headers;
}

/**
 * Parse provider config from KV value with validation
 */
export function parseProviderConfig(raw: unknown): ProviderConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  const protocol = r.protocol as ProviderProtocol;
  if (!["openai-compatible", "anthropic-compatible", "custom"].includes(protocol)) {
    return null;
  }

  return {
    providerId: String(r.providerId || ""),
    displayName: String(r.displayName || r.providerId || ""),
    protocol,
    baseUrl: String(r.baseUrl || ""),
    authType: (r.authType as "bearer" | "api-key" | "x-api-key") || "bearer",
    chatEndpoint: r.chatEndpoint ? String(r.chatEndpoint) : undefined,
    autoFetchModels: Boolean(r.autoFetchModels ?? true),
    models: Array.isArray(r.models) ? r.models.map((m: any) => ({
      id: String(m.id),
      name: String(m.name || m.id),
    })) : [],
    capabilities: r.capabilities as Partial<ConverterCapabilities> | undefined,
    extraHeaders: r.extraHeaders as Record<string, string> | undefined,
    createdAt: String(r.createdAt || new Date().toISOString()),
  };
}

/**
 * Fetch all provider configs from KV.
 */
export async function getAllProviderConfigs(kv: KVNamespace): Promise<ProviderConfig[]> {
  const raw = await kv.get("provider:config");
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as unknown[];
    return arr.map(parseProviderConfig).filter(Boolean) as ProviderConfig[];
  } catch {
    return [];
  }
}

/**
 * Save provider configs to KV.
 */
export async function saveProviderConfigs(kv: KVNamespace, configs: ProviderConfig[]): Promise<void> {
  await kv.put("provider:config", JSON.stringify(configs));
}
