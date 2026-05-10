/**
 * Rate Limiting Middleware
 *
 * Implements sliding window rate limiting:
 * - RPM: Requests per minute
 * - TPM: Tokens per minute
 *
 * Uses KV for distributed rate limit state.
 */

import type { Context, Next } from "hono";
import type { KeyRecord } from "./auth";

export interface RateLimitState {
  /** Requests in current window */
  requests: number;
  /** Tokens in current window */
  tokens: number;
  /** Window start timestamp (ms) */
  windowStart: number;
}

const WINDOW_MS = 60_000; // 1 minute sliding window

/**
 * Check and update rate limit.
 * @returns null if allowed, otherwise error info
 */
export async function checkRateLimit(
  kv: KVNamespace,
  keyId: string,
  rpm: number,
  tpm: number,
  requestTokens: number
): Promise<{ allowed: true } | { allowed: false; retryAfter: number; limit: string }> {
  const now = Date.now();
  const windowKey = Math.floor(now / WINDOW_MS);
  const kvKey = `ratelimit:${keyId}:${windowKey}`;

  // Get current window state
  const stateJson = await kv.get(kvKey);
  const state: RateLimitState = stateJson
    ? JSON.parse(stateJson)
    : { requests: 0, tokens: 0, windowStart: windowKey * WINDOW_MS };

  // Check limits
  if (rpm > 0 && state.requests >= rpm) {
    const retryAfter = Math.ceil((state.windowStart + WINDOW_MS - now) / 1000);
    return { allowed: false, retryAfter: Math.max(1, retryAfter), limit: "rpm" };
  }

  if (tpm > 0 && state.tokens + requestTokens > tpm) {
    const retryAfter = Math.ceil((state.windowStart + WINDOW_MS - now) / 1000);
    return { allowed: false, retryAfter: Math.max(1, retryAfter), limit: "tpm" };
  }

  // Update state
  state.requests += 1;
  state.tokens += requestTokens;

  // Store with TTL (2 minutes to cover window overlap)
  await kv.put(kvKey, JSON.stringify(state), { expirationTtl: 120 });

  return { allowed: true };
}

/**
 * Hono middleware for rate limiting.
 * Estimates token count from request body for pre-flight check.
 */
export function rateLimitMiddleware() {
  return async (c: Context, next: Next) => {
    const keyRecord = c.get("keyRecord") as KeyRecord | undefined;
    if (!keyRecord) {
      // No auth middleware before this
      return c.json(
        { error: { message: "Rate limiter requires auth", type: "internal_error", code: "middleware_order" } },
        500
      );
    }

    const kv = c.env.KV as KVNamespace;

    // Estimate tokens from request body (rough approximation)
    let estimatedTokens = 0;
    try {
      const body = await c.req.json();
      const messages = body.messages || [];
      for (const msg of messages) {
        const text = typeof msg.content === "string"
          ? msg.content
          : JSON.stringify(msg.content);
        estimatedTokens += Math.ceil(text.length / 4);
      }
    } catch {
      estimatedTokens = 1000; // Default estimate
    }

    const result = await checkRateLimit(kv, keyRecord.keyId, keyRecord.rpm, keyRecord.tpm, estimatedTokens);

    if (!result.allowed) {
      c.header("Retry-After", String(result.retryAfter));
      return c.json(
        {
          error: {
            message: `Rate limit exceeded (${result.limit}). Retry after ${result.retryAfter}s.`,
            type: "rate_limit_error",
            code: `rate_limit_${result.limit}`,
          },
        },
        429
      );
    }

    await next();
  };
}
