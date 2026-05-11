/**
 * Provider Plugin Types
 *
 * Provider-facing API format plugins.
 * Each plugin handles one provider API format (OpenAI, Anthropic, Gemini, etc.)
 *
 * Architecture:
 *   IR -> buildRequest() -> Provider Request Body
 *   Provider Response -> parseResponse() -> IR
 *   Provider Stream Chunk -> parseStreamChunk() -> StreamEvent
 *
 * Symmetric to ConsumerPlugin in src/consumers/types.ts
 */

import type { IRRequest, IRResponse, StreamEvent } from "../core/ir";

export interface ProviderCapabilities {
  streaming: boolean;
  tools: boolean;
  vision: boolean;
  systemMessages: boolean;
  reasoning: boolean;
  jsonMode: boolean;
  maxContextLength: number;
}

export interface ProviderPlugin {
  /** Plugin identifier */
  readonly id: string;

  /** Human-readable name */
  readonly name: string;

  /** Default endpoint template with {{model}} placeholder */
  readonly endpointTemplate: string;

  /** Default auth type */
  readonly authType: "bearer" | "api-key" | "x-api-key";

  /** Default capabilities */
  readonly capabilities: ProviderCapabilities;

  /**
   * Build provider request body from IR.
   */
  buildRequest(ir: IRRequest): Record<string, unknown>;

  /**
   * Parse provider response into IR.
   */
  parseResponse(raw: unknown): IRResponse;

  /**
   * Parse a provider stream chunk into StreamEvent.
   * Returns null if this chunk should be skipped.
   */
  parseStreamChunk(chunk: unknown): StreamEvent | null;

  /**
   * Check if a stream chunk is an end-of-stream marker.
   */
  isStreamEndMarker(chunk: unknown): boolean;

  /**
   * Parse provider error response.
   */
  parseError(raw: unknown): { message: string; type: string; code?: string };

  /**
   * Build auth headers for this provider.
   */
  buildHeaders(apiKey: string, extraHeaders?: Record<string, string>): Record<string, string>;

  /**
   * Build full endpoint URL.
   */
  buildEndpoint(baseUrl?: string, model?: string): string;
}

/**
 * Provider registry.
 */
export class ProviderRegistry {
  private plugins: ProviderPlugin[] = [];

  register(plugin: ProviderPlugin): void {
    this.plugins.push(plugin);
  }

  /** Find plugin by exact ID match */
  find(id: string): ProviderPlugin | undefined {
    for (const p of this.plugins) {
      if (p.id === id) return p;
    }
    return undefined;
  }

  /** List all registered providers */
  list(): { id: string; name: string; capabilities: ProviderCapabilities }[] {
    return this.plugins.map((p) => ({
      id: p.id,
      name: p.name,
      capabilities: p.capabilities,
    }));
  }
}

export const providerRegistry = new ProviderRegistry();
