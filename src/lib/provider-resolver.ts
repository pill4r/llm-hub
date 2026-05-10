/**
 * Provider Resolver
 *
 * Resolves providerId to converter + config, supporting both built-in and dynamic providers.
 */

import { registry, type BaseConverter } from "../core/converter";
import { OpenAIConverter } from "../providers/openai/converter";
import { AnthropicConverter } from "../providers/anthropic/converter";
import {
  parseProviderConfig,
  getDefaultCapabilities,
  buildEndpoint,
  buildAuthHeaders,
  type ProviderConfig,
} from "./provider-config";

export interface ResolvedProvider {
  converter: BaseConverter;
  providerId: string;
  /** Provider API key */
  apiKey: string;
  /** Resolved model name */
  model: string;
  /** Provider base URL (for dynamic providers) */
  baseUrl?: string;
  /** Full provider config (for dynamic providers) */
  config?: ProviderConfig;
}

export interface ResolveError {
  ok: false;
  error: { message: string; type: string; code?: string };
  status: number;
}

export type ResolveResult = { ok: true } & ResolvedProvider | ResolveError;

/**
 * Resolve a provider by ID, falling back to dynamic config from KV.
 */
export async function resolveProviderById(
  providerId: string,
  kv: KVNamespace
): Promise<ResolveResult> {
  // 1. Try built-in registry
  const BuiltInClass = registry.get(providerId);
  if (BuiltInClass) {
    return {
      ok: true,
      converter: new BuiltInClass(),
      providerId,
      apiKey: "", // Will be filled by caller
      model: "",
    };
  }

  // 2. Try dynamic config from KV
  const dynamic = await resolveDynamicProvider(providerId, kv);
  if (dynamic) return dynamic;

  // 3. Not found
  return {
    ok: false,
    error: {
      message: `Unknown provider "${providerId}". Register it at /admin/providers`,
      type: "invalid_request_error",
      code: "unknown_provider",
    },
    status: 400,
  };
}

/**
 * Resolve dynamic provider from KV config.
 */
async function resolveDynamicProvider(
  providerId: string,
  kv: KVNamespace
): Promise<ResolveResult | null> {
  const raw = await kv.get("provider:config");
  if (!raw) return null;

  try {
    const arr = JSON.parse(raw) as unknown[];
    const configs = arr.map(parseProviderConfig).filter(Boolean) as ProviderConfig[];
    const cfg = configs.find((c) => c.providerId === providerId);
    if (!cfg) return null;

    const converter = createConverterFromConfig(cfg);
    return {
      ok: true,
      converter,
      providerId,
      apiKey: "", // Filled by caller
      model: "",
      baseUrl: cfg.baseUrl,
      config: cfg,
    };
  } catch {
    return null;
  }
}

/**
 * Create converter from provider config based on protocol.
 */
function createConverterFromConfig(cfg: ProviderConfig): BaseConverter {
  switch (cfg.protocol) {
    case "openai-compatible": {
      return new OpenAIConverter({
        providerId: cfg.providerId,
        providerName: cfg.providerId,
        baseUrl: cfg.baseUrl,
        chatEndpoint: cfg.chatEndpoint,
        authType: cfg.authType,
        capabilities: { ...getDefaultCapabilities("openai-compatible"), ...cfg.capabilities },
        models: cfg.models.map((id) => ({ id, name: id })),
        extraHeaders: cfg.extraHeaders,
      });
    }
    case "anthropic-compatible": {
      return new AnthropicConverter({
        providerId: cfg.providerId,
        providerName: cfg.providerId,
        baseUrl: cfg.baseUrl,
        apiVersion: cfg.chatEndpoint,
        capabilities: { ...getDefaultCapabilities("anthropic-compatible"), ...cfg.capabilities },
      });
    }
    case "custom":
      throw new Error("custom protocol requires built-in converter registration");
    default:
      throw new Error(`Unknown protocol: ${cfg.protocol}`);
  }
}

/**
 * Get API key for a provider from KV.
 */
export async function getProviderApiKey(
  providerId: string,
  keyId: string,
  kv: KVNamespace
): Promise<{ apiKey: string; baseUrl?: string } | null> {
  const raw = await kv.get(`key:${keyId}:providers`);
  if (!raw) return null;

  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    const providerData = data[providerId] as Record<string, unknown> | undefined;
    if (!providerData) return null;

    return {
      apiKey: String(providerData.apiKey || ""),
      baseUrl: providerData.baseUrl ? String(providerData.baseUrl) : undefined,
    };
  } catch {
    return null;
  }
}
