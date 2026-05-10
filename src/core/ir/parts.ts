/**
 * IR Content Part Types
 *
 * Unified content part representation across all providers.
 * Every message content is decomposed into a list of parts.
 */

export type ContentPart =
  | TextPart
  | ImagePart
  | ToolCallPart
  | ToolResultPart
  | ReasoningPart;

// ============================================================================
// Text
// ============================================================================

export interface TextPart {
  type: "text";
  text: string;
}

// ============================================================================
// Image
// ============================================================================

export interface ImagePart {
  type: "image";
  source: ImageSource;
}

export type ImageSource =
  | { kind: "url"; url: string }
  | { kind: "base64"; mediaType: string; data: string };

// ============================================================================
// Tool Call (assistant requests a tool)
// ============================================================================

export interface ToolCallPart {
  type: "tool_call";
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

// ============================================================================
// Tool Result (tool execution result)
// ============================================================================

export interface ToolResultPart {
  type: "tool_result";
  toolCallId: string;
  result: unknown;
  isError?: boolean;
}

// ============================================================================
// Reasoning (chain-of-thought, visible or hidden)
// ============================================================================

export interface ReasoningPart {
  type: "reasoning";
  reasoning: string;
  signature?: string; // For encrypted reasoning (Anthropic)
}

// ============================================================================
// Type Guards
// ============================================================================

export function isTextPart(part: ContentPart): part is TextPart {
  return part.type === "text";
}

export function isImagePart(part: ContentPart): part is ImagePart {
  return part.type === "image";
}

export function isToolCallPart(part: ContentPart): part is ToolCallPart {
  return part.type === "tool_call";
}

export function isToolResultPart(part: ContentPart): part is ToolResultPart {
  return part.type === "tool_result";
}

export function isReasoningPart(part: ContentPart): part is ReasoningPart {
  return part.type === "reasoning";
}
