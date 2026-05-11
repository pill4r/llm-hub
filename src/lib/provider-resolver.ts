/**
 * Provider Resolver
 *
 * Resolves providerId to ProviderInstanceConfig, supporting both built-in and dynamic providers.
 * Replaces the old converter-based resolution with pure configuration.
 */

import {
  getBuiltinFormat,
  listBuiltinFormats,
  type ProviderInstanceConfig,
} from "./provider-engine";
import {
  parseProviderConfig,
  getDefaultCapabilities,
  type ProviderConfig,
} from "./provider-config";

export interface ResolvedProvider {
  config: ProviderInstanceConfig;
  providerId: string;
  /** Provider API key */
  apiKey: string;
  /** Resolved model name */
  model: string;
  /** Provider base URL (for dynamic providers) */
  baseUrl?: string;
  /** Full provider config (for dynamic providers) */
  dynamicConfig?: ProviderConfig;
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
  // 1. Try built-in formats
  const builtinFormat = getBuiltinFormat(providerId);
  if (builtinFormat) {
    return {
      ok: true,
      config: {
        providerId,
        providerName: builtinFormat.name,
        format: providerId,
        models: [], // Will be populated by caller if needed
      },
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

    const instanceConfig = createInstanceConfigFromDynamic(cfg);
    return {
      ok: true,
      config: instanceConfig,
      providerId,
      apiKey: "", // Filled by caller
      model: "",
      baseUrl: cfg.baseUrl,
      dynamicConfig: cfg,
    };
  } catch {
    return null;
  }
}

/**
 * Create ProviderInstanceConfig from dynamic ProviderConfig.
 */
function createInstanceConfigFromDynamic(cfg: ProviderConfig): ProviderInstanceConfig {
  const format = cfg.protocol === "openai-compatible" ? "openai" :
                 cfg.protocol === "anthropic-compatible" ? "anthropic" :
                 cfg.protocol;

  return {
    providerId: cfg.providerId,
    providerName: cfg.providerId,
    format,
    baseUrl: cfg.baseUrl,
    endpoint: cfg.chatEndpoint,
    auth: cfg.authType ? { type: cfg.authType } : undefined,
    extraHeaders: cfg.extraHeaders,
    models: cfg.models,
    capabilities: cfg.capabilities,
    transforms: cfg.transforms,
  };
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

/**
 * List all available provider formats (for admin UI).
 */
export function listProviderFormats(): { id: string; name: string; capabilities: Record<string, boolean> }[] {
  return listBuiltinFormats().map((fmt) => ({
    id: fmt.id,
    name: fmt.name,
    capabilities: fmt.capabilities as Record<string, boolean>,
  }));
}
