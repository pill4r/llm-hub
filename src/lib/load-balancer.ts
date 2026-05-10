/**
 * Load Balancer
 *
 * Manages multiple API keys per provider with round-robin selection
 * and health tracking.
 */

export interface KeySlot {
  apiKey: string;
  baseUrl?: string;
  weight?: number;
  healthy: boolean;
  lastFailure?: number;
  failureCount: number;
}

export class LoadBalancer {
  private slots: KeySlot[];
  private index = 0;

  constructor(slots: KeySlot[]) {
    this.slots = slots.map((s) => ({ ...s, healthy: s.healthy ?? true, failureCount: s.failureCount ?? 0 }));
  }

  /**
   * Select next healthy key using round-robin.
   */
  next(): KeySlot | undefined {
    const healthy = this.slots.filter((s) => s.healthy);
    if (healthy.length === 0) return undefined;

    this.index = (this.index + 1) % healthy.length;
    return healthy[this.index];
  }

  /**
   * Mark a key as failed.
   */
  markFailure(apiKey: string): void {
    const slot = this.slots.find((s) => s.apiKey === apiKey);
    if (slot) {
      slot.failureCount++;
      slot.lastFailure = Date.now();
      if (slot.failureCount >= 3) {
        slot.healthy = false;
      }
    }
  }

  /**
   * Mark a key as healthy (after successful request).
   */
  markSuccess(apiKey: string): void {
    const slot = this.slots.find((s) => s.apiKey === apiKey);
    if (slot) {
      slot.failureCount = 0;
      slot.healthy = true;
    }
  }

  /**
   * Get all slots.
   */
  getSlots(): KeySlot[] {
    return this.slots;
  }
}

/**
 * Parse provider keys from KV record.
 * Supports both single key and array of keys (for load balancing).
 */
export function parseProviderKeys(
  record: Record<string, unknown>
): { apiKey: string; baseUrl?: string } | LoadBalancer | undefined {
  // Array of keys = load balancer
  if (Array.isArray(record.keys)) {
    const slots = (record.keys as Record<string, unknown>[]).map((k) => ({
      apiKey: String(k.apiKey || k.key || ""),
      baseUrl: k.baseUrl as string | undefined,
      weight: Number(k.weight || 1),
      healthy: true,
      failureCount: 0,
    }));
    return new LoadBalancer(slots);
  }

  // Single key
  const apiKey = String(record.apiKey || record.key || "");
  if (!apiKey) return undefined;

  return {
    apiKey,
    baseUrl: record.baseUrl as string | undefined,
  };
}
