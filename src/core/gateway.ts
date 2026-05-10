/**
 * Gateway Core
 *
 * Routes requests to the appropriate provider using IR conversion.
 */

import type { BaseConverter } from "./converter";
import type { IRRequest, IRResponse, StreamEvent, ContentPart, TextPart, ToolCallPart, Usage } from "./ir";

export interface GatewayEnv {
  KV: KVNamespace;
  DB: D1Database;
}

export interface GatewayConfig {
  timeout: number;
  maxRetries: number;
  allowStreaming: boolean;
}

const DEFAULT_CONFIG: GatewayConfig = {
  timeout: 60_000,
  maxRetries: 3,
  allowStreaming: true,
};

/**
 * Resolve which provider and model to use.
 * Priority:
 *   1. x-hub-provider header
 *   2. model field ("provider:model" format)
 *   3. Configured default
 */
export function resolveTarget(
  headers: Headers,
  bodyModel: string
): { providerId: string; model: string } {
  const providerHeader = headers.get("x-hub-provider");
  if (providerHeader) {
    return { providerId: providerHeader, model: bodyModel };
  }

  if (bodyModel.includes(":")) {
    const [providerId, ...modelParts] = bodyModel.split(":");
    return { providerId, model: modelParts.join(":") };
  }

  return { providerId: "openai", model: bodyModel };
}

// ============================================================================
// Consumer → IR (OpenAI format)
// ============================================================================

export function buildIRRequest(body: Record<string, unknown>): IRRequest {
  const messages = (body.messages as Record<string, unknown>[] || []).map((m) => ({
    role: String(m.role) as IRRequest["messages"][0]["role"],
    content: typeof m.content === "string"
      ? [{ type: "text" as const, text: m.content }]
      : (m.content as IRRequest["messages"][0]["content"]),
  }));

  const irRequest: IRRequest = {
    model: String(body.model || ""),
    messages,
  };

  if (body.system_instruction) {
    irRequest.systemInstruction = String(body.system_instruction);
  }

  const gen: IRRequest["generation"] = {};
  if (body.temperature !== undefined) gen.temperature = Number(body.temperature);
  if (body.top_p !== undefined) gen.topP = Number(body.top_p);
  if (body.max_tokens !== undefined) gen.maxTokens = Number(body.max_tokens);
  if (body.stop !== undefined) gen.stopSequences = Array.isArray(body.stop) ? body.stop as string[] : [String(body.stop)];
  if (body.frequency_penalty !== undefined) gen.frequencyPenalty = Number(body.frequency_penalty);
  if (body.presence_penalty !== undefined) gen.presencePenalty = Number(body.presence_penalty);
  if (body.seed !== undefined) gen.seed = Number(body.seed);
  if (Object.keys(gen).length > 0) irRequest.generation = gen;

  if (body.tools && Array.isArray(body.tools) && body.tools.length > 0) {
    irRequest.tools = (body.tools as Record<string, unknown>[]).map((t) => {
      const fn = t.function as Record<string, unknown>;
      return {
        name: String(fn.name),
        description: String(fn.description || ""),
        parameters: fn.parameters as IRRequest["tools"][0]["parameters"],
      };
    });
    if (body.tool_choice) {
      const tc = body.tool_choice;
      if (tc === "auto" || tc === "required" || tc === "none") {
        irRequest.toolChoice = tc;
      } else if (typeof tc === "object" && tc !== null) {
        const obj = tc as Record<string, unknown>;
        if (obj.type === "function") {
          irRequest.toolChoice = { type: "tool", name: String((obj.function as Record<string, unknown>)?.name) };
        }
      }
    }
  }

  if (body.response_format) {
    const rf = body.response_format as Record<string, unknown>;
    if (rf.type === "json_object") {
      irRequest.responseFormat = { type: "json" };
    } else if (rf.type === "json_schema") {
      const schema = rf.json_schema as Record<string, unknown>;
      irRequest.responseFormat = {
        type: "json_schema",
        jsonSchema: {
          name: String(schema.name),
          description: schema.description as string | undefined,
          schema: schema.schema as Record<string, unknown>,
          strict: schema.strict as boolean | undefined,
        },
      };
    }
  }

  if (body.stream) {
    irRequest.stream = {
      enabled: true,
      includeUsage: !!(body.stream_options as Record<string, unknown>)?.include_usage,
    };
  }

  return irRequest;
}

