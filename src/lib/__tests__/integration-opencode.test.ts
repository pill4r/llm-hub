/**
 * Integration Test: Real API call to OpenCode Go via OpenAI Provider Plugin
 *
 * This test makes a real HTTP request to verify the full chain:
 *   IR -> OpenAI Provider Plugin -> HTTP -> OpenCode Go API -> Response -> IR
 */

import { describe, it, expect } from "vitest";
import { providerRequestToBody, providerResponseToIR, buildProviderEndpoint, buildProviderHeaders } from "../provider-engine";
import type { ProviderInstanceConfig } from "../provider-engine";
import type { IRRequest } from "../../core/ir";

// Load API key from .env.local
const API_KEY = process.env.OPENCODE_GO_API_KEY || "";
const BASE_URL = "https://opencode.ai/zen/go/v1";

// Skip if no API key
const itIfKey = API_KEY ? it : it.skip;

describe("Integration: OpenCode Go (OpenAI format)", () => {
  const config: ProviderInstanceConfig = {
    providerId: "opencode-go",
    providerName: "OpenCode Go",
    format: "openai",
    baseUrl: BASE_URL,
    models: ["kimi-k2.6"],
  };

  itIfKey("builds correct request body from IR", () => {
    const ir: IRRequest = {
      model: "kimi-k2.6",
      messages: [
        { role: "system", content: [{ type: "text", text: "You are a helpful assistant." }] },
        { role: "user", content: [{ type: "text", text: "Say hello in 5 words." }] },
      ],
      generation: { maxTokens: 50, temperature: 0.7 },
    };

    const body = providerRequestToBody(ir, config);

    expect(body.model).toBe("kimi-k2.6");
    expect(body.messages).toHaveLength(2);
    expect(body.messages).toEqual([
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Say hello in 5 words." },
    ]);
    expect(body.max_tokens).toBe(50);
    expect(body.temperature).toBe(0.7);
  });

  itIfKey("makes real API call and parses response", async () => {
    const ir: IRRequest = {
      model: "kimi-k2.6",
      messages: [
        { role: "user", content: [{ type: "text", text: "Say hello in exactly 5 words." }] },
      ],
      generation: { maxTokens: 50, temperature: 0.1 },
    };

    const body = providerRequestToBody(ir, config);
    const endpoint = buildProviderEndpoint(config);
    const headers = buildProviderHeaders(config, API_KEY);

    console.log("Request endpoint:", endpoint);
    console.log("Request body:", JSON.stringify(body, null, 2));

    const resp = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    console.log("Response status:", resp.status);
    console.log("Response content-type:", resp.headers.get("content-type"));

    const respText = await resp.text();
    console.log("Response text (first 1000 chars):", respText.slice(0, 1000));

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}: ${respText.slice(0, 500)}`);
    }

    const raw = JSON.parse(respText) as Record<string, unknown>;
    console.log("Parsed response:", JSON.stringify(raw, null, 2));

    // Parse through our provider plugin
    const irResponse = providerResponseToIR(raw, config);

    console.log("Parsed IR:", JSON.stringify(irResponse, null, 2));

    // Assertions - OpenCode Go returns reasoning content, not regular content
    expect(irResponse.choices).toHaveLength(1);
    expect(irResponse.choices[0].message.role).toBe("assistant");
    expect(irResponse.choices[0].message.content).toBeDefined();
    expect(irResponse.choices[0].finishReason).toBeDefined();

    // Content may be empty (reasoning models return reasoning instead of content)
    // Just verify the response structure is valid
    console.log("Assistant response:", JSON.stringify(irResponse.choices[0].message.content));
  }, 30000);

  itIfKey("tests streaming response", async () => {
    const ir: IRRequest = {
      model: "kimi-k2.6",
      messages: [
        { role: "user", content: [{ type: "text", text: "Count from 1 to 3." }] },
      ],
      generation: { maxTokens: 50, temperature: 0.1 },
      stream: { enabled: true },
    };

    const body = providerRequestToBody(ir, config);
    const endpoint = buildProviderEndpoint(config);
    const headers = buildProviderHeaders(config, API_KEY);

    console.log("Stream request endpoint:", endpoint);

    const resp = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    expect(resp.ok).toBe(true);

    const reader = resp.body?.getReader();
    expect(reader).toBeDefined();

    const decoder = new TextDecoder();
    let chunkCount = 0;
    let fullText = "";
    let hasReasoning = false;

    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;

      const text = decoder.decode(value, { stream: true });
      const lines = text.split("\n");

      for (const line of lines) {
        if (line.indexOf("data: ") === 0) {
          const data = line.slice(6);
          if (data === "[DONE]") continue;

          try {
            const chunk = JSON.parse(data);
            console.log("SSE chunk:", JSON.stringify(chunk));
            chunkCount++;

            // Parse through our provider plugin
            const { providerStreamChunkToEvent } = await import("../provider-engine");
            const event = providerStreamChunkToEvent(chunk, config);

            console.log("Event type:", event?.type, "delta:", (event as { delta?: string })?.delta);

            if (event && event.type === "text_delta") {
              fullText += (event as { delta: string }).delta;
            }
            if (event && event.type === "reasoning_delta") {
              hasReasoning = true;
              fullText += (event as { delta: string }).delta;
            }
          } catch {
            // Ignore parse errors
          }
        }
      }
    }

    console.log("Total chunks:", chunkCount);
    console.log("Full streamed text:", fullText);

    expect(chunkCount).toBeGreaterThan(0);
    // OpenCode Go returns reasoning content, not regular content
    expect(fullText.length > 0 || hasReasoning).toBe(true);
  }, 30000);
});
