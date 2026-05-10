/**
 * Consumer Plugin Types
 *
 * Consumer-facing API format plugins.
 * Each plugin handles one client SDK format (OpenAI, Anthropic, Codex, Gemini, etc.)
 *
 * Architecture:
 *   Consumer Request → parseRequest() → IR → Provider Converter → Provider API
 *   Provider Response → IR → buildResponse() / buildStreamChunk() → Consumer Response
 */

import type { IRRequest, IRResponse, StreamEvent } from "../core/ir";

export interface StreamOptions {
  model: string;
  id: string;
  index?: number;
}

export interface ConsumerPlugin {
  /** Plugin identifier */
  readonly id: string;

  /** Human-readable name */
  readonly name: string;

  /** API endpoint paths this consumer handles */
  readonly paths: string[];

  /**
   * Detect if this plugin should handle the request.
   * Called in order of registration; first match wins.
   */
  detect(path: string, headers: Headers, body: Record<string, unknown>): boolean;

  /**
   * Parse consumer request body into IR.
   */
  parseRequest(body: Record<string, unknown>): IRRequest;

  /**
   * Build consumer response from IR (non-streaming).
   */
  buildResponse(ir: IRResponse): Record<string, unknown>;

  /**
   * Build a stream chunk from IR event.
   * Returns null if this event should be skipped for this consumer format.
   */
  buildStreamChunk(event: StreamEvent, options: StreamOptions): string | null;

  /**
   * Build error response in consumer format.
   */
  buildError(error: { message: string; type: string; code?: string }): Record<string, unknown>;

  /**
   * Extract model name from request body.
   */
  getModel(body: Record<string, unknown>): string;

  /**
   * Check if request wants streaming.
   */
  isStreaming(body: Record<string, unknown>): boolean;
}

/**
 * Consumer registry.
 */
export class ConsumerRegistry {
  private plugins: ConsumerPlugin[] = [];

  register(plugin: ConsumerPlugin): void {
    this.plugins.push(plugin);
  }

  /**
   * Find plugin by path match.
   */
  find(path: string, headers: Headers, body: Record<string, unknown>): ConsumerPlugin | undefined {
    return this.plugins.find((p) => p.detect(path, headers, body));
  }

  /**
   * List all registered consumers.
   */
  list(): { id: string; name: string; paths: string[] }[] {
    return this.plugins.map((p) => ({ id: p.id, name: p.name, paths: p.paths }));
  }
}

export const consumerRegistry = new ConsumerRegistry();
