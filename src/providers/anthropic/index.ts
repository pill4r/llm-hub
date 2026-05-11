/**
 * Anthropic Provider Plugin
 *
 * Handles Anthropic Messages API.
 * Converts IR ↔ Anthropic format.
 */

import { providerRegistry } from "../types";
import type { ProviderPlugin, ProviderCapabilities } from "../types";
import type { IRRequest, IRResponse, StreamEvent, ContentPart } from "../../core/ir";

const PROVIDER_ID = "anthropic";
const PROVIDER_NAME = "Anthropic";
const ENDPOINT_TEMPLATE = "https://api.anthropic.com/v1/messages";

const CAPABILITIES: ProviderCapabilities = {
  streaming: true,
  tools: true,
  vision: true,
  systemMessages: true,
  reasoning: true,
  jsonMode: true,
  maxContextLength: 200_000,
};

// ============================================================================
// Request building: IR -> Anthropic
// ============================================================================

function buildRequest(ir: IRRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: ir.model,
    max_tokens: ir.generation?.maxTokens || 4096,
    messages: [],
  };

  // System prompt (top-level in Anthropic)
  if (ir.systemInstruction) {
    body.system = ir.systemInstruction;
  }

  // Convert IR messages to Anthropic format
  const messages: Record<string, unknown>[] = [];
  for (const m of ir.messages) {
    if (m.role === "system") {
      // System messages become part of the top-level system prompt
      // or are skipped if systemInstruction already covers it
      if (!ir.systemInstruction) {
        const text = m.content
          .filter((p): p is { type: "text"; text: string } => p.type === "text")
          .map((p) => p.text)
          .join("");
        if (text) {
          body.system = text;
        }
      }
      continue;
    }

    const msg: Record<string, unknown> = {
      role: m.role,
      content: m.content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join(""),
    };
    messages.push(msg);
  }
  body.messages = messages;

  // Generation config
  if (ir.generation) {
    const g = ir.generation;
    if (g.temperature !== undefined) body.temperature = g.temperature;
    if (g.topP !== undefined) body.top_p = g.topP;
    if (g.topK !== undefined) body.top_k = g.topK;
    if (g.stopSequences !== undefined) body.stop_sequences = g.stopSequences;
  }

  // Thinking budget (Claude 3.7 Sonnet extended thinking)
  if (ir.extensions?.thinking) {
    const thinking = ir.extensions.thinking as Record<string, unknown>;
    body.thinking = {
      type: "enabled",
      budget_tokens: thinking.budgetTokens || 0,
    };
  }

  // Tools
  if (ir.tools && ir.tools.length > 0) {
    body.tools = ir.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));

    if (ir.toolChoice) {
      if (typeof ir.toolChoice === "string") {
        if (ir.toolChoice === "auto") {
          body.tool_choice = { type: "auto" };
        } else if (ir.toolChoice === "required") {
          body.tool_choice = { type: "any" };
        } else if (ir.toolChoice === "none") {
          body.tool_choice = { type: "none" };
        }
      } else if (ir.toolChoice.type === "tool") {
        body.tool_choice = {
          type: "tool",
          name: ir.toolChoice.name,
        };
      }
    }
  }

  // Stream
  if (ir.stream?.enabled) {
    body.stream = true;
  }

  return body;
}

function buildContentBlocks(content: ContentPart[]): Record<string, unknown>[] {
  return content.map((part) => {
    switch (part.type) {
      case "text":
        return { type: "text", text: part.text };

      case "image": {
        const img = part as { source: { kind: string; mediaType: string; data: string } };
        return {
          type: "image",
          source: {
            type: "base64",
            media_type: img.source.mediaType,
            data: img.source.data,
          },
        };
      }

      case "tool_call": {
        const tc = part as { toolCallId: string; toolName: string; arguments: Record<string, unknown> };
        return {
          type: "tool_use",
          id: tc.toolCallId,
          name: tc.toolName,
          input: tc.arguments,
        };
      }

      case "tool_result": {
        const tr = part as { toolCallId: string; result: unknown; isError?: boolean };
        return {
          type: "tool_result",
          tool_use_id: tr.toolCallId,
          content: tr.result,
          is_error: tr.isError,
        };
      }

      case "reasoning": {
        const r = part as { reasoning: string; signature?: string };
        return {
          type: "thinking",
          thinking: r.reasoning,
          ...(r.signature ? { signature: r.signature } : {}),
        };
      }

      default:
        return { type: "text", text: "" };
    }
  });
}

// ============================================================================
// Response parsing: Anthropic -> IR
// ============================================================================

function parseResponse(raw: unknown): IRResponse {
  const obj = raw as Record<string, unknown>;
  const content = obj.content as Record<string, unknown>[] || [];

  // Parse content blocks into ContentPart[]
  const parts: ContentPart[] = [];
  for (const block of content) {
    const type = String(block.type);
    switch (type) {
      case "text":
        parts.push({ type: "text", text: String(block.text || "") });
        break;

      case "thinking": {
        const thinking = block as { thinking: string; signature?: string };
        parts.push({
          type: "reasoning",
          reasoning: thinking.thinking,
          signature: thinking.signature,
        });
        break;
      }

      case "tool_use": {
        const tc = block as { id: string; name: string; input: Record<string, unknown> };
        parts.push({
          type: "tool_call",
          toolCallId: tc.id,
          toolName: tc.name,
          arguments: tc.input,
        });
        break;
      }

      default:
        // Skip unknown block types
        break;
    }
  }

  // Usage
  const usage = obj.usage as Record<string, unknown> | undefined;

  return {
    id: String(obj.id || ""),
    model: String(obj.model || ""),
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: parts,
      },
      finishReason: mapAnthropicStopReason(String(obj.stop_reason || "")),
    }],
    usage: usage ? {
      promptTokens: Number(usage.input_tokens || 0),
      completionTokens: Number(usage.output_tokens || 0),
      totalTokens: Number(usage.input_tokens || 0) + Number(usage.output_tokens || 0),
    } : undefined,
  };
}

