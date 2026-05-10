/**
 * Anthropic Consumer Plugin
 *
 * Handles /v1/messages endpoint.
 * Compatible with Anthropic SDK, Claude Code CLI, Claude Desktop, etc.
 *
 * Claude Code special protocol support:
 * - computer-use tools (type: "computer_use_preview")
 * - prompt caching (type: "ephemeral" in content blocks)
 * - extended thinking (thinking budget)
 * - beta headers (anthropic-beta)
 */

import { consumerRegistry } from "../types";
import type { ConsumerPlugin, StreamOptions } from "../types";
import type { IRRequest, IRResponse, StreamEvent, ContentPart, ToolDefinition } from "../../core/ir";

const CONSUMER_ID = "anthropic";
const CONSUMER_NAME = "Anthropic";
const PATHS = ["/v1/messages", "/v1/messages/count_tokens"];

// ============================================================================
// Request parsing: Anthropic → IR
// ============================================================================

function parseRequest(body: Record<string, unknown>): IRRequest {
  const irRequest: IRRequest = {
    model: String(body.model || ""),
    messages: [],
  };

  // System prompt (top-level in Anthropic)
  if (body.system) {
    if (typeof body.system === "string") {
      irRequest.messages.push({
        role: "system",
        content: [{ type: "text", text: body.system }],
      });
    } else if (Array.isArray(body.system)) {
      // Claude Code: system as array of blocks (with cache_control)
      const parts = (body.system as Record<string, unknown>[]).map((block) => {
        if (block.type === "text") {
          return { type: "text" as const, text: String(block.text || "") };
        }
        return { type: "text" as const, text: "" };
      });
      irRequest.messages.push({ role: "system", content: parts });
    }
  }

  // Messages
  const msgs = (body.messages as Record<string, unknown>[] || []);
  for (const m of msgs) {
    const role = String(m.role) as "user" | "assistant";
    const content = m.content;

    let parts: ContentPart[];
    if (typeof content === "string") {
      parts = [{ type: "text", text: content }];
    } else if (Array.isArray(content)) {
      parts = (content as Record<string, unknown>[]).map(parseContentBlock);
    } else {
      parts = [{ type: "text", text: "" }];
    }

    irRequest.messages.push({ role, content: parts });
  }

  // Generation config
  const gen: IRRequest["generation"] = {};
  if (body.max_tokens !== undefined) gen.maxTokens = Number(body.max_tokens);
  if (body.temperature !== undefined) gen.temperature = Number(body.temperature);
  if (body.top_p !== undefined) gen.topP = Number(body.top_p);
  if (body.top_k !== undefined) gen.topK = Number(body.top_k);
  if (body.stop_sequences && Array.isArray(body.stop_sequences)) {
    gen.stopSequences = body.stop_sequences as string[];
  }
  if (Object.keys(gen).length > 0) irRequest.generation = gen;

  // Thinking budget (Claude 3.7 Sonnet extended thinking)
  if (body.thinking && typeof body.thinking === "object") {
    const thinking = body.thinking as Record<string, unknown>;
    if (thinking.type === "enabled") {
      irRequest.extensions = irRequest.extensions || {};
      irRequest.extensions.thinking = {
        enabled: true,
        budgetTokens: Number(thinking.budget_tokens || 0),
      };
    }
  }

  // Tools
  if (body.tools && Array.isArray(body.tools) && body.tools.length > 0) {
    irRequest.tools = (body.tools as Record<string, unknown>[]).map((t) => {
      // Claude Code computer-use tool
      if (t.type === "computer_use_preview" || t.type === "computer_20241022") {
        return {
          name: String(t.name || "computer"),
          description: String(t.description || "Use the computer"),
          parameters: {
            type: "object",
            properties: {
              action: { type: "string" },
              coordinate: { type: "array", items: { type: "number" } },
              text: { type: "string" },
            },
          },
        };
      }
      // Standard tool
      return {
        name: String(t.name),
        description: String(t.description || ""),
        parameters: (t.input_schema || t.parameters || { type: "object" }) as unknown as ToolDefinition["parameters"],
      };
    });
    if (body.tool_choice) {
      const tc = body.tool_choice;
      if (typeof tc === "string") {
        if (tc === "auto" || tc === "any" || tc === "none") {
          irRequest.toolChoice = tc === "any" ? "required" : tc;
        }
      } else if (typeof tc === "object" && tc !== null) {
        const obj = tc as Record<string, unknown>;
        if (obj.type === "tool" && obj.name) {
          irRequest.toolChoice = { type: "tool", name: String(obj.name) };
        }
      }
    }
  }

  // Stream
  if (body.stream) {
    irRequest.stream = { enabled: true };
  }

  return irRequest;
}

