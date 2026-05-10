/**
 * OpenAI Converter
 *
 * Converts between OpenAI Chat Completions API format and IR.
 */

import {
  BaseConverter,
  type ConverterCapabilities,
  type ConverterOptions,
  registry,
} from "../../core/converter";
import type {
  ContentPart,
  IRRequest,
  IRResponse,
  Message,
  StreamEvent,
  Usage,
} from "../../core/ir";

export class OpenAIConverter extends BaseConverter {
  readonly providerId = "openai";
  readonly providerName = "OpenAI";

  readonly capabilities: ConverterCapabilities = {
    streaming: true,
    tools: true,
    vision: true,
    systemMessages: true,
    reasoning: false,
    jsonMode: true,
    maxContextLength: 128_000,
  };

  // ========================================================================
  // IR → OpenAI
  // ========================================================================

  requestToProvider(irRequest: IRRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: irRequest.model,
      messages: irRequest.messages.map((m) => this.messageToProvider(m)),
    };

    // System instruction (use as first system message)
    if (irRequest.systemInstruction) {
      const msgs = body.messages as unknown[];
      msgs.unshift({ role: "system", content: irRequest.systemInstruction });
    }

    // Generation config
    if (irRequest.generation) {
      const g = irRequest.generation;
      if (g.temperature !== undefined) body.temperature = g.temperature;
      if (g.topP !== undefined) body.top_p = g.topP;
      if (g.maxTokens !== undefined) body.max_tokens = g.maxTokens;
      if (g.stopSequences !== undefined) body.stop = g.stopSequences;
      if (g.frequencyPenalty !== undefined) body.frequency_penalty = g.frequencyPenalty;
      if (g.presencePenalty !== undefined) body.presence_penalty = g.presencePenalty;
      if (g.seed !== undefined) body.seed = g.seed;
    }

    // Tools
    if (irRequest.tools && irRequest.tools.length > 0) {
      body.tools = irRequest.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
      if (irRequest.toolChoice) {
        body.tool_choice = this.toolChoiceToProvider(irRequest.toolChoice);
      }
    }

    // Response format
    if (irRequest.responseFormat) {
      const rf = irRequest.responseFormat;
      if (rf.type === "json") {
        body.response_format = { type: "json_object" };
      } else if (rf.type === "json_schema") {
        body.response_format = {
          type: "json_schema",
          json_schema: {
            name: rf.jsonSchema!.name,
            description: rf.jsonSchema!.description,
            schema: rf.jsonSchema!.schema,
            strict: rf.jsonSchema!.strict,
          },
        };
      }
    }

    // Stream
    if (irRequest.stream?.enabled) {
      body.stream = true;
      if (irRequest.stream.includeUsage) {
        body.stream_options = { include_usage: true };
      }
    }

    // Extensions
    if (irRequest.extensions) {
      for (const [key, value] of Object.entries(irRequest.extensions)) {
        if (!(key in body)) body[key] = value;
      }
    }

