/**
 * OpenCode Go Provider Converter
 *
 * OpenCode Go supports both OpenAI and Anthropic formats.
 * This converter uses the OpenAI-compatible endpoint.
 */

import { registry } from "../../core/converter";
import { OpenAIConverter } from "../openai/converter";

export class OpenCodeGoConverter extends OpenAIConverter {
  readonly providerId = "opencodego" as const;
  readonly providerName = "OpenCode Go";

  getChatCompletionEndpoint(): string {
    const base = this.options.baseUrl || "https://opencode.ai/zen/go/v1";
    return `${base}/chat/completions`;
  }
}

registry.register("opencodego", OpenCodeGoConverter);
