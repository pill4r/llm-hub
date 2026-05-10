/**
 * IR Response Types
 *
 * Unified response representation.
 */

import type { ContentPart } from "./parts";

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface Choice {
  index: number;
  message: {
    role: "assistant";
    content: ContentPart[];
    /** For OpenAI-style refusal */
    refusal?: string | null;
  };
  finishReason: FinishReason;
}

export type FinishReason =
  | "stop"
  | "length"
  | "tool_calls"
  | "content_filter"
  | "unknown";

/**
 * Intermediate Representation of a chat completion response.
 */
export interface IRResponse {
  id: string;
  model: string;
  choices: Choice[];
  usage?: Usage;
  /** Provider-specific raw response (for debugging) */
  _raw?: unknown;
}

// ============================================================================
// IR Response for non-chat endpoints
// ============================================================================

export interface IRErrorResponse {
  error: {
    message: string;
    type: string;
    code?: string;
    param?: string;
  };
}
