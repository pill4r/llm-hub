/**
 * IR Stream Event Types
 *
 * Unified streaming event representation.
 * All provider stream formats are normalized to these events.
 */

import type { ContentPart, ReasoningPart, TextPart, ToolCallPart } from "./parts";
import type { Usage } from "./response";

export type StreamEvent =
  | StreamStartEvent
  | StreamEndEvent
  | ContentBlockStartEvent
  | ContentBlockEndEvent
  | TextDeltaEvent
  | ReasoningDeltaEvent
  | ToolCallStartEvent
  | ToolCallDeltaEvent
  | FinishEvent
  | UsageEvent
  | ErrorEvent;

// ============================================================================
// Lifecycle events
// ============================================================================

export interface StreamStartEvent {
  type: "stream_start";
  id: string;
  model: string;
}

export interface StreamEndEvent {
  type: "stream_end";
}

// ============================================================================
// Content block events
// ============================================================================

export interface ContentBlockStartEvent {
  type: "content_block_start";
  index: number;
  blockType: "text" | "reasoning" | "tool_call";
}

export interface ContentBlockEndEvent {
  type: "content_block_end";
  index: number;
}

// ============================================================================
// Delta events
// ============================================================================

export interface TextDeltaEvent {
  type: "text_delta";
  index: number;
  delta: string;
}

export interface ReasoningDeltaEvent {
  type: "reasoning_delta";
  index: number;
  delta: string;
  signature?: string;
}

export interface ToolCallStartEvent {
  type: "tool_call_start";
  index: number;
  toolCallId: string;
  toolName: string;
}

export interface ToolCallDeltaEvent {
  type: "tool_call_delta";
  index: number;
  toolCallId: string;
  delta: string; // partial JSON arguments
}

// ============================================================================
// Finish / Usage events
// ============================================================================

export interface FinishEvent {
  type: "finish";
  finishReason: string;
}

export interface UsageEvent {
  type: "usage";
  usage: Usage;
}

export interface ErrorEvent {
  type: "error";
  error: {
    message: string;
    type: string;
    code?: string;
  };
}
