/**
 * OpenAI Provider Plugin
 *
 * Handles OpenAI Chat Completions API.
 * Converts IR ↔ OpenAI format.
 */

import { providerRegistry } from "../types";
import type { ProviderPlugin, ProviderCapabilities } from "../types";
import type { IRRequest, IRResponse, StreamEvent, ToolDefinition } from "../../core/ir";

const PROVIDER_ID = "openai";
const PROVIDER_NAME = "OpenAI";
const ENDPOINT_TEMPLATE = "https://api.openai.com/v1/chat/completions";

const CAPABILITIES: ProviderCapabilities = {
  streaming: true,
  tools: true,
  vision: true,
  systemMessages: true,
  reasoning: false,
  jsonMode: true,
  maxContextLength: 128_000,
};

// ============================================================================
// Request building: IR -> OpenAI
// ============================================================================

function buildRequest(ir: IRRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: ir.model,
    messages: buildMessages(ir),
  };

  // Generation config
  if (ir.generation) {
    const g = ir.generation;
    if (g.temperature !== undefined) body.temperature = g.temperature;
    if (g.topP !== undefined) body.top_p = g.topP;
    if (g.maxTokens !== undefined) body.max_tokens = g.maxTokens;
    if (g.stopSequences !== undefined) body.stop = g.stopSequences;
    if (g.frequencyPenalty !== undefined) body.frequency_penalty = g.frequencyPenalty;
    if (g.presencePenalty !== undefined) body.presence_penalty = g.presencePenalty;
    if (g.seed !== undefined) body.seed = g.seed;
  }

  // Tools
  if (ir.tools && ir.tools.length > 0) {
    body.tools = ir.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));

    if (ir.toolChoice) {
      if (typeof ir.toolChoice === "string") {
        body.tool_choice = ir.toolChoice;
      } else if (ir.toolChoice.type === "tool") {
        body.tool_choice = {
          type: "function",
          function: { name: ir.toolChoice.name },
        };
      }
    }
  }

  // Response format
  if (ir.responseFormat) {
    const rf = ir.responseFormat;
    if (rf.type === "json") {
      body.response_format = { type: "json_object" };
    } else if (rf.type === "json_schema" && rf.jsonSchema) {
      body.response_format = {
        type: "json_schema",
        json_schema: {
          name: rf.jsonSchema.name,
          description: rf.jsonSchema.description,
          schema: rf.jsonSchema.schema,
          strict: rf.jsonSchema.strict,
        },
      };
    }
  }

  // Stream
  if (ir.stream?.enabled) {
    body.stream = true;
    if (ir.stream.includeUsage) {
      body.stream_options = { include_usage: true };
    }
  }

  return body;
}

function buildMessages(ir: IRRequest): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];

  // System instruction as first system message
  if (ir.systemInstruction) {
    messages.push({
      role: "system",
      content: ir.systemInstruction,
    });
  }

  // Convert IR messages to OpenAI format
  for (const m of ir.messages) {
    if (m.role === "system" && ir.systemInstruction) {
      // Skip system messages if we already have systemInstruction
      // (they would be duplicates)
      continue;
    }

    const msg: Record<string, unknown> = { role: m.role };

    if (m.role === "assistant") {
      // For assistant messages, content may be null if there are tool calls
      const textParts = m.content.filter((p) => p.type === "text");
      const toolCalls = m.content.filter((p) => p.type === "tool_call");

      if (textParts.length > 0) {
        msg.content = textParts.map((p) => (p as { text: string }).text).join("");
      } else {
        msg.content = null;
      }

      if (toolCalls.length > 0) {
        msg.tool_calls = toolCalls.map((tc, i) => ({
          index: i,
          id: (tc as { toolCallId: string }).toolCallId,
          type: "function",
          function: {
            name: (tc as { toolName: string }).toolName,
            arguments: JSON.stringify((tc as { arguments: Record<string, unknown> }).arguments),
          },
        }));
      }
    } else if (m.role === "user") {
      // User messages: ContentPart[] -> string (for now)
      // TODO: support image parts
      const textParts = m.content.filter((p) => p.type === "text");
      msg.content = textParts.map((p) => (p as { text: string }).text).join("");
    } else if (m.role === "tool") {
      // Tool result messages
      const toolResult = m.content.filter((p) => p.type === "tool_result")[0];
      if (toolResult) {
        msg.role = "tool";
        msg.tool_call_id = (toolResult as { toolCallId: string }).toolCallId;
        msg.content = String((toolResult as { result: unknown }).result || "");
      }
    } else {
      // Default: extract text
      const textParts = m.content.filter((p) => p.type === "text");
      msg.content = textParts.map((p) => (p as { text: string }).text).join("");
    }

    messages.push(msg);
  }

  return messages;
}

