/**
 * Gateway Core
 *
 * Minimal routing layer. Consumer plugins handle format conversion.
 * This file only contains provider forwarding and stream normalization.
 */

import type { IRRequest, StreamEvent } from "./ir";
import type { ProviderInstanceConfig } from "../lib/provider-engine";
import {
  providerRequestToBody,
  buildProviderEndpoint,
  buildProviderHeaders,
  providerStreamChunkToEvent,
  isStreamEndMarker,
} from "../lib/provider-engine";

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
 *   3. Model-to-provider mapping (find provider that supports this model)
 *   4. Default provider
 */
export function resolveTarget(
  headers: Headers,
  bodyModel: string,
  providerConfigs?: { providerId: string; models: string[] }[],
  allowedProviders?: string[]
): { providerId: string; model: string } {
  const providerHeader = headers.get("x-hub-provider");
  if (providerHeader) {
    return { providerId: providerHeader, model: bodyModel };
  }

  if (bodyModel.includes(":")) {
    const [providerId, ...modelParts] = bodyModel.split(":");
    return { providerId, model: modelParts.join(":") };
  }

  // Try to find provider by model name
  if (providerConfigs && providerConfigs.length > 0) {
    for (const config of providerConfigs) {
      // Check if provider is allowed
      if (allowedProviders && allowedProviders.length > 0) {
        if (!allowedProviders.includes(config.providerId)) {
          continue;
        }
      }
      // Check if provider supports this model
      if (config.models.includes(bodyModel)) {
        return { providerId: config.providerId, model: bodyModel };
      }
    }
  }

  return { providerId: "openai", model: bodyModel };
}

/**
 * Forward IR request to provider.
 */
export async function forwardToProvider(
  config: ProviderInstanceConfig,
  irRequest: IRRequest,
  apiKey: string,
  gatewayConfig: GatewayConfig = DEFAULT_CONFIG
): Promise<Response> {
  const providerBody = providerRequestToBody(irRequest, config);
  const endpoint = buildProviderEndpoint(config, irRequest.model);
  const headers = buildProviderHeaders(config, apiKey);

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
  config: ProviderInstanceConfig,
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
          continue;
        }

        if (!trimmed.startsWith("data: ")) continue;

        const data = trimmed.slice(6);
        if (data === "[DONE]") {
          return;
        }

        try {
          const chunk = JSON.parse(data);
          const event = providerStreamChunkToEvent(chunk, config);
          if (event) {
            yield { event, raw: chunk };
          }

          if (isStreamEndMarker(chunk, config)) {
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
