/**
 * OpenAI Converter
 *
 * Converts between OpenAI Chat Completions API format and IR.
 * All conversion logic is now driven by the declarative transform engine.
 */

import {
  BaseConverter,
  type ConverterCapabilities,
  type ConverterOptions,
  registry,
} from "../../core/converter";
import type {
  ContentPart,
  IRRequest,
  IRResponse,
  Message,
  StreamEvent,
  Usage,
} from "../../core/ir";
import {
  buildProviderRequest,
  parseProviderResponse,
  parseStreamChunk,
} from "../../lib/transform-engine";
import { openaiTransform } from "../../lib/provider-transforms";

export class OpenAIConverter extends BaseConverter {
  readonly providerId: string;
  readonly providerName: string;
  readonly capabilities: ConverterCapabilities;

  constructor(options: ConverterOptions = {}) {
    super(options);
    this.providerId = (options.providerId as string) || "openai";
    this.providerName = (options.providerName as string) || "OpenAI";
    this.capabilities = {
      streaming: true,
      tools: true,
      vision: true,
      systemMessages: true,
      reasoning: false,
      jsonMode: true,
      maxContextLength: 128_000,
      ...(options.capabilities as Partial<ConverterCapabilities> || {}),
    };
  }

  // ========================================================================
  // IR → OpenAI
  // ========================================================================

  requestToProvider(irRequest: IRRequest): Record<string, unknown> {
    // Use declarative transform engine with built-in OpenAI template
    // Custom transforms from config override/extend the built-in template
    const customReq = this.options.transforms?.request;
    if (customReq) {
      return buildProviderRequest(irRequest as unknown as Record<string, unknown>, customReq);
    }
    return buildProviderRequest(irRequest as unknown as Record<string, unknown>, openaiTransform.request);
  }

  // ========================================================================
  // OpenAI → IR
  // ========================================================================

  responseFromProvider(raw: unknown): IRResponse {
    const customResp = this.options.transforms?.response;
    const parsed = customResp
      ? parseProviderResponse(raw, customResp)
      : parseProviderResponse(raw, openaiTransform.response);

    // The declarative engine produces an IR-shaped object.
    // We cast it to IRResponse (the engine is designed to match IR shape).
    return parsed as unknown as IRResponse;
  }

  // ========================================================================
  // Streaming
  // ========================================================================

  streamEventFromProvider(raw: unknown): StreamEvent | null {
    const customStream = this.options.transforms?.stream;
    const parsed = customStream
      ? parseStreamChunk(raw, customStream)
      : parseStreamChunk(raw, openaiTransform.stream);

    if (parsed === null) return null;
    return parsed as unknown as StreamEvent;
  }

  isStreamEnd(chunk: unknown): boolean {
    return Object.keys(chunk as Record<string, unknown>).length === 0;
  }

  // ========================================================================
  // Error
  // ========================================================================

  parseError(raw: unknown): { message: string; type: string; code?: string; status?: number } {
    const err = (raw as Record<string, unknown>)?.error as Record<string, unknown> | undefined;
    return {
      message: String(err?.message || "Unknown error"),
      type: String(err?.type || "unknown"),
      code: err?.code as string | undefined,
    };
  }

  // ========================================================================
  // Endpoint & Headers
  // ========================================================================

  getChatCompletionEndpoint(): string {
    const base = (this.options.baseUrl as string) || "https://api.openai.com/v1";
    const suffix = (this.options.chatEndpoint as string) || "/chat/completions";
    return `${base.replace(/\/$/, "")}${suffix}`;
  }

  getHeaders(apiKey: string): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    const authType = (this.options.authType as string) || "bearer";

    switch (authType) {
      case "bearer":
        headers["Authorization"] = `Bearer ${apiKey}`;
        break;
      case "api-key":
        headers["api-key"] = apiKey;
        break;
      case "x-api-key":
        headers["x-api-key"] = apiKey;
        break;
    }

    const extra = this.options.extraHeaders as Record<string, string> | undefined;
    if (extra) Object.assign(headers, extra);

    return headers;
  }

  getSupportedModels(): { id: string; name: string }[] {
    const models = this.options.models as { id: string; name: string }[] | undefined;
    return models || [
      { id: "gpt-4o", name: "GPT-4o" },
      { id: "gpt-4o-mini", name: "GPT-4o Mini" },
      { id: "gpt-4-turbo", name: "GPT-4 Turbo" },
      { id: "gpt-4", name: "GPT-4" },
      { id: "gpt-3.5-turbo", name: "GPT-3.5 Turbo" },
      { id: "o1-preview", name: "o1 Preview" },
      { id: "o1-mini", name: "o1 Mini" },
    ];
  }
}

// Register
registry.register("openai", OpenAIConverter);