function mapAnthropicStopReason(reason: string): IRResponse["choices"][0]["finishReason"] {
  switch (reason) {
    case "end_turn": return "stop";
    case "max_tokens": return "length";
    case "tool_use": return "tool_calls";
    case "stop_sequence": return "stop";
    default: return "unknown";
  }
}

// ============================================================================
// Stream parsing: Anthropic SSE -> StreamEvent
// ============================================================================

function parseStreamChunk(chunk: unknown): StreamEvent | null {
  const obj = chunk as Record<string, unknown>;
  const type = String(obj.type || "");

  switch (type) {
    case "message_start": {
      const message = obj.message as Record<string, unknown>;
      return {
        type: "stream_start",
        id: String(message?.id || ""),
        model: String(message?.model || ""),
      };
    }

    case "content_block_start": {
      const block = obj.content_block as Record<string, unknown>;
      const blockType = String(block?.type || "");
      if (blockType === "tool_use") {
        return {
          type: "tool_call_start",
          index: Number(obj.index || 0),
          toolCallId: String(block.id || ""),
          toolName: String(block.name || ""),
        };
      }
      return {
        type: "content_block_start",
        index: Number(obj.index || 0),
        blockType: blockType === "thinking" ? "reasoning" : "text",
      };
    }

    case "content_block_delta": {
      const delta = obj.delta as Record<string, unknown>;
      const deltaType = String(delta?.type || "");

      // Anthropic SSE: delta without type field (just { text: "..." })
      if (!deltaType || deltaType === "undefined") {
        if (delta.text !== undefined) {
          return {
            type: "text_delta",
            index: Number(obj.index || 0),
            delta: String(delta.text || ""),
          };
        }
      }

      if (deltaType === "text_delta") {
        return {
          type: "text_delta",
          index: Number(obj.index || 0),
          delta: String(delta.text || ""),
        };
      }

      if (deltaType === "thinking_delta") {
        return {
          type: "reasoning_delta",
          index: Number(obj.index || 0),
          delta: String(delta.thinking || ""),
        };
      }

      if (deltaType === "input_json_delta") {
        return {
          type: "tool_call_delta",
          index: Number(obj.index || 0),
          toolCallId: "", // Filled from context
          delta: String(delta.partial_json || ""),
        };
      }

      return null;
    }

    case "content_block_stop": {
      return {
        type: "content_block_end",
        index: Number(obj.index || 0),
      };
    }

    case "message_delta": {
      const delta = obj.delta as Record<string, unknown>;
      if (delta?.stop_reason) {
        return {
          type: "finish",
          finishReason: mapAnthropicStopReason(String(delta.stop_reason)),
        };
      }
      // Usage in message_delta
      if (obj.usage) {
        const usage = obj.usage as Record<string, unknown>;
        return {
          type: "usage",
          usage: {
            promptTokens: Number(usage.input_tokens || 0),
            completionTokens: Number(usage.output_tokens || 0),
            totalTokens: Number(usage.input_tokens || 0) + Number(usage.output_tokens || 0),
          },
        };
      }
      return null;
    }

    case "message_stop": {
      return { type: "stream_end" };
    }

    default:
      return null;
  }
}

// ============================================================================
// Helpers
// ============================================================================

function isStreamEndMarker(chunk: unknown): boolean {
  const obj = chunk as Record<string, unknown>;
  return obj.type === "message_stop" || obj.type === "message_delta";
}

function parseError(raw: unknown): { message: string; type: string; code?: string } {
  const obj = raw as Record<string, unknown>;
  if (obj.type === "error" && obj.error) {
    const err = obj.error as Record<string, unknown>;
    return {
      message: String(err.message || "Unknown error"),
      type: String(err.type || "provider_error"),
    };
  }
  return {
    message: String(obj.message || "Unknown provider error"),
    type: String(obj.type || "provider_error"),
  };
}

function buildHeaders(apiKey: string, extraHeaders?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  };
  if (extraHeaders) {
    for (const key of Object.keys(extraHeaders)) {
      headers[key] = extraHeaders[key];
    }
  }
  return headers;
}

function buildEndpoint(baseUrl?: string, model?: string): string {
  let url = ENDPOINT_TEMPLATE;
  if (baseUrl) {
    const path = url.replace(/^https?:\/\/[^\/]+/, "");
    url = `${baseUrl.replace(/\/$/, "")}${path}`;
  }
  if (model) {
    url = url.replace(/\{\{model\}\}/g, model);
  }
  return url;
}

// ============================================================================
// Plugin registration
// ============================================================================

const plugin: ProviderPlugin = {
  id: PROVIDER_ID,
  name: PROVIDER_NAME,
  endpointTemplate: ENDPOINT_TEMPLATE,
  authType: "api-key",
  capabilities: CAPABILITIES,
  buildRequest,
  parseResponse,
  parseStreamChunk,
  isStreamEndMarker,
  parseError,
  buildHeaders,
  buildEndpoint,
};

providerRegistry.register(plugin);
