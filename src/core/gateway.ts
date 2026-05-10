/**
 * Gateway Core
 *
 * Minimal routing layer. Consumer plugins handle format conversion.
 * This file only contains provider forwarding and stream normalization.
 */

import type { BaseConverter } from "./converter";
import type { IRRequest, StreamEvent } from "./ir";

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
 *   3. Default provider
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

/**
 * Forward IR request to provider.
 */
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

/**
 * Stream events from provider, normalizing SSE to IR StreamEvent.
 */
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

        // Anthropic-style typed SSE: "event: xxx" then "data: xxx"
        if (trimmed.startsWith("event: ")) {
          // Store event type for next data line
          // Some converters need this state (like Anthropic)
          // We pass the full line to the converter
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

          // Check if converter signals stream end
          if (converter.isStreamEnd(chunk)) {
            return;
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
