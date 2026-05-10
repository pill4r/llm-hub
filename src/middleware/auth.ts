/**
 * Authentication Middleware
 *
 * Validates API keys and resolves virtual key -> provider key mappings.
 */

import type { Context, Next } from "hono";

export interface KeyRecord {
  /** Hub API Key ID */
  keyId: string;
  /** Key secret hash (or the key itself in dev) */
  secret: string;
  /** Display name */
  name: string;
  /** Allowed providers (empty = all) */
  allowedProviders: string[];
  /** Allowed models (empty = all) */
  allowedModels: string[];
  /** Rate limit: requests per minute */
  rpm: number;
  /** Rate limit: tokens per minute */
  tpm: number;
  /** Monthly budget in USD */
  monthlyBudget: number;
  /** Current month spend */
  currentSpend: number;
  /** Is active */
  active: boolean;
  /** Created at */
  createdAt: string;
}

export interface ProviderKeyRecord {
  /** Provider ID (optional when used in context where provider is already known) */
  providerId?: string;
  /** Provider API Key (single key) */
  apiKey: string;
  /** Base URL override */
  baseUrl?: string;
  /** Multiple keys for load balancing */
  keys?: Array<{
    apiKey: string;
    baseUrl?: string;
    weight?: number;
  }>;
}

/**
 * Extract the API key from the Authorization header.
 */
export function extractApiKey(header?: string | null): string | null {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

/**
 * Validate the API key against KV storage.
 */
export async function validateKey(
  kv: KVNamespace,
  keyValue: string
): Promise<{ keyRecord: KeyRecord; providerKeys: Record<string, ProviderKeyRecord> } | null> {
  // Key format: hub_<random>
  // Look up by key value
  const keyId = await kv.get(`key:value:${keyValue}`);
  if (!keyId) return null;

  const keyJson = await kv.get(`key:${keyId}`);
  if (!keyJson) return null;

  const keyRecord = JSON.parse(keyJson) as KeyRecord;
  if (!keyRecord.active) return null;

  // Check budget
  const now = new Date();
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const spendKey = `key:${keyId}:spend:${monthKey}`;
  const spendJson = await kv.get(spendKey);
  const currentSpend = spendJson ? Number(spendJson) : 0;

  if (keyRecord.monthlyBudget > 0 && currentSpend >= keyRecord.monthlyBudget) {
    return null; // Budget exceeded
  }

  keyRecord.currentSpend = currentSpend;

  // Load provider keys
  const providerKeys: Record<string, ProviderKeyRecord> = {};
  const pkJson = await kv.get(`key:${keyId}:providers`);
  if (pkJson) {
    const pkList = JSON.parse(pkJson) as ProviderKeyRecord[];
    for (const pk of pkList) {
      const pid = pk.providerId || "unknown";
      providerKeys[pid] = pk;
    }
  }

  return { keyRecord, providerKeys };
}

/**
 * Dev mode fallback key record (used when KV is empty in local testing).
 */
const DEV_FALLBACK_KEY: KeyRecord = {
  keyId: "dev-key",
  secret: "hub_test_key_12345",
  name: "Dev Test Key",
  allowedProviders: [],
  allowedModels: [],
  rpm: 1000,
  tpm: 1000000,
  monthlyBudget: 100,
  currentSpend: 0,
  active: true,
  createdAt: new Date().toISOString(),
};

const DEV_FALLBACK_PROVIDERS: Record<string, ProviderKeyRecord> = {};

/**
 * Hono middleware for API key authentication.
 */
export function authMiddleware() {
  return async (c: Context, next: Next) => {
    const authHeader = c.req.header("Authorization");
    const apiKey = extractApiKey(authHeader);

    if (!apiKey) {
      return c.json(
        { error: { message: "Missing Authorization header", type: "auth_error", code: "missing_key" } },
        401
      );
    }

    const kv = c.env.KV as KVNamespace;
    let result = await validateKey(kv, apiKey);

    // Dev mode fallback: auto-create test key if KV is empty
    if (!result && c.env.ENVIRONMENT === "dev" && apiKey === "hub_test_key_12345") {
      // Try to load provider keys from env var
      if (!DEV_FALLBACK_PROVIDERS["opencodego"] && c.env.OPENCODE_GO_API_KEY) {
        DEV_FALLBACK_PROVIDERS["opencodego"] = {
          apiKey: c.env.OPENCODE_GO_API_KEY as string,
          baseUrl: "https://opencode.ai/zen/go/v1",
        };
      }
      result = {
        keyRecord: DEV_FALLBACK_KEY,
        providerKeys: DEV_FALLBACK_PROVIDERS,
      };
    }

    if (!result) {
      return c.json(
        { error: { message: "Invalid or expired API key", type: "auth_error", code: "invalid_key" } },
        401
      );
    }

    // Attach to context for downstream middleware
    c.set("keyRecord", result.keyRecord);
    c.set("providerKeys", result.providerKeys);

    await next();
  };
}
