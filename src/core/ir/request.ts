/**
 * IR Request Types
 *
 * Unified request representation.
 * All provider-specific requests are converted to/from this format.
 */

import type { Message } from "./messages";
import type { ToolConfig } from "./tools";

export interface GenerationConfig {
  temperature?: number;
  topP?: number;
  topK?: number;
  maxTokens?: number;
  stopSequences?: string[];
  frequencyPenalty?: number;
  presencePenalty?: number;
  seed?: number;
}

export interface ResponseFormatConfig {
  type: "text" | "json" | "json_schema";
  jsonSchema?: {
    name: string;
    description?: string;
    schema: Record<string, unknown>;
    strict?: boolean;
  };
}

export interface StreamConfig {
  enabled: boolean;
  /** Include usage in the final chunk */
  includeUsage?: boolean;
}

export interface CacheConfig {
  /** TTL in seconds */
  ttl?: number;
}

/**
 * Intermediate Representation of a chat completion request.
 * This is the "hub" that all providers convert to/from.
 */
export interface IRRequest extends ToolConfig {
  /** Model identifier (provider-specific format) */
  model: string;

  /** Message history */
  messages: Message[];

  /** System instruction (alternative to system message) */
  systemInstruction?: string;

  /** Generation parameters */
  generation?: GenerationConfig;

  /** Response format constraint */
  responseFormat?: ResponseFormatConfig;

  /** Streaming configuration */
  stream?: StreamConfig;

  /** Cache configuration */
  cache?: CacheConfig;

  /** Provider-specific extensions (rarely used params) */
  extensions?: Record<string, unknown>;
}
