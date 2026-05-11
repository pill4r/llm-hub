/**
 * Provider Engine
 *
 * Pure functions for provider operations. Replaces the Converter class hierarchy.
 * All provider logic is data-driven from ProviderConfig.
 */

import type { IRRequest, IRResponse, StreamEvent } from "../core/ir";

/** Provider capability flags */
export interface ConverterCapabilities {
  streaming: boolean;
  tools: boolean;
  vision: boolean;
  systemMessages: boolean;
  reasoning: boolean;
  jsonMode: boolean;
  maxContextLength: number;
}

import {
  buildProviderRequest,
  parseProviderResponse,
  parseStreamChunk,
} from "./transform-engine";
import { openaiTransform, anthropicTransform } from "./provider-transforms";
import type { TransformConfig } from "./transform-engine";

// ========================================================================
// Provider Format Registry
// ========================================================================

export interface ProviderFormat {
  id: string;
  name: string;
  /** Default endpoint template with {{model}} placeholder */
  endpointTemplate: string;
  /** Default auth type */
  authType: "bearer" | "api-key" | "x-api-key";
  /** Built-in transform config */
  transform: TransformConfig;
  /** Default capabilities */
  capabilities: ConverterCapabilities;
}

const BUILTIN_FORMATS: Record<string, ProviderFormat> = {
  openai: {
    id: "openai",
    name: "OpenAI",
    endpointTemplate: "https://api.openai.com/v1/chat/completions",
    authType: "bearer",
    transform: openaiTransform,
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      systemMessages: true,
      reasoning: false,
      jsonMode: true,
      maxContextLength: 128_000,
    },
  },
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    endpointTemplate: "https://api.anthropic.com/v1/messages",
    authType: "api-key",
    transform: anthropicTransform,
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      systemMessages: true,
      reasoning: true,
      jsonMode: true,
      maxContextLength: 200_000,
    },
  },
};

export function getBuiltinFormat(formatId: string): ProviderFormat | undefined {
  return BUILTIN_FORMATS[formatId];
}

export function listBuiltinFormats(): ProviderFormat[] {
  return Object.keys(BUILTIN_FORMATS).map((id) => BUILTIN_FORMATS[id]);
}

// ========================================================================
// Provider Instance Config
// ========================================================================

export interface ProviderInstanceConfig {
  providerId: string;
  providerName: string;
  /** Format ID or custom transform */
  format: string;
  /** Base URL override (optional) */
  baseUrl?: string;
  /** Full endpoint override (optional) */
  endpoint?: string;
  /** Auth configuration */
  auth?: {
    type: "bearer" | "api-key" | "x-api-key";
    headerName?: string;
  };
  /** Extra headers to include */
  extraHeaders?: Record<string, string>;
  /** Supported models */
  models: string[];
  /** Capability overrides */
  capabilities?: Partial<ConverterCapabilities>;
  /** Custom transforms (for non-standard protocols) */
  transforms?: TransformConfig;
}

// ========================================================================
// Resolve Transform Config
// ========================================================================

function resolveTransformConfig(config: ProviderInstanceConfig): TransformConfig {
  // 1. Custom transforms take highest priority
  if (config.transforms) {
    return config.transforms;
  }

  // 2. Built-in format
  const format = BUILTIN_FORMATS[config.format];
  if (format) {
    return format.transform;
  }

  throw new Error(`Unknown provider format: ${config.format}. No built-in transform found.`);
}

// ========================================================================
// Request → Provider
// ========================================================================

export function providerRequestToBody(
  ir: IRRequest,
  config: ProviderInstanceConfig
): Record<string, unknown> {
  const transform = resolveTransformConfig(config);
  return buildProviderRequest(ir as unknown as Record<string, unknown>, transform.request) as Record<string, unknown>;
}

// ========================================================================
// Response → IR
// ========================================================================

