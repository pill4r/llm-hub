/**
 * OpenAI-Compatible Converter
 *
 * Generic converter for ALL OpenAI-compatible providers.
 * Works with: OpenAI, DeepSeek, OpenCode Go, SiliconFlow, Groq, Fireworks, etc.
 *
 * Usage:
 *   new OpenAICompatibleConverter({ baseUrl: "https://api.deepseek.com/v1" })
 *   new OpenAICompatibleConverter({ baseUrl: "https://opencode.ai/zen/go/v1" })
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
  StreamEvent,
  Usage,
} from "../../core/ir";

export class OpenAICompatibleConverter extends BaseConverter {
  readonly providerId: string;
  readonly providerName: string;
  readonly capabilities: ConverterCapabilities = {
    streaming: true,
    tools: true,
    vision: true,
    systemMessages: true,
    reasoning: false,
    jsonMode: true,
    maxContextLength: 128_000,
  };

  constructor(options: ConverterOptions = {}) {
    super(options);
    // Allow override via options
    this.providerId = (options.providerId as string) || "openai-compatible";
    this.providerName = (options.providerName as string) || "OpenAI Compatible";
    if (options.capabilities) {
      Object.assign(this.capabilities, options.capabilities);
    }
  }

  // ========================================================================
  // IR → Provider
  // ========================================================================

  requestToProvider(irRequest: IRRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: irRequest.model,
      messages: irRequest.messages.map((m) => this.messageToProvider(m)),
    };

    if (irRequest.systemInstruction) {
      const msgs = body.messages as unknown[];
      msgs.unshift({ role: "system", content: irRequest.systemInstruction });
    }

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

    if (irRequest.stream?.enabled) {
      body.stream = true;
      if (irRequest.stream.includeUsage) {
        body.stream_options = { include_usage: true };
      }
    }

    if (irRequest.extensions) {
      for (const [key, value] of Object.entries(irRequest.extensions)) {
        if (!(key in body)) body[key] = value;
      }
    }

    return body;
  }

  private messageToProvider(msg: any): Record<string, unknown> {
    const content = this.contentPartsToProvider(msg.content);
    const base: Record<string, unknown> = { role: msg.role, content };

    if (msg.role === "assistant") {
      const toolCalls = msg.content
        .filter((p: any) => p.type === "tool_call")
        .map((p: any, idx: number) => ({
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
        const textParts = msg.content.filter((p: any) => p.type === "text");
        base.content = textParts.length > 0
          ? textParts.map((p: any) => p.text).join("")
          : null;
      }
    }

    if (msg.role === "tool") {
      const toolResult = msg.content.find((p: any) => p.type === "tool_result");
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
    const onlyText = parts.every((p) => p.type === "text");
    if (onlyText) {
      return parts.map((p) => (p as any).text).join("");
    }

    return parts.map((part) => {
      switch (part.type) {
        case "text":
          return { type: "text", text: (part as any).text };
        case "image":
          return {
            type: "image_url",
            image_url: {
              url: (part as any).source.kind === "url"
                ? (part as any).source.url
                : `data:${(part as any).source.mediaType};base64,${(part as any).source.data}`,
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
  // Provider → IR
  // ========================================================================

  responseFromProvider(raw: unknown): IRResponse {
    const res = raw as Record<string, unknown>;
    const choices = res.choices as Record<string, unknown>[] | undefined;
    const choice = choices?.[0] || {};
    const msg = (choice.message || {}) as Record<string, unknown>;

    return {
      id: String(res.id || ""),
      model: String(res.model || ""),
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

    if (typeof msg.content === "string" && msg.content) {
      parts.push({ type: "text", text: msg.content } as any);
    }

    const toolCalls = msg.tool_calls as Record<string, unknown>[] | undefined;
    if (toolCalls) {
      for (const tc of toolCalls) {
        const fn = (tc.function || {}) as Record<string, unknown>;
        parts.push({
          type: "tool_call",
          toolCallId: String(tc.id || ""),
          toolName: String(fn.name || ""),
          arguments: this.safeJsonParse(String(fn.arguments || "{}")),
        } as any);
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
      promptTokens: (u.prompt_tokens || u.promptTokens) || 0,
      completionTokens: (u.completion_tokens || u.completionTokens) || 0,
      totalTokens: (u.total_tokens || u.totalTokens) || 0,
    };
  }

  // ========================================================================
  // Streaming
  // ========================================================================

  streamEventFromProvider(raw: unknown): StreamEvent | null {
    const chunk = raw as Record<string, unknown>;

    if (Object.keys(chunk).length === 0) return null;

    const choices = chunk.choices as any[] | undefined;
    const firstChoice = choices?.[0];
    if (!firstChoice && !chunk.usage) return null;

    const delta = firstChoice?.delta as Record<string, unknown> | undefined;

    if (!delta) {
      if (chunk.usage) {
        return {
          type: "usage",
          usage: this.mapUsage(chunk.usage as Record<string, number>)!,
        };
      }
      return null;
    }

    if (typeof delta.content === "string") {
      return {
        type: "text_delta",
        index: firstChoice.index || 0,
        delta: delta.content,
      };
    }

    if (delta.tool_calls) {
      const tc = (delta.tool_calls as any[])[0];
      if (tc?.function?.name) {
        return {
          type: "tool_call_start",
          index: tc.index as number,
          toolCallId: String(tc.id || ""),
          toolName: String(tc.function.name),
        };
      }
      if (tc?.function?.arguments) {
        return {
          type: "tool_call_delta",
          index: tc.index as number,
          toolCallId: String(tc.id || ""),
          delta: String(tc.function.arguments),
        };
      }
    }

    if (firstChoice?.finish_reason) {
      return {
        type: "finish",
        finishReason: firstChoice.finish_reason as string,
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
    const res = raw as Record<string, unknown>;
    const err = res.error as Record<string, unknown> | undefined;
    return {
      message: String(err?.message || res.message || "Unknown error"),
      type: String(err?.type || res.type || "unknown"),
      code: (err?.code || res.code) as string | undefined,
      status: (err?.status || res.status) as number | undefined,
    };
  }

  // ========================================================================
  // Endpoint & Headers
  // ========================================================================

  getChatCompletionEndpoint(): string {
    const base = this.options.baseUrl || "https://api.openai.com/v1";
    const suffix = (this.options.chatEndpoint as string) || "/chat/completions";
    return `${base.replace(/\/$/, "")}${suffix}`;
  }

  getHeaders(apiKey: string): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    const authType = (this.options.authType as string) || "bearer";

    switch (authType) {
      case "bearer":
        headers["Authorization"] = `Bearer ${apiKey}`;
        break;
      case "api-key":
        headers["api-key"] = apiKey;
        break;
      case "x-api-key":
        headers["x-api-key"] = apiKey;
        break;
    }

    const extra = this.options.extraHeaders as Record<string, string> | undefined;
    if (extra) Object.assign(headers, extra);

    return headers;
  }

  getSupportedModels(): { id: string; name: string }[] {
    const models = this.options.models as { id: string; name: string }[] | undefined;
    return models || [];
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
registry.register("openai-compatible", OpenAICompatibleConverter);