// ============================================================================
// Consumer → IR (Anthropic format)
// ============================================================================

export function buildIRRequestFromAnthropic(body: Record<string, unknown>): IRRequest {
  const irRequest: IRRequest = {
    model: String(body.model || ""),
    messages: [],
  };

  // System prompt is top-level in Anthropic
  if (body.system) {
    irRequest.messages.push({
      role: "system",
      content: [{ type: "text", text: String(body.system) }],
    });
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
      parts = (content as Record<string, unknown>[]).map((block) => {
        const type = String(block.type);
        if (type === "text") {
          return { type: "text", text: String(block.text || "") };
        }
        if (type === "image") {
          const src = block.source as Record<string, unknown>;
          return {
            type: "image",
            data: String(src?.data || ""),
            mediaType: String(src?.media_type || "image/png"),
          };
        }
        if (type === "tool_use") {
          return {
            type: "tool_call",
            id: String(block.id || ""),
            name: String(block.name || ""),
            arguments: (block.input || {}) as Record<string, unknown>,
          };
        }
        if (type === "tool_result") {
          return {
            type: "tool_result",
            toolCallId: String(block.tool_use_id || ""),
            content: String(block.content || ""),
            isError: Boolean(block.is_error),
          };
        }
        return { type: "text", text: "" };
      });
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

  // Tools
  if (body.tools && Array.isArray(body.tools) && body.tools.length > 0) {
    irRequest.tools = (body.tools as Record<string, unknown>[]).map((t) => ({
      name: String(t.name),
      description: String(t.description || ""),
      parameters: (t.input_schema || t.parameters) as IRRequest["tools"][0]["parameters"],
    }));
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

// ============================================================================
// Provider forwarding
// ============================================================================

export async function forwardToProvider(
  converter: BaseConverter,
  irRequest: IRRequest,
  apiKey: string,
  config: GatewayConfig = DEFAULT_CONFIG
): Promise<Response> {
  const providerBody = converter.requestToProvider(irRequest);
  const endpoint = converter.getChatCompletionEndpoint(irRequest.model);
  const headers = converter.getHeaders(apiKey);

  return fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(providerBody),
  });
}

// ============================================================================
// Streaming: Provider SSE → IR StreamEvent
// ============================================================================

export async function* streamEventsFromProvider(
  converter: BaseConverter,
  response: Response
): AsyncGenerator<{ event: StreamEvent | null; raw: Record<string, unknown> }, void, unknown> {
  const reader = response.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Handle Anthropic-style typed SSE: "event: xxx" then "data: xxx"
        if (trimmed.startsWith("event: ")) {
          converter["_currentEventType"] = trimmed.slice(7).trim();
          continue;
        }

        if (!trimmed.startsWith("data: ")) continue;

        const data = trimmed.slice(6);
        if (data === "[DONE]") {
          return;
        }

        try {
          const chunk = JSON.parse(data);
          const event = converter.streamEventFromProvider(chunk);
          if (event) {
            yield { event, raw: chunk };
          }
        } catch {
          // Skip invalid JSON
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ============================================================================
// IR StreamEvent → OpenAI SSE chunk
// ============================================================================

export function buildOpenAIStreamChunk(
  event: StreamEvent,
  model: string,
  id: string
): Record<string, unknown> | null {
  const created = Math.floor(Date.now() / 1000);

  switch (event.type) {
    case "stream_start":
      return null; // OpenAI doesn't have explicit start

    case "text_delta":
      return {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{
          index: event.index,
          delta: { content: event.delta },
          finish_reason: null,
        }],
      };

    case "reasoning_delta":
      return {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{
          index: event.index,
          delta: { reasoning_content: event.delta },
          finish_reason: null,
        }],
      };

    case "tool_call_start":
      return {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{
          index: event.index,
          delta: {
            tool_calls: [{
              index: event.index,
              id: event.toolCallId,
              type: "function",
              function: { name: event.toolName, arguments: "" },
            }],
          },
          finish_reason: null,
        }],
      };

    case "tool_call_delta":
      return {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{
          index: event.index,
          delta: {
            tool_calls: [{
              index: event.index,
              function: { arguments: event.delta },
            }],
          },
          finish_reason: null,
        }],
      };

    case "finish":
      return {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{
          index: 0,
          delta: {},
          finish_reason: event.finishReason,
        }],
      };

    case "usage":
      return {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [],
        usage: {
          prompt_tokens: event.usage.promptTokens,
          completion_tokens: event.usage.completionTokens,
          total_tokens: event.usage.totalTokens,
        },
      };

    default:
      return null;
  }
}

