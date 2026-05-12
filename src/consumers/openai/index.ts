/**
 * OpenAI Consumer Plugin
 *
 * Handles /v1/chat/completions endpoint.
 * Compatible with OpenAI SDK, Claude Code (via OpenAI SDK), Codex CLI, etc.
 */

import { consumerRegistry } from "../types";
import type { ConsumerPlugin, StreamOptions } from "../types";
import type { IRRequest, IRResponse, StreamEvent, ToolDefinition } from "../../core/ir";

const CONSUMER_ID = "openai";
const CONSUMER_NAME = "OpenAI";
const PATHS = ["/v1/chat/completions"];

// ============================================================================
// Request parsing: OpenAI → IR
// ============================================================================

function parseRequest(body: Record<string, unknown>): IRRequest {
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

  // System instruction
  if (body.system_instruction) {
    irRequest.systemInstruction = String(body.system_instruction);
  }

  // Generation config
  const gen: IRRequest["generation"] = {};
  if (body.temperature !== undefined) gen.temperature = Number(body.temperature);
  if (body.top_p !== undefined) gen.topP = Number(body.top_p);
  if (body.max_tokens !== undefined) gen.maxTokens = Number(body.max_tokens);
  if (body.max_completion_tokens !== undefined) gen.maxTokens = Number(body.max_completion_tokens);
  if (body.stop !== undefined) {
    gen.stopSequences = Array.isArray(body.stop) ? body.stop as string[] : [String(body.stop)];
  }
  if (body.frequency_penalty !== undefined) gen.frequencyPenalty = Number(body.frequency_penalty);
  if (body.presence_penalty !== undefined) gen.presencePenalty = Number(body.presence_penalty);
  if (body.seed !== undefined) gen.seed = Number(body.seed);
  if (Object.keys(gen).length > 0) irRequest.generation = gen;

  // Tools
  if (body.tools && Array.isArray(body.tools) && body.tools.length > 0) {
    irRequest.tools = (body.tools as Record<string, unknown>[]).map((t) => {
      const fn = t.function as Record<string, unknown>;
      return {
        name: String(fn.name),
        description: String(fn.description || ""),
        parameters: (fn.parameters || { type: "object" }) as unknown as ToolDefinition["parameters"],
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

  // Response format
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

  // Stream
  if (body.stream) {
    irRequest.stream = {
      enabled: true,
      includeUsage: !!(body.stream_options as Record<string, unknown>)?.include_usage,
    };
  }

  return irRequest;
}

// ============================================================================
// Response building: IR → OpenAI
// ============================================================================

function buildResponse(ir: IRResponse): Record<string, unknown> {
  const choice = ir.choices[0];
  const textParts = choice.message.content.filter((p) => p.type === "text");
  const toolCalls = choice.message.content.filter((p) => p.type === "tool_call");

  const message: Record<string, unknown> = {
    role: "assistant",
    content: textParts.map((p) => (p as { text: string }).text).join("") || null,
  };

  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls.map((tc, i) => ({
      index: i,
      id: (tc as { toolCallId: string }).toolCallId,
      type: "function",
      function: {
        name: (tc as { toolName: string }).toolName,
        arguments: JSON.stringify((tc as { arguments: Record<string, unknown> }).arguments),
      },
    }));
  }

  const response: Record<string, unknown> = {
    id: ir.id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: ir.model,
    choices: [{
      index: choice.index,
      message,
      finish_reason: choice.finishReason,
    }],
  };

  // Convert IR usage format to OpenAI format
  if (ir.usage) {
    response.usage = {
      prompt_tokens: ir.usage.promptTokens,
      completion_tokens: ir.usage.completionTokens,
      total_tokens: ir.usage.totalTokens,
    };
  }

  return response;
}

// ============================================================================
// Stream building: IR → OpenAI SSE
// ============================================================================

function buildStreamChunk(event: StreamEvent, options: StreamOptions): string | null {
  const { model, id } = options;
  const created = Math.floor(Date.now() / 1000);

  switch (event.type) {
    case "stream_start":
      return null;

    case "text_delta": {
      const chunk = {
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
      return `data: ${JSON.stringify(chunk)}\n\n`;
    }

    case "reasoning_delta": {
      const chunk = {
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
      return `data: ${JSON.stringify(chunk)}\n\n`;
    }

    case "tool_call_start": {
      const chunk = {
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
      return `data: ${JSON.stringify(chunk)}\n\n`;
    }

    case "tool_call_delta": {
      const chunk = {
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
      return `data: ${JSON.stringify(chunk)}\n\n`;
    }

    case "finish": {
      const chunk = {
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
      return `data: ${JSON.stringify(chunk)}\n\n`;
    }

    case "usage": {
      const chunk = {
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
      return `data: ${JSON.stringify(chunk)}\n\n`;
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
    error: {
      message: error.message,
      type: error.type,
      code: error.code,
    },
  };
}

// ============================================================================
// Helpers
// ============================================================================

function detect(path: string, _headers: Headers, body: Record<string, unknown>): boolean {
  return PATHS.includes(path) || Array.isArray(body.messages);
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
