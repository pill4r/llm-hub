/**
 * BaseConverter - Abstract base class for all LLM provider converters
 *
 * Hub-and-spoke architecture:
 * - Each provider implements a converter that translates to/from IR
 * - Adding a new provider only requires ONE converter (not N²)
 *
 * Subclass must implement:
 *   1. requestToProvider(irRequest) → provider-specific request
 *   2. responseFromProvider(providerResponse) → IR response
 *   3. streamEventFromProvider(providerChunk) → IR stream event (optional)
 */

import type {
  IRRequest,
  IRResponse,
  StreamEvent,
} from "./ir";

export interface ConverterOptions {
  /** Provider API base URL (override default) */
  baseUrl?: string;
  /** Provider API version */
  apiVersion?: string;
  /** Additional provider-specific options */
  [key: string]: unknown;
}

export interface ConverterCapabilities {
  /** Supports streaming responses */
  streaming: boolean;
  /** Supports function/tool calling */
  tools: boolean;
  /** Supports vision (image input) */
  vision: boolean;
  /** Supports system messages */
  systemMessages: boolean;
  /** Supports reasoning/thinking content */
  reasoning: boolean;
  /** Supports JSON mode / structured output */
  jsonMode: boolean;
  /** Max context length (tokens) */
  maxContextLength?: number;
}

export abstract class BaseConverter {
  /** Provider identifier (e.g., "openai", "anthropic") */
  abstract readonly providerId: string;

  /** Human-readable provider name */
  abstract readonly providerName: string;

  /** Provider capabilities */
  abstract readonly capabilities: ConverterCapabilities;

  /** Converter options */
  options: ConverterOptions;

  constructor(options: ConverterOptions = {}) {
    this.options = options;
  }

  // ========================================================================
  // Core conversion methods (must be implemented)
  // ========================================================================

  /**
   * Convert IR request to provider-specific request format.
   * @param irRequest - The unified IR request
   * @returns Provider-specific request body
   */
  abstract requestToProvider(irRequest: IRRequest): Record<string, unknown>;

  /**
   * Convert provider-specific response to IR format.
   * @param providerResponse - Raw response from provider
   * @returns Unified IR response
   */
  abstract responseFromProvider(providerResponse: unknown): IRResponse;

  // ========================================================================
  // Streaming (optional, but recommended)
  // ========================================================================

  /**
   * Convert a provider stream chunk to an IR stream event.
   * @param chunk - Raw chunk from provider's SSE stream
   * @returns IR stream event, or null if this chunk should be skipped
   */
  streamEventFromProvider(chunk: unknown): StreamEvent | null {
    // Default: no streaming support
    return null;
  }

  /**
   * Check if the stream chunk is the final chunk.
   * @param chunk - Raw chunk from provider
   */
  isStreamEnd(chunk: unknown): boolean {
    return false;
  }

  // ========================================================================
  // Error handling
  // ========================================================================

  /**
   * Convert provider error response to a standardized error.
   * @param errorResponse - Raw error from provider
   * @returns Standardized error info
   */
  abstract parseError(errorResponse: unknown): {
    message: string;
    type: string;
    code?: string;
    status?: number;
  };

  // ========================================================================
  // Helpers
  // ========================================================================

  /**
   * Get the provider's API endpoint for chat completions.
   */
  abstract getChatCompletionEndpoint(model?: string): string;

  /**
   * Get headers to send with the request (e.g., Authorization).
   * @param apiKey - The provider API key
   */
  abstract getHeaders(apiKey: string): Record<string, string>;

  /**
   * Get list of supported models for this provider.
   */
  getSupportedModels(): { id: string; name: string }[] {
    return [];
  }
}

/**
 * Registry of all available converters.
 */
export class ConverterRegistry {
  private converters = new Map<string, new (opts?: ConverterOptions) => BaseConverter>();

  register(
    providerId: string,
    ConverterClass: new (opts?: ConverterOptions) => BaseConverter
  ): void {
    this.converters.set(providerId, ConverterClass);
  }

  get(providerId: string): (new (opts?: ConverterOptions) => BaseConverter) | undefined {
    return this.converters.get(providerId);
  }

  has(providerId: string): boolean {
    return this.converters.has(providerId);
  }

  list(): { id: string; name: string; capabilities: ConverterCapabilities }[] {
    return Array.from(this.converters.entries()).map(([id, Class]) => {
      const instance = new Class();
      return {
        id,
        name: instance.providerName,
        capabilities: instance.capabilities,
      };
    });
  }
}

export const registry = new ConverterRegistry();