    return body;
  }

  private messageToProvider(msg: Message): Record<string, unknown> {
    const content = this.contentPartsToProvider(msg.content);
    const base: Record<string, unknown> = { role: msg.role, content };

    // Handle tool calls in assistant messages
    if (msg.role === "assistant") {
      const toolCalls = msg.content
        .filter((p) => p.type === "tool_call")
        .map((p, idx) => ({
          id: p.toolCallId,
          type: "function",
          function: {
            name: p.toolName,
            arguments: JSON.stringify(p.arguments),
          },
          index: idx,
        }));
      if (toolCalls.length > 0) {
        base.tool_calls = toolCalls;
        // Remove tool_call parts from content (OpenAI uses separate tool_calls field)
        const textParts = msg.content.filter((p) => p.type === "text");
        base.content = textParts.length > 0
          ? textParts.map((p) => (p as { text: string }).text).join("")
          : null;
      }
    }

    // Handle tool results
    if (msg.role === "tool") {
      const toolResult = msg.content.find((p) => p.type === "tool_result");
      if (toolResult) {
        base.tool_call_id = toolResult.toolCallId;
        base.content = typeof toolResult.result === "string"
          ? toolResult.result
          : JSON.stringify(toolResult.result);
      }
    }

    return base;
  }

  private contentPartsToProvider(parts: ContentPart[]): string | unknown[] {
    // If only text parts, return as string
    const onlyText = parts.every((p) => p.type === "text");
    if (onlyText) {
      return parts.map((p) => (p as { text: string }).text).join("");
    }

    // Mixed content (vision, etc.)
    return parts.map((part) => {
      switch (part.type) {
        case "text":
          return { type: "text", text: part.text };
        case "image":
          return {
            type: "image_url",
            image_url: {
              url: part.source.kind === "url"
                ? part.source.url
                : `data:${part.source.mediaType};base64,${part.source.data}`,
            },
          };
        default:
          return { type: "text", text: "" };
      }
    });
  }

  private toolChoiceToProvider(tc: string | { type: "tool"; name: string }): unknown {
    if (typeof tc === "string") return tc;
    return { type: "function", function: { name: tc.name } };
  }

  // ========================================================================
  // OpenAI → IR
  // ========================================================================

  responseFromProvider(raw: unknown): IRResponse {
    const res = raw as Record<string, unknown>;
    const choice = (res.choices as Record<string, unknown>[])[0];
    const msg = choice.message as Record<string, unknown>;

    return {
      id: String(res.id),
      model: String(res.model),
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: this.parseContent(msg),
          refusal: msg.refusal as string | null | undefined,
        },
        finishReason: this.mapFinishReason(choice.finish_reason as string),
      }],
      usage: this.mapUsage(res.usage as Record<string, number> | undefined),
      _raw: res,
    };
  }

  private parseContent(msg: Record<string, unknown>): ContentPart[] {
    const parts: ContentPart[] = [];

    // Text content
    if (typeof msg.content === "string" && msg.content) {
      parts.push({ type: "text", text: msg.content });
    }

    // Tool calls
    const toolCalls = msg.tool_calls as Record<string, unknown>[] | undefined;
    if (toolCalls) {
      for (const tc of toolCalls) {
        const fn = tc.function as Record<string, unknown>;
        parts.push({
          type: "tool_call",
          toolCallId: String(tc.id),
          toolName: String(fn.name),
          arguments: this.safeJsonParse(String(fn.arguments)),
        });
      }
    }

    return parts;
  }

  private mapFinishReason(reason?: string): IRResponse["choices"][0]["finishReason"] {
    switch (reason) {
      case "stop": return "stop";
      case "length": return "length";
      case "tool_calls": return "tool_calls";
      case "content_filter": return "content_filter";
      default: return "unknown";
    }
  }

  private mapUsage(u?: Record<string, number>): Usage | undefined {
    if (!u) return undefined;
    return {
      promptTokens: u.prompt_tokens || 0,
      completionTokens: u.completion_tokens || 0,
      totalTokens: u.total_tokens || 0,
    };
  }

  // ========================================================================
  // Streaming
  // ========================================================================

  streamEventFromProvider(raw: unknown): StreamEvent | null {
    const chunk = raw as Record<string, unknown>;

    // Skip [DONE] sentinel
    if (Object.keys(chunk).length === 0) return null;

    const delta = chunk.choices?.[0]?.delta as Record<string, unknown> | undefined;
    if (!delta) {
      // Usage-only chunk
      if (chunk.usage) {
        return {
          type: "usage",
          usage: this.mapUsage(chunk.usage as Record<string, number>)!,
        };
      }
      return null;
    }

    // Text delta
    if (typeof delta.content === "string") {
      return {
        type: "text_delta",
        index: chunk.choices[0].index || 0,
        delta: delta.content,
      };
    }

    // Tool call delta
    if (delta.tool_calls) {
      const tc = delta.tool_calls[0] as Record<string, unknown>;
      if (tc.function?.name) {
        return {
          type: "tool_call_start",
          index: tc.index as number,
          toolCallId: String(tc.id),
          toolName: String(tc.function.name),
        };
      }
      if (tc.function?.arguments) {
        return {
          type: "tool_call_delta",
          index: tc.index as number,
          toolCallId: String(tc.id),
          delta: String(tc.function.arguments),
        };
      }
    }

    // Finish
    if (chunk.choices?.[0]?.finish_reason) {
      return {
        type: "finish",
        finishReason: chunk.choices[0].finish_reason as string,
      };
    }

    return null;
  }

  isStreamEnd(chunk: unknown): boolean {
    return Object.keys(chunk as Record<string, unknown>).length === 0;
  }

  // ========================================================================
  // Error
  // ========================================================================

  parseError(raw: unknown): { message: string; type: string; code?: string; status?: number } {
    const err = (raw as Record<string, unknown>)?.error as Record<string, unknown> | undefined;
    return {
      message: String(err?.message || "Unknown error"),
      type: String(err?.type || "unknown"),
      code: err?.code as string | undefined,
    };
  }

  // ========================================================================
  // Endpoint & Headers
  // ========================================================================

  getChatCompletionEndpoint(): string {
    return `${this.options.baseUrl || "https://api.openai.com/v1"}/chat/completions`;
  }

  getHeaders(apiKey: string): Record<string, string> {
    return {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };
  }

  // ========================================================================
  // Helpers
  // ========================================================================

  private safeJsonParse(str: string): Record<string, unknown> {
    try {
      return JSON.parse(str) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
}

// Register
registry.register("openai", OpenAIConverter);