// ============================================================================
// IR → OpenAI response (non-streaming)
// ============================================================================

export function buildOpenAIResponse(ir: IRResponse): Record<string, unknown> {
  const choice = ir.choices[0];
  const textParts = choice.message.content.filter((p): p is TextPart => p.type === "text");
  const toolCalls = choice.message.content.filter((p): p is ToolCallPart => p.type === "tool_call");

  const message: Record<string, unknown> = {
    role: "assistant",
    content: textParts.map((p) => p.text).join("") || null,
  };

  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls.map((tc, i) => ({
      index: i,
      id: tc.id,
      type: "function",
      function: {
        name: tc.name,
        arguments: JSON.stringify(tc.arguments),
      },
    }));
  }

  return {
    id: ir.id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: ir.model,
    choices: [{
      index: choice.index,
      message,
      finish_reason: choice.finishReason,
    }],
    usage: ir.usage,
  };
}

// ============================================================================
// IR StreamEvent → Anthropic SSE chunk
// ============================================================================

export function buildAnthropicStreamChunk(
  event: StreamEvent,
  model: string
): string | null {
  switch (event.type) {
    case "stream_start":
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

    case "content_block_start":
      if (event.blockType === "text") {
        return `event: content_block_start\ndata: ${JSON.stringify({
            type: "content_block_start",
            index: event.index,
            content_block: { type: "text", text: "" },
          })}\n\n`;
      }
      if (event.blockType === "tool_call") {
        return `event: content_block_start\ndata: ${JSON.stringify({
            type: "content_block_start",
            index: event.index,
            content_block: { type: "tool_use", id: "", name: "" },
          })}\n\n`;
      }
      return null;

    case "text_delta":
      return `event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          index: event.index,
          delta: { type: "text_delta", text: event.delta },
        })}\n\n`;

    case "reasoning_delta":
      return `event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          index: event.index,
          delta: { type: "thinking_delta", thinking: event.delta },
        })}\n\n`;

    case "tool_call_start":
      return `event: content_block_start\ndata: ${JSON.stringify({
          type: "content_block_start",
          index: event.index,
          content_block: { type: "tool_use", id: event.toolCallId, name: event.toolName },
        })}\n\n`;

    case "tool_call_delta":
      return `event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          index: event.index,
          delta: { type: "input_json_delta", partial_json: event.delta },
        })}\n\n`;

    case "finish":
      return `event: message_delta\ndata: ${JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: mapIRToAnthropicStopReason(event.finishReason) },
        })}\n\n`;

    case "usage":
      return `event: message_delta\ndata: ${JSON.stringify({
          type: "message_delta",
          delta: {},
          usage: {
            input_tokens: event.usage.promptTokens,
            output_tokens: event.usage.completionTokens,
          },
        })}\n\n`;

    default:
      return null;
  }
}

function mapIRToAnthropicStopReason(reason: string): string | null {
  switch (reason) {
    case "stop": return "end_turn";
    case "length": return "max_tokens";
    case "tool_calls": return "tool_use";
    default: return null;
  }
}

// ============================================================================
// IR → Anthropic response (non-streaming)
// ============================================================================

export function buildAnthropicResponse(ir: IRResponse): Record<string, unknown> {
  const choice = ir.choices[0];
  const content: Record<string, unknown>[] = [];

  for (const part of choice.message.content) {
    switch (part.type) {
      case "text":
        content.push({ type: "text", text: (part as TextPart).text });
        break;
      case "reasoning":
        content.push({ type: "thinking", thinking: (part as { reasoning: string }).reasoning });
        break;
      case "tool_call": {
        const tc = part as ToolCallPart;
        content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.name,
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
// IR → Anthropic error
// ============================================================================

export function buildAnthropicError(
  message: string,
  type: string
): Record<string, unknown> {
  return {
    type: "error",
    error: {
      type,
      message,
    },
  };
}
