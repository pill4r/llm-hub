/**
 * DeepSeek Converter
 *
 * DeepSeek uses the OpenAI-compatible API format.
 * We extend OpenAIConverter with DeepSeek-specific adjustments.
 */

import { OpenAIConverter } from "../openai/converter";
import { registry } from "../../core/converter";
import type { ConverterCapabilities } from "../../core/converter";

export class DeepSeekConverter extends OpenAIConverter {
  readonly providerId = "deepseek";
  readonly providerName = "DeepSeek";

  readonly capabilities: ConverterCapabilities = {
    streaming: true,
    tools: true,
    vision: false, // DeepSeek V3 does not support vision
    systemMessages: true,
    reasoning: true, // DeepSeek R1 supports reasoning
    jsonMode: true,
    maxContextLength: 64_000,
  };

  getChatCompletionEndpoint(): string {
    return `${this.options.baseUrl || "https://api.deepseek.com/v1"}/chat/completions`;
  }

  getHeaders(apiKey: string): Record<string, string> {
    return {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };
  }
}

// Register
registry.register("deepseek", DeepSeekConverter);
