/**
 * Billing Middleware
 *
 * Tracks usage and costs per API key.
 * Stores aggregated usage in D1 (SQL) for analytics.
 * Updates spend in KV for real-time budget checks.
 * Falls back to KV-only if D1 is not configured.
 */

import type { Context, Next } from "hono";
import type { KeyRecord } from "./auth";
import type { IRResponse } from "../core/ir";

export interface ModelPricing {
  /** Input price per 1M tokens (USD) */
  inputPrice: number;
  /** Output price per 1M tokens (USD) */
  outputPrice: number;
  /** Per-request fee (USD) */
  requestFee?: number;
}

/**
 * Get pricing for a model.
 * Falls back to generic pricing if model-specific not found.
 */
export async function getModelPricing(
  kv: KVNamespace,
  providerId: string,
  model: string
): Promise<ModelPricing> {
  const pricingJson = await kv.get(`pricing:${providerId}:${model}`);
  if (pricingJson) {
    return JSON.parse(pricingJson) as ModelPricing;
  }

  // Default pricing
  return {
    inputPrice: 0.5,   // $0.50 / 1M tokens
    outputPrice: 1.5,  // $1.50 / 1M tokens
    requestFee: 0,
  };
}

/**
 * Calculate cost from usage.
 */
export function calculateCost(usage: { promptTokens: number; completionTokens: number }, pricing: ModelPricing): number {
  const inputCost = (usage.promptTokens / 1_000_000) * pricing.inputPrice;
  const outputCost = (usage.completionTokens / 1_000_000) * pricing.outputPrice;
  const requestCost = pricing.requestFee || 0;
  return inputCost + outputCost + requestCost;
}

/**
 * Update spend in KV for real-time budget enforcement.
 */
export async function updateSpend(
  kv: KVNamespace,
  keyId: string,
  cost: number
): Promise<void> {
  const now = new Date();
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const spendKey = `key:${keyId}:spend:${monthKey}`;

  const current = await kv.get(spendKey);
  const newSpend = (current ? Number(current) : 0) + cost;
  await kv.put(spendKey, String(newSpend), { expirationTtl: 31 * 86400 });
}

/**
 * Billing middleware - records usage after response.
 */
export function billingMiddleware() {
  return async (c: Context, next: Next) => {
    await next();

    const keyRecord = c.get("keyRecord") as KeyRecord | undefined;
    const usage = c.get("usage") as { promptTokens: number; completionTokens: number; totalTokens: number } | undefined;
    const providerId = c.get("providerId") as string | undefined;
    const model = c.get("model") as string | undefined;

    if (!keyRecord || !usage || !providerId || !model) return;

    try {
      const kv = c.env.KV as KVNamespace;

      const pricing = await getModelPricing(kv, providerId, model);
      const cost = calculateCost(usage, pricing);

      // Record in D1 if available
      const db = c.env.DB as D1Database | undefined;
      if (db) {
        await recordUsageInD1(db, keyRecord.keyId, providerId, model, usage, cost, c.res.status);
      }

      // Always update KV spend
      await updateSpend(kv, keyRecord.keyId, cost);
    } catch {
      // Billing errors should not fail the request
    }
  };
}

/**
 * Record usage in D1 database (optional).
 */
async function recordUsageInD1(
  db: D1Database,
  keyId: string,
  providerId: string,
  model: string,
  usage: { promptTokens: number; completionTokens: number; totalTokens: number },
  cost: number,
  status: number
): Promise<void> {
  try {
    const now = new Date();
    const date = now.toISOString().split("T")[0]; // YYYY-MM-DD

    await db.prepare(
      `INSERT INTO usage_logs (key_id, provider_id, model, date, prompt_tokens, completion_tokens, total_tokens, cost, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      keyId, providerId, model, date,
      usage.promptTokens, usage.completionTokens, usage.totalTokens,
      cost, status, now.toISOString()
    ).run();

    await db.prepare(
      `INSERT INTO usage_daily (key_id, date, requests, prompt_tokens, completion_tokens, total_tokens, cost)
       VALUES (?, ?, 1, ?, ?, ?, ?)
       ON CONFLICT(key_id, date) DO UPDATE SET
         requests = requests + 1,
         prompt_tokens = prompt_tokens + excluded.prompt_tokens,
         completion_tokens = completion_tokens + excluded.completion_tokens,
         total_tokens = total_tokens + excluded.total_tokens,
         cost = cost + excluded.cost`
    ).bind(
      keyId, date,
      usage.promptTokens, usage.completionTokens, usage.totalTokens, cost
    ).run();
  } catch {
    // D1 errors should not fail the request
  }
}
