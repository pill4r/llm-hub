/**
 * Anthropic Converter
 *
 * Converts between IR and Anthropic Messages API format.
 * All conversion logic is now driven by the declarative transform engine.
 */

import {
  BaseConverter,
  registry,
  type ConverterCapabilities,
  type ConverterOptions,
} from "../../core/converter";
import type {
  IRRequest,
  IRResponse,
  StreamEvent,
} from "../../core/ir";
import {
  buildProviderRequest,
  parseProviderResponse,
  parseStreamChunk,
} from "../../lib/transform-engine";
import { anthropicTransform } from "../../lib/provider-transforms";

export class AnthropicConverter extends BaseConverter {
  readonly providerId: string;
  readonly providerName: string;

  readonly capabilities: ConverterCapabilities = {
    streaming: true,
    tools: true,
    vision: true,
    systemMessages: true,
    reasoning: true,
    jsonMode: false,
    maxContextLength: 200_000,
  };

  constructor(options: ConverterOptions = {}) {
    super(options);
    this.providerId = (options.providerId as string) || "anthropic";
    this.providerName = (options.providerName as string) || "Anthropic";
    if (options.capabilities) {
      this.capabilities = { ...this.capabilities, ...(options.capabilities as Partial<ConverterCapabilities>) };
    }
  }

  // ========================================================================
  // IR → Anthropic
  // ========================================================================

  requestToProvider(ir: IRRequest): Record<string, unknown> {
    const customReq = this.options.transforms?.request;
    if (customReq) {
      return buildProviderRequest(ir as unknown as Record<string, unknown>, customReq);
    }
    return buildProviderRequest(ir as unknown as Record<string, unknown>, anthropicTransform.request);
  }

  // ========================================================================
  // Anthropic → IR
  // ========================================================================

  responseFromProvider(raw: unknown): IRResponse {
    const customResp = this.options.transforms?.response;
    const parsed = customResp
      ? parseProviderResponse(raw, customResp)
      : parseProviderResponse(raw, anthropicTransform.response);
    return parsed as unknown as IRResponse;
  }

  // ========================================================================
  // Streaming
  // ========================================================================

  streamEventFromProvider(raw: unknown): StreamEvent | null {
    const customStream = this.options.transforms?.stream;
    const parsed = customStream
      ? parseStreamChunk(raw, customStream)
      : parseStreamChunk(raw, anthropicTransform.stream);

    if (parsed === null) return null;
    return parsed as unknown as StreamEvent;
  }

  isStreamEnd(chunk: unknown): boolean {
    const data = chunk as Record<string, unknown>;
    return data.type === "message_stop";
  }

  // ========================================================================
  // Endpoint & Headers
  // ========================================================================

  getChatCompletionEndpoint(): string {
    return `${this.options.baseUrl || "https://api.anthropic.com/v1"}/messages`;
  }

  getHeaders(apiKey: string): Record<string, string> {
    return {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    };
  }

  getSupportedModels(): { id: string; name: string }[] {
    return [
      { id: "claude-3-opus-20240229", name: "Claude 3 Opus" },
      { id: "claude-3-sonnet-20240229", name: "Claude 3 Sonnet" },
      { id: "claude-3-haiku-20240307", name: "Claude 3 Haiku" },
      { id: "claude-3-5-sonnet-20241022", name: "Claude 3.5 Sonnet" },
      { id: "claude-3-5-haiku-20241022", name: "Claude 3.5 Haiku" },
      { id: "claude-3-7-sonnet-20250219", name: "Claude 3.7 Sonnet" },
      { id: "minimax-m2.7", name: "MiniMax M2.7" },
      { id: "minimax-m2.5", name: "MiniMax M2.5" },
    ];
  }

  // ========================================================================
  // Error parsing
  // ========================================================================

  parseError(body: Record<string, unknown>): {
    message: string;
    type: string;
    code: string;
  } {
    const err = body.error as
      | { message?: string; type?: string }
      | undefined;
    return {
      message: err?.message || "Unknown Anthropic error",
      type: err?.type || "api_error",
      code: (body.type as string) || "unknown_error",
    };
  }
}

// Register
registry.register("anthropic", AnthropicConverter);
