/**
 * Admin API Key Management
 *
 * Create / list / delete hub API keys and their provider mappings.
 */

import { Hono } from "hono";
import type { KeyRecord, ProviderKeyRecord } from "../middleware/auth";
import { adminAuthMiddleware } from "../middleware/admin-auth";

const admin = new Hono<{ Bindings: { KV: KVNamespace; ADMIN_TOKEN: string } }>();

// Apply auth to all routes
admin.use("*", adminAuthMiddleware());

// ========================================================================
// Helpers
// ========================================================================

function generateKeyId(): string {
  return `key_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function generateToken(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = "hub_";
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

async function getKeyIndex(kv: KVNamespace): Promise<string[]> {
  const raw = await kv.get("keys:index");
  return raw ? JSON.parse(raw) : [];
}

async function setKeyIndex(kv: KVNamespace, ids: string[]) {
  await kv.put("keys:index", JSON.stringify(ids));
}

function sanitizeKeyRecord(record: KeyRecord): Omit<KeyRecord, "secret"> & { tokenPrefix: string } {
  const { secret, ...rest } = record;
  return {
    ...rest,
    tokenPrefix: secret.slice(0, 8) + "...",
  };
}

// ========================================================================
// List all keys
// ========================================================================

admin.get("/", async (c) => {
  const kv = c.env.KV;
  const ids = await getKeyIndex(kv);

  const keys: Record<string, ReturnType<typeof sanitizeKeyRecord>> = {};
  for (const id of ids) {
    const raw = await kv.get(`key:${id}`);
    if (!raw) continue;
    try {
      const record = JSON.parse(raw) as KeyRecord;
      keys[id] = sanitizeKeyRecord(record);
    } catch { /* skip */ }
  }

  return c.json({ keys });
});

// ========================================================================
// Create a new key
// ========================================================================

admin.post("/", async (c) => {
  const kv = c.env.KV;
  const body = await c.req.json<{
    name?: string;
    allowedProviders?: string[];
    allowedModels?: string[];
    rpm?: number;
    tpm?: number;
    monthlyBudget?: number;
    providerKeys?: Record<string, { apiKey: string; baseUrl?: string }>;
  }>();

  const keyId = generateKeyId();
  const token = generateToken();

  const record: KeyRecord = {
    keyId,
    secret: token,
    name: body.name || "Untitled Key",
    allowedProviders: body.allowedProviders || [],
    allowedModels: body.allowedModels || [],
    rpm: body.rpm ?? 60,
    tpm: body.tpm ?? 100_000,
    monthlyBudget: body.monthlyBudget ?? 0,
    currentSpend: 0,
    active: true,
    createdAt: new Date().toISOString(),
  };

  // Store key record
  await kv.put(`key:${keyId}`, JSON.stringify(record));
  await kv.put(`key:value:${token}`, keyId);

  // Store provider keys
  if (body.providerKeys && Object.keys(body.providerKeys).length > 0) {
    const pkList: ProviderKeyRecord[] = Object.entries(body.providerKeys).map(([providerId, cfg]) => ({
      providerId,
      apiKey: cfg.apiKey,
      baseUrl: cfg.baseUrl,
    }));
    await kv.put(`key:${keyId}:providers`, JSON.stringify(pkList));
  }

  // Update index
  const ids = await getKeyIndex(kv);
  ids.push(keyId);
  await setKeyIndex(kv, ids);

  return c.json({
    success: true,
    key: {
      keyId,
      name: record.name,
      token,
    },
  });
});

// ========================================================================
// Get single key (with provider configs)
// ========================================================================

admin.get("/:keyId", async (c) => {
  const kv = c.env.KV;
  const keyId = c.req.param("keyId");

  const raw = await kv.get(`key:${keyId}`);
  if (!raw) return c.json({ error: { message: "Key not found" } }, 404);

  const record = JSON.parse(raw) as KeyRecord;
  const pkRaw = await kv.get(`key:${keyId}:providers`);
  const providerKeys = pkRaw ? JSON.parse(pkRaw) : [];

  // Get spend for current month
  const now = new Date();
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const spendRaw = await kv.get(`key:${keyId}:spend:${monthKey}`);
  const currentSpend = spendRaw ? Number(spendRaw) : 0;

  return c.json({
    key: sanitizeKeyRecord(record),
    providerKeys,
    currentSpend,
    month: monthKey,
  });
});

// ========================================================================
// Update key (name, permissions, provider keys)
// ========================================================================

admin.put("/:keyId", async (c) => {
  const kv = c.env.KV;
  const keyId = c.req.param("keyId");
  const body = await c.req.json<Partial<{
    name: string;
    allowedProviders: string[];
    allowedModels: string[];
    rpm: number;
    tpm: number;
    monthlyBudget: number;
    active: boolean;
    providerKeys: Record<string, { apiKey: string; baseUrl?: string }>;
  }>>();

  const raw = await kv.get(`key:${keyId}`);
  if (!raw) return c.json({ error: { message: "Key not found" } }, 404);

  const record = JSON.parse(raw) as KeyRecord;

  if (body.name !== undefined) record.name = body.name;
  if (body.allowedProviders !== undefined) record.allowedProviders = body.allowedProviders;
  if (body.allowedModels !== undefined) record.allowedModels = body.allowedModels;
  if (body.rpm !== undefined) record.rpm = body.rpm;
  if (body.tpm !== undefined) record.tpm = body.tpm;
  if (body.monthlyBudget !== undefined) record.monthlyBudget = body.monthlyBudget;
  if (body.active !== undefined) record.active = body.active;

  await kv.put(`key:${keyId}`, JSON.stringify(record));

  if (body.providerKeys) {
    const pkList: ProviderKeyRecord[] = Object.entries(body.providerKeys).map(([providerId, cfg]) => ({
      providerId,
      apiKey: cfg.apiKey,
      baseUrl: cfg.baseUrl,
    }));
    await kv.put(`key:${keyId}:providers`, JSON.stringify(pkList));
  }

  return c.json({ success: true, key: sanitizeKeyRecord(record) });
});

// ========================================================================
// Delete a key
// ========================================================================

admin.delete("/:keyId", async (c) => {
  const kv = c.env.KV;
  const keyId = c.req.param("keyId");

  const raw = await kv.get(`key:${keyId}`);
  if (!raw) return c.json({ error: { message: "Key not found" } }, 404);

  const record = JSON.parse(raw) as KeyRecord;

  // Delete all related KV entries
  await kv.delete(`key:${keyId}`);
  await kv.delete(`key:value:${record.secret}`);
  await kv.delete(`key:${keyId}:providers`);

  // Delete spend records (last 12 months)
  const now = new Date();
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const mk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    await kv.delete(`key:${keyId}:spend:${mk}`);
  }

  // Update index
  const ids = await getKeyIndex(kv);
  const filtered = ids.filter((id) => id !== keyId);
  await setKeyIndex(kv, filtered);

  return c.json({ success: true, deleted: keyId });
});

export default admin;