function parseContentBlock(block: Record<string, unknown>): ContentPart {
  const type = String(block.type);

  switch (type) {
    case "text":
      return { type: "text", text: String(block.text || "") };

    case "image": {
      const src = block.source as Record<string, unknown>;
      return {
        type: "image",
        source: {
          kind: "base64",
          mediaType: String(src?.media_type || "image/png"),
          data: String(src?.data || ""),
        },
      };
    }

    case "tool_use":
      return {
        type: "tool_call",
        toolCallId: String(block.id || ""),
        toolName: String(block.name || ""),
        arguments: (block.input || {}) as Record<string, unknown>,
      };

    case "tool_result":
      return {
        type: "tool_result",
        toolCallId: String(block.tool_use_id || ""),
        result: block.content,
        isError: Boolean(block.is_error),
      };

    case "thinking":
      return {
        type: "reasoning",
        reasoning: String(block.thinking || ""),
        signature: block.signature as string | undefined,
      };

    case "redacted_thinking":
      return {
        type: "reasoning",
        reasoning: "[redacted thinking]",
      };

    default:
      return { type: "text", text: "" };
  }
}

// ============================================================================
// Response building: IR → Anthropic
// ============================================================================

function buildResponse(ir: IRResponse): Record<string, unknown> {
  const choice = ir.choices[0];
  const content: Record<string, unknown>[] = [];

  for (const part of choice.message.content) {
    switch (part.type) {
      case "text":
        content.push({ type: "text", text: (part as { text: string }).text });
        break;
      case "reasoning": {
        const rp = part as { reasoning: string; signature?: string };
        content.push({
          type: "thinking",
          thinking: rp.reasoning,
          ...(rp.signature ? { signature: rp.signature } : {}),
        });
        break;
      }
      case "tool_call": {
        const tc = part as { toolCallId: string; toolName: string; arguments: Record<string, unknown> };
        content.push({
          type: "tool_use",
          id: tc.toolCallId,
          name: tc.toolName,
          input: tc.arguments,
        });
        break;
      }
    }
  }

  return {
    id: ir.id,
    type: "message",
    role: "assistant",
    model: ir.model,
    content,
    stop_reason: mapIRToAnthropicStopReason(choice.finishReason),
    usage: ir.usage
      ? {
          input_tokens: ir.usage.promptTokens,
          output_tokens: ir.usage.completionTokens,
        }
      : undefined,
  };
}

// ============================================================================
// Stream building: IR → Anthropic SSE
// ============================================================================

function buildStreamChunk(event: StreamEvent, options: StreamOptions): string | null {
  const { model } = options;

  switch (event.type) {
    case "stream_start": {
      return `event: message_start\ndata: ${JSON.stringify({
        type: "message_start",
        message: {
          id: event.id,
          type: "message",
          role: "assistant",
          model,
          content: [],
        },
      })}\n\n`;
    }

    case "text_delta": {
      return `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        index: event.index,
        delta: { type: "text_delta", text: event.delta },
      })}\n\n`;
    }

    case "reasoning_delta": {
      return `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        index: event.index,
        delta: { type: "thinking_delta", thinking: event.delta },
      })}\n\n`;
    }

    case "tool_call_start": {
      return `event: content_block_start\ndata: ${JSON.stringify({
        type: "content_block_start",
        index: event.index,
        content_block: { type: "tool_use", id: event.toolCallId, name: event.toolName },
      })}\n\n`;
    }

    case "tool_call_delta": {
      return `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        index: event.index,
        delta: { type: "input_json_delta", partial_json: event.delta },
      })}\n\n`;
    }

    case "finish": {
      return `event: message_delta\ndata: ${JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: mapIRToAnthropicStopReason(event.finishReason) },
      })}\n\n`;
    }

    case "usage": {
      return `event: message_delta\ndata: ${JSON.stringify({
        type: "message_delta",
        delta: {},
        usage: {
          input_tokens: event.usage.promptTokens,
          output_tokens: event.usage.completionTokens,
        },
      })}\n\n`;
    }

    default:
      return null;
  }
}

// ============================================================================
// Error building
// ============================================================================

function buildError(error: { message: string; type: string; code?: string }): Record<string, unknown> {
  return {
    type: "error",
    error: {
      type: error.type,
      message: error.message,
    },
  };
}

// ============================================================================
// Helpers
// ============================================================================

function mapIRToAnthropicStopReason(reason: string): string | null {
  switch (reason) {
    case "stop": return "end_turn";
    case "length": return "max_tokens";
    case "tool_calls": return "tool_use";
    default: return null;
  }
}

function detect(path: string, _headers: Headers, body: Record<string, unknown>): boolean {
  return PATHS.includes(path) || (body.system !== undefined && Array.isArray(body.messages));
}

function getModel(body: Record<string, unknown>): string {
  return String(body.model || "");
}

function isStreaming(body: Record<string, unknown>): boolean {
  return !!body.stream;
}

// ============================================================================
// Plugin registration
// ============================================================================

const plugin: ConsumerPlugin = {
  id: CONSUMER_ID,
  name: CONSUMER_NAME,
  paths: PATHS,
  detect,
  parseRequest,
  buildResponse,
  buildStreamChunk,
  buildError,
  getModel,
  isStreaming,
};

consumerRegistry.register(plugin);
