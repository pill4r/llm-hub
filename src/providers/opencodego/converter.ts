/**
 * OpenCode Go Converter
 *
 * OpenCode Go provides OpenAI-compatible chat completions endpoint.
 * Base URL: https://opencode.ai/zen/go/v1
 *
 * Supported models (chat/completions):
 *   glm-5.1, glm-5, kimi-k2.5, kimi-k2.6,
 *   deepseek-v4-pro, deepseek-v4-flash,
 *   mimo-v2.5, mimo-v2.5-pro,
 *   qwen3.6-plus, qwen3.5-plus
 *
 * Note: MiniMax models (minimax-m2.7, minimax-m2.5) use /messages (Anthropic
 * format) and are not yet supported by this converter.
 */

import { OpenAIConverter } from "../openai/converter";
import { registry } from "../../core/converter";
import type { ConverterCapabilities } from "../../core/converter";

export class OpenCodeGoConverter extends OpenAIConverter {
  readonly providerId = "opencode-go";
  readonly providerName = "OpenCode Go";

  readonly capabilities: ConverterCapabilities = {
    streaming: true,
    tools: true,
    vision: true,
    systemMessages: true,
    reasoning: true,
    jsonMode: true,
    maxContextLength: 256_000,
  };

  getChatCompletionEndpoint(): string {
    return `${this.options.baseUrl || "https://opencode.ai/zen/go/v1"}/chat/completions`;
  }

  getHeaders(apiKey: string): Record<string, string> {
    return {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };
  }

  getSupportedModels(): { id: string; name: string }[] {
    return [
      { id: "glm-5.1", name: "GLM 5.1" },
      { id: "glm-5", name: "GLM 5" },
      { id: "kimi-k2.5", name: "Kimi K2.5" },
      { id: "kimi-k2.6", name: "Kimi K2.6" },
      { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
      { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
      { id: "mimo-v2.5", name: "MiMo V2.5" },
      { id: "mimo-v2.5-pro", name: "MiMo V2.5 Pro" },
      { id: "qwen3.6-plus", name: "Qwen 3.6 Plus" },
      { id: "qwen3.5-plus", name: "Qwen 3.5 Plus" },
    ];
  }
}

// Register
registry.register("opencode-go", OpenCodeGoConverter);
