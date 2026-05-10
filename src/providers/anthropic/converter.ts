/**
 * Anthropic Converter
 *
 * Converts between IR and Anthropic Messages API format.
 *
 * Anthropic endpoint: POST /v1/messages
 *
 * Key format differences from OpenAI:
 * - max_tokens is required
 * - system is a top-level string, not a message
 * - Only "user" and "assistant" roles in messages
 * - Response content is an array of blocks (text, tool_use)
 * - Usage: input_tokens / output_tokens
 * - Tools use "input_schema" instead of "parameters"
 * - Tool calls use "tool_use" blocks with "input" instead of "function" with "arguments"
 * - Streaming uses typed SSE events (message_start, content_block_start,
 *   content_block_delta, content_block_stop, message_delta, message_stop)
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
  Message,
  ContentPart,
  TextPart,
  ToolCallPart,
  ToolResultPart,
  ToolDefinition,
} from "../../core/ir";
import type { StreamEvent } from "../../core/ir/stream";

export class AnthropicConverter extends BaseConverter {
  readonly providerId = "anthropic";
  readonly providerName = "Anthropic";

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
  }

  // ========================================================================
  // IR → Anthropic
  // ========================================================================

  requestToProvider(ir: IRRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: ir.model,
      max_tokens: ir.generation?.maxTokens ?? 4096,
      messages: this.buildAnthropicMessages(ir.messages),
    };

    // System message goes top-level
    const systemMsg = ir.messages.find(
      (m) => m.role === "system"
    );
    if (systemMsg) {
      const text = systemMsg.content
        .filter((p): p is TextPart => p.type === "text")
        .map((p) => p.text)
        .join("");
      if (text) body.system = text;
    }

    if (ir.generation?.temperature !== undefined) {
      body.temperature = ir.generation.temperature;
    }
    if (ir.generation?.topP !== undefined) {
      body.top_p = ir.generation.topP;
    }
    if (ir.generation?.topK !== undefined) {
      body.top_k = ir.generation.topK;
    }
    if (ir.generation?.stopSequences && ir.generation.stopSequences.length > 0) {
      body.stop_sequences = ir.generation.stopSequences;
    }
    if (ir.stream !== undefined) {
      body.stream = ir.stream;
    }

    // Tools
    if (ir.tools && ir.tools.length > 0) {
      body.tools = ir.tools.map((t) => this.buildAnthropicTool(t));
      if (ir.toolChoice) {
        body.tool_choice = this.buildAnthropicToolChoice(ir.toolChoice);
      }
    }

    return body;
  }

  private buildAnthropicMessages(messages: Message[]): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];

    for (const msg of messages) {
      if (msg.role === "system") continue; // handled top-level

      const role = msg.role === "assistant" ? "assistant" : "user";
      const content = this.buildAnthropicContent(msg.content);

      out.push({ role, content });
    }

    return out;
  }

  private buildAnthropicContent(parts: ContentPart[]): string | Record<string, unknown>[] {
    // If only text, return string for simplicity
    const hasNonText = parts.some((p) => p.type !== "text");
    if (!hasNonText) {
      return parts
        .filter((p): p is TextPart => p.type === "text")
        .map((p) => p.text)
        .join("");
    }

    // Mixed content → array of blocks
    return parts.map((part) => {
      switch (part.type) {
        case "text":
          return { type: "text", text: (part as TextPart).text };
        case "image":
          return {
            type: "image",
            source: {
              type: "base64",
              media_type: (part as { mediaType: string }).mediaType || "image/png",
              data: (part as { data: string }).data,
            },
          };
        case "tool_call":
          return {
            type: "tool_use",
            id: (part as ToolCallPart).id,
            name: (part as ToolCallPart).name,
            input: (part as ToolCallPart).arguments,
          };
        case "tool_result":
          return {
            type: "tool_result",
            tool_use_id: (part as ToolResultPart).toolCallId,
            content: (part as ToolResultPart).content,
            is_error: (part as ToolResultPart).isError || false,
          };
        default:
          return { type: "text", text: "" };
      }
    });
  }

  private buildAnthropicTool(tool: ToolDefinition): Record<string, unknown> {
    return {
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters || { type: "object", properties: {} },
    };
  }

  private buildAnthropicToolChoice(
    choice: { mode: string; allowedFunction?: string }
  ): string | Record<string, unknown> {
    switch (choice.mode) {
      case "none":
        return { type: "none" };
      case "auto":
        return { type: "auto" };
      case "required":
        return { type: "any" };
      case "tool":
        return choice.allowedFunction
          ? { type: "tool", name: choice.allowedFunction }
          : { type: "auto" };
      default:
        return { type: "auto" };
    }
  }

  // ========================================================================
  // Anthropic → IR
  // ========================================================================

  responseFromProvider(body: Record<string, unknown>): IRResponse {
    const msg = body as {
      id: string;
      model: string;
      role?: string;
      content: Array<Record<string, unknown>>;
      stop_reason: string | null;
      stop_sequence: string | null;
      usage?: { input_tokens: number; output_tokens: number };
    };

    const contentParts: ContentPart[] = [];
    const toolCalls: ToolCallPart[] = [];

    for (const block of msg.content || []) {
      if (block.type === "text") {
        contentParts.push({
          type: "text",
          text: String(block.text || ""),
        });
      } else if (block.type === "tool_use") {
        toolCalls.push({
          type: "tool_call",
          id: String(block.id || ""),
          name: String(block.name || ""),
          arguments: block.input as Record<string, unknown>,
        });
      } else if (block.type === "thinking" || block.type === "reasoning") {
        contentParts.push({
          type: "reasoning",
          reasoning: String(block.thinking || block.text || ""),
        });
      }
    }

    // Anthropic puts tool_use in content blocks, not separate field
    const allParts = contentParts.length > 0 ? contentParts : [];
    if (toolCalls.length > 0) {
      allParts.push(...toolCalls);
    }

    return {
      id: msg.id,
      model: msg.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: allParts,
          },
          finishReason: this.mapStopReason(msg.stop_reason),
        },
      ],
      usage: msg.usage
        ? {
            promptTokens: msg.usage.input_tokens,
            completionTokens: msg.usage.output_tokens,
            totalTokens: msg.usage.input_tokens + msg.usage.output_tokens,
          }
        : undefined,
    };
  }

  private mapStopReason(reason: string | null): string {
    switch (reason) {
      case "end_turn":
        return "stop";
      case "max_tokens":
        return "length";
      case "stop_sequence":
        return "stop";
      case "tool_use":
        return "tool_calls";
      default:
        return reason || "stop";
    }
  }

  // ========================================================================
  // Anthropic SSE → IR StreamEvent
  // ========================================================================

  streamEventFromProvider(chunk: unknown): StreamEvent | null {
    const data = chunk as Record<string, unknown>;
    const type = data.type as string;

    switch (type) {
      case "message_start": {
        const msg = data.message as {
          id: string;
          model: string;
          usage?: { input_tokens: number };
        };
        return {
          type: "stream_start",
          id: msg?.id || "",
          model: msg?.model || "",
        };
      }

      case "content_block_start": {
        const block = data.content_block as Record<string, unknown>;
        if (block?.type === "text") {
          return null; // text block start has no content yet
        }
        if (block?.type === "tool_use") {
          return {
            type: "tool_call_start",
            index: Number(data.index || 0),
            toolCallId: String(block.id || ""),
            toolName: String(block.name || ""),
          };
        }
        return null;
      }

      case "content_block_delta": {
        const delta = data.delta as Record<string, unknown>;
        const index = Number(data.index || 0);
        if (delta?.type === "text_delta") {
          return {
            type: "text_delta",
            index,
            delta: String(delta.text || ""),
          };
        }
        if (delta?.type === "thinking_delta") {
          return {
            type: "reasoning_delta",
            index,
            delta: String(delta.thinking || ""),
          };
        }
        if (delta?.type === "input_json_delta") {
          return {
            type: "tool_call_delta",
            index,
            toolCallId: "", // filled by tracking state
            delta: String(delta.partial_json || ""),
          };
        }
        return null;
      }

      case "message_delta": {
        const d = data.delta as { stop_reason?: string | null };
        return {
          type: "finish",
          finishReason: this.mapStopReason(d?.stop_reason || null),
        };
      }

      case "message_stop":
        return null; // end signal

      case "content_block_stop":
        return null;

      default:
        return null;
    }
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
      // OpenCode Go Anthropic-format models
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