export function providerResponseToIR(
  raw: unknown,
  config: ProviderInstanceConfig
): IRResponse {
  const transform = resolveTransformConfig(config);
  return parseProviderResponse(raw, transform.response) as unknown as IRResponse;
}

// ========================================================================
// Stream Chunk → StreamEvent
// ========================================================================

export function providerStreamChunkToEvent(
  chunk: unknown,
  config: ProviderInstanceConfig
): StreamEvent | null {
  const transform = resolveTransformConfig(config);
  return parseStreamChunk(chunk, transform.stream) as unknown as StreamEvent | null;
}

// ========================================================================
// Endpoint Building
// ========================================================================

export function buildProviderEndpoint(
  config: ProviderInstanceConfig,
  model?: string
): string {
  // Full endpoint override
  if (config.endpoint) {
    return config.endpoint.replace(/\{\{model\}\}/g, model || "");
  }

  const format = BUILTIN_FORMATS[config.format];
  const baseTemplate = format?.endpointTemplate || "";

  // Base URL override
  if (config.baseUrl) {
    // If baseUrl is provided, use it as the base and append the path from template
    const templatePath = baseTemplate.replace(/^https?:\/\/[^\/]+/, "");
    return `${config.baseUrl.replace(/\/$/, "")}${templatePath}`;
  }

  return baseTemplate;
}

// ========================================================================
// Headers Building
// ========================================================================

export function buildProviderHeaders(
  config: ProviderInstanceConfig,
  apiKey: string
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  const authType = config.auth?.type || BUILTIN_FORMATS[config.format]?.authType || "bearer";

  switch (authType) {
    case "bearer":
      headers["Authorization"] = `Bearer ${apiKey}`;
      break;
    case "api-key":
      headers["x-api-key"] = apiKey;
      break;
    case "x-api-key":
      headers["X-API-Key"] = apiKey;
      break;
  }

  // Extra headers
  if (config.extraHeaders) {
    for (const key of Object.keys(config.extraHeaders)) {
      headers[key] = config.extraHeaders[key];
    }
  }

  return headers;
}

// ========================================================================
// Error Parsing
// ========================================================================

export function parseProviderError(
  raw: unknown,
  _config: ProviderInstanceConfig
): { message: string; type: string; code?: string } {
  if (!raw || typeof raw !== "object") {
    return { message: "Unknown provider error", type: "provider_error" };
  }

  const obj = raw as Record<string, unknown>;

  // OpenAI-style error
  if (obj.error && typeof obj.error === "object") {
    const err = obj.error as Record<string, unknown>;
    return {
      message: String(err.message || "Unknown error"),
      type: String(err.type || "provider_error"),
      code: err.code ? String(err.code) : undefined,
    };
  }

  // Anthropic-style error
  if (obj.type === "error" && obj.error) {
    const err = obj.error as Record<string, unknown>;
    return {
      message: String(err.message || "Unknown error"),
      type: String(err.type || "provider_error"),
    };
  }

  // Generic
  return {
    message: String(obj.message || "Unknown provider error"),
    type: String(obj.type || "provider_error"),
  };
}

// ========================================================================
// Capabilities
// ========================================================================

export function getProviderCapabilities(
  config: ProviderInstanceConfig
): ConverterCapabilities {
  const format = BUILTIN_FORMATS[config.format];
  const base = format?.capabilities || {
    streaming: false,
    tools: false,
    vision: false,
    systemMessages: false,
    reasoning: false,
    jsonMode: false,
    maxContextLength: 4096,
  };

  return { ...base, ...config.capabilities };
}

// ========================================================================
// Stream End Detection
// ========================================================================

export function isStreamEndMarker(
  chunk: unknown,
  config: ProviderInstanceConfig
): boolean {
  const transform = resolveTransformConfig(config);
  if (transform.stream?.doneMarker) {
    const raw = JSON.stringify(chunk);
    return raw.indexOf(transform.stream.doneMarker) !== -1;
  }
  return false;
}
