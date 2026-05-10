/**
 * IR Message Types
 *
 * Unified message representation.
 * Each provider converts their format to/from these types.
 */

import type { ContentPart } from "./parts";

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface Message {
  role: MessageRole;
  content: ContentPart[];
  /** Provider-specific metadata, preserved but not processed */
  metadata?: Record<string, unknown>;
}

export interface SystemMessage extends Message {
  role: "system";
}

export interface UserMessage extends Message {
  role: "user";
}

export interface AssistantMessage extends Message {
  role: "assistant";
}

export interface ToolMessage extends Message {
  role: "tool";
}

// ============================================================================
// Helpers
// ============================================================================

export function createSystemMessage(text: string): Message {
  return { role: "system", content: [{ type: "text", text }] };
}

export function createUserMessage(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

export function createAssistantMessage(text: string): Message {
  return { role: "assistant", content: [{ type: "text", text }] };
}

export function createToolMessage(
  toolCallId: string,
  result: unknown,
  isError?: boolean
): Message {
  return {
    role: "tool",
    content: [{ type: "tool_result", toolCallId, result, isError }],
  };
}