// ============================================================================
// Response parsing: OpenAI -> IR
// ============================================================================

function parseResponse(raw: unknown): IRResponse {
  const obj = raw as Record<string, unknown>;
  const choice = (obj.choices as Record<string, unknown>[])[0];
  const message = choice.message as Record<string, unknown>;

  // Parse content parts
  const content: IRResponse["choices"][0]["message"]["content"] = [];

  // Text content
  if (message.content && message.content !== null) {
    content.push({ type: "text", text: String(message.content) });
  }

  // Tool calls
  if (message.tool_calls && Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls as Record<string, unknown>[]) {
      const fn = tc.function as Record<string, unknown>;
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(String(fn.arguments || "{}")) as Record<string, unknown>;
      } catch {
        args = {};
      }
      content.push({
        type: "tool_call",
        toolCallId: String(tc.id || ""),
        toolName: String(fn.name || ""),
        arguments: args,
      });
    }
  }

  // Refusal
  const refusal = message.refusal ? String(message.refusal) : undefined;

  // Usage
  const usage = obj.usage as Record<string, unknown> | undefined;

  return {
    id: String(obj.id || ""),
    model: String(obj.model || ""),
    choices: [{
      index: Number(choice.index || 0),
      message: {
        role: "assistant",
        content,
        refusal: refusal || null,
      },
      finishReason: String(choice.finish_reason || "unknown") as IRResponse["choices"][0]["finishReason"],
    }],
    usage: usage ? {
      promptTokens: Number(usage.prompt_tokens || 0),
      completionTokens: Number(usage.completion_tokens || 0),
      totalTokens: Number(usage.total_tokens || 0),
    } : undefined,
  };
}

// ============================================================================
// Stream parsing: OpenAI SSE -> StreamEvent
// ============================================================================

function parseStreamChunk(chunk: unknown): StreamEvent | null {
  const obj = chunk as Record<string, unknown>;

  // Check for choices array
  const choices = obj.choices as Record<string, unknown>[] | undefined;
  if (!choices || choices.length === 0) {
    // Usage-only chunk (final chunk with usage)
    if (obj.usage) {
      const usage = obj.usage as Record<string, unknown>;
      return {
        type: "usage",
        usage: {
          promptTokens: Number(usage.prompt_tokens || 0),
          completionTokens: Number(usage.completion_tokens || 0),
          totalTokens: Number(usage.total_tokens || 0),
        },
      };
    }
    return null;
  }

  const choice = choices[0];
  const delta = choice.delta as Record<string, unknown> | undefined;

  if (!delta) {
    // Finish chunk
    if (choice.finish_reason) {
      return {
        type: "finish",
        finishReason: String(choice.finish_reason),
      };
    }
    return null;
  }

  // Text delta
  if (delta.content !== undefined && delta.content !== null) {
    return {
      type: "text_delta",
      index: Number(choice.index || 0),
      delta: String(delta.content),
    };
  }

  // Reasoning content (OpenAI o1 models)
  if (delta.reasoning_content !== undefined) {
    return {
      type: "reasoning_delta",
      index: Number(choice.index || 0),
      delta: String(delta.reasoning_content),
    };
  }

  // Tool call start
  if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
    const tc = (delta.tool_calls as Record<string, unknown>[])[0];
    if (tc) {
      if (tc.id) {
        return {
          type: "tool_call_start",
          index: Number(choice.index || 0),
          toolCallId: String(tc.id),
          toolName: String((tc.function as Record<string, unknown>)?.name || ""),
        };
      }
      // Tool call delta (arguments)
      if (tc.function && (tc.function as Record<string, unknown>).arguments !== undefined) {
        return {
          type: "tool_call_delta",
          index: Number(choice.index || 0),
          toolCallId: "", // Will be filled from previous context
          delta: String((tc.function as Record<string, unknown>).arguments),
        };
      }
    }
  }

  return null;
}

// ============================================================================
// Helpers
// ============================================================================

function isStreamEndMarker(chunk: unknown): boolean {
  const obj = chunk as Record<string, unknown>;
  const choices = obj.choices as Record<string, unknown>[] | undefined;
  if (choices && choices.length > 0) {
    const choice = choices[0];
    return choice.finish_reason !== null && choice.finish_reason !== undefined;
  }
  // [DONE] marker is handled at SSE parser level
  return false;
}

function parseError(raw: unknown): { message: string; type: string; code?: string } {
  const obj = raw as Record<string, unknown>;
  if (obj.error && typeof obj.error === "object") {
    const err = obj.error as Record<string, unknown>;
    return {
      message: String(err.message || "Unknown error"),
      type: String(err.type || "provider_error"),
      code: err.code ? String(err.code) : undefined,
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
    "Authorization": `Bearer ${apiKey}`,
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
  authType: "bearer",
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
