/**
 * Gateway Core
 *
 * Routes requests to the appropriate provider using IR conversion.
 */

import type { Context } from "hono";
import type { BaseConverter } from "./converter";
import type { IRRequest } from "./ir";
import { registry } from "./converter";

export interface GatewayEnv {
  KV: KVNamespace;
  DB: D1Database;
}

export interface GatewayConfig {
  /** Timeout for provider requests (ms) */
  timeout: number;
  /** Max retries */
  maxRetries: number;
  /** Whether to enable streaming */
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
  // 1. Header
  const providerHeader = headers.get("x-hub-provider");
  if (providerHeader) {
    return { providerId: providerHeader, model: bodyModel };
  }

  // 2. Model prefix (e.g., "openai:gpt-4o", "deepseek:deepseek-chat")
  if (bodyModel.includes(":")) {
    const [providerId, ...modelParts] = bodyModel.split(":");
    return { providerId, model: modelParts.join(":") };
  }

  // 3. Default to openai
  return { providerId: "openai", model: bodyModel };
}

/**
 * Build an IR request from the incoming OpenAI-compatible request body.
 */
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

  // System instruction
  if (body.system_instruction) {
    irRequest.systemInstruction = String(body.system_instruction);
  }

  // Generation config
  const gen: IRRequest["generation"] = {};
  if (body.temperature !== undefined) gen.temperature = Number(body.temperature);
  if (body.top_p !== undefined) gen.topP = Number(body.top_p);
  if (body.max_tokens !== undefined) gen.maxTokens = Number(body.max_tokens);
  if (body.stop !== undefined) gen.stopSequences = Array.isArray(body.stop) ? body.stop as string[] : [String(body.stop)];
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

/**
 * Convert an IR response back to OpenAI-compatible format.
 */
export function toOpenAIFormat(irResponse: IRRequest["messages"][0]["content"], model: string, id: string): Record<string, unknown> {
  // This is used for building the final response
  // Actual implementation is in the route handler
  return {};
}

/**
 * Forward a request to the provider and return the response.
 */
export async function forwardToProvider(
  converter: BaseConverter,
  irRequest: IRRequest,
  apiKey: string,
  config: GatewayConfig = DEFAULT_CONFIG
): Promise<Response> {
  const providerBody = converter.requestToProvider(irRequest);
  const endpoint = converter.getChatCompletionEndpoint();
  const headers = converter.getHeaders(apiKey);

  return fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(providerBody),
  });
}

/**
 * Stream a response from the provider, converting chunks on the fly.
 */
export async function* streamFromProvider(
  converter: BaseConverter,
  response: Response
): AsyncGenerator<string, void, unknown> {
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
        if (!trimmed || !trimmed.startsWith("data: ")) continue;

        const data = trimmed.slice(6);
        if (data === "[DONE]") {
          yield "data: [DONE]\n\n";
          return;
        }

        try {
          const chunk = JSON.parse(data);
          const event = converter.streamEventFromProvider(chunk);

          if (event) {
            // Convert IR event back to OpenAI SSE format
            const sseChunk = convertEventToOpenAI(event, chunk);
            if (sseChunk) {
              yield `data: ${JSON.stringify(sseChunk)}\n\n`;
            }
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

/**
 * Convert an IR stream event back to OpenAI SSE chunk format.
 */
function convertEventToOpenAI(event: NonNullable<ReturnType<BaseConverter["streamEventFromProvider"]>>, rawChunk: Record<string, unknown>): Record<string, unknown> | null {
  switch (event.type) {
    case "text_delta": {
      return {
        id: rawChunk.id || "chatcmpl-llmhub",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: rawChunk.model || "unknown",
        choices: [{
          index: event.index,
          delta: { content: event.delta },
          finish_reason: null,
        }],
      };
    }

    case "tool_call_start": {
      return {
        id: rawChunk.id || "chatcmpl-llmhub",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: rawChunk.model || "unknown",
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
    }

    case "tool_call_delta": {
      return {
        id: rawChunk.id || "chatcmpl-llmhub",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: rawChunk.model || "unknown",
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
    }

    case "finish": {
      return {
        id: rawChunk.id || "chatcmpl-llmhub",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: rawChunk.model || "unknown",
        choices: [{
          index: 0,
          delta: {},
          finish_reason: event.finishReason,
        }],
      };
    }

    case "usage": {
      return {
        id: rawChunk.id || "chatcmpl-llmhub",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: rawChunk.model || "unknown",
        choices: [],
        usage: {
          prompt_tokens: event.usage.promptTokens,
          completion_tokens: event.usage.completionTokens,
          total_tokens: event.usage.totalTokens,
        },
      };
    }

    default:
      return null;
  }
}
