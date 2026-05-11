/**
 * Cross-Access Tests
 *
 * Verify that any consumer format can access any provider format.
 * This is the core value proposition of the hub-and-spoke IR architecture.
 */

import { describe, it, expect } from "vitest";
import { providerRequestToBody, providerResponseToIR, providerStreamChunkToEvent } from "../provider-engine";
import type { ProviderInstanceConfig } from "../provider-engine";
import type { IRRequest, StreamEvent } from "../../core/ir";

// ========================================================================
// Helpers: Create consumer IR requests
// ========================================================================

function createOpenAIConsumerIR(): IRRequest {
  return {
    model: "gpt-4o",
    messages: [
      { role: "system", content: [{ type: "text", text: "You are helpful." }] },
      { role: "user", content: [{ type: "text", text: "Hello!" }] },
    ],
    generation: { maxTokens: 100, temperature: 0.7 },
  };
}

function createAnthropicConsumerIR(): IRRequest {
  return {
    model: "claude-3-sonnet",
    messages: [
      { role: "user", content: [{ type: "text", text: "Hello!" }] },
    ],
    systemInstruction: "You are helpful.",
    generation: { maxTokens: 100, temperature: 0.7 },
  };
}

// ========================================================================
// Test 1: OpenAI Consumer -> OpenAI Provider
// ========================================================================

describe("OpenAI Consumer -> OpenAI Provider", () => {
  const config: ProviderInstanceConfig = {
    providerId: "openai",
    providerName: "OpenAI",
    format: "openai",
    models: ["gpt-4o"],
  };

  it("converts IR to OpenAI request format", () => {
    const ir = createOpenAIConsumerIR();
    const body = providerRequestToBody(ir, config);

    expect(body.model).toBe("gpt-4o");
    expect(body.messages).toHaveLength(2);
    expect(body.messages).toEqual([
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello!" },
    ]);
    expect(body.max_tokens).toBe(100);
    expect(body.temperature).toBe(0.7);
  });

  it("converts OpenAI response to IR", () => {
    const providerResponse = {
      id: "chatcmpl-123",
      model: "gpt-4o",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: "Hi there!",
        },
        finish_reason: "stop",
      }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      },
    };

    const ir = providerResponseToIR(providerResponse, config);
    expect(ir.choices).toHaveLength(1);
    expect(ir.choices[0].message.content).toEqual([{ type: "text", text: "Hi there!" }]);
    expect(ir.choices[0].finishReason).toBe("stop");
    expect(ir.usage?.promptTokens).toBe(10);
    expect(ir.usage?.completionTokens).toBe(5);
    expect(ir.usage?.totalTokens).toBe(15);
  });
});

// ========================================================================
// Test 2: Anthropic Consumer -> Anthropic Provider
// ========================================================================

describe("Anthropic Consumer -> Anthropic Provider", () => {
  const config: ProviderInstanceConfig = {
    providerId: "anthropic",
    providerName: "Anthropic",
    format: "anthropic",
    models: ["claude-3-sonnet"],
  };

  it("converts IR to Anthropic request format", () => {
    const ir = createAnthropicConsumerIR();
    const body = providerRequestToBody(ir, config);

    expect(body.model).toBe("claude-3-sonnet");
    expect(body.messages).toHaveLength(1);
    expect(body.messages).toEqual([
      { role: "user", content: "Hello!" },
    ]);
    expect(body.max_tokens).toBe(100);
    expect(body.temperature).toBe(0.7);
  });

  it("converts Anthropic response to IR", () => {
    const providerResponse = {
      id: "msg_123",
      model: "claude-3-sonnet",
      content: [{ type: "text", text: "Hi there!" }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 10,
        output_tokens: 5,
      },
    };

    const ir = providerResponseToIR(providerResponse, config);
    expect(ir.choices).toHaveLength(1);
    expect(ir.choices[0].message.content).toEqual([{ type: "text", text: "Hi there!" }]);
    expect(ir.choices[0].finishReason).toBe("stop");
    expect(ir.usage?.promptTokens).toBe(10);
    expect(ir.usage?.completionTokens).toBe(5);
  });
});

// ========================================================================
// Test 3: OpenAI Consumer -> Anthropic Provider (CROSS)
// ========================================================================

describe("OpenAI Consumer -> Anthropic Provider (CROSS)", () => {
  const config: ProviderInstanceConfig = {
    providerId: "anthropic",
    providerName: "Anthropic",
    format: "anthropic",
    models: ["claude-3-sonnet"],
  };

  it("converts OpenAI-style IR to Anthropic request format", () => {
    // OpenAI consumer produces IR with system as first message
    const ir = createOpenAIConsumerIR();
    const body = providerRequestToBody(ir, config);

    expect(body.model).toBe("gpt-4o");
    // Anthropic format: system instruction should be extracted
    expect(body.messages).toHaveLength(1); // system message removed, only user remains
    expect(body.messages).toEqual([
      { role: "user", content: "Hello!" },
    ]);
    expect(body.max_tokens).toBe(100);
    expect(body.temperature).toBe(0.7);
  });

  it("converts Anthropic response to IR for OpenAI consumer", () => {
    const providerResponse = {
      id: "msg_123",
      model: "claude-3-sonnet",
      content: [{ type: "text", text: "Hello from Claude!" }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 10,
        output_tokens: 5,
      },
    };

    const ir = providerResponseToIR(providerResponse, config);
    // IR is format-agnostic, can be consumed by OpenAI consumer's buildResponse()
    expect(ir.choices).toHaveLength(1);
    expect(ir.choices[0].message.content).toEqual([{ type: "text", text: "Hello from Claude!" }]);
    expect(ir.choices[0].finishReason).toBe("stop");
  });
});

// ========================================================================
// Test 4: Anthropic Consumer -> OpenAI Provider (CROSS)
// ========================================================================

describe("Anthropic Consumer -> OpenAI Provider (CROSS)", () => {
  const config: ProviderInstanceConfig = {
    providerId: "openai",
    providerName: "OpenAI",
    format: "openai",
    models: ["gpt-4o"],
  };

  it("converts Anthropic-style IR to OpenAI request format", () => {
    // Anthropic consumer produces IR with systemInstruction
    const ir = createAnthropicConsumerIR();
    const body = providerRequestToBody(ir, config);

    expect(body.model).toBe("claude-3-sonnet");
    // OpenAI format: system instruction should be prepended as system message
    expect(body.messages).toHaveLength(2);
    expect(body.messages).toEqual([
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello!" },
    ]);
    expect(body.max_tokens).toBe(100);
    expect(body.temperature).toBe(0.7);
  });

  it("converts OpenAI response to IR for Anthropic consumer", () => {
    const providerResponse = {
      id: "chatcmpl-123",
      model: "gpt-4o",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: "Hello from GPT!",
        },
        finish_reason: "stop",
      }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      },
    };

    const ir = providerResponseToIR(providerResponse, config);
    // IR is format-agnostic, can be consumed by Anthropic consumer's buildResponse()
    expect(ir.choices).toHaveLength(1);
    expect(ir.choices[0].message.content).toEqual([{ type: "text", text: "Hello from GPT!" }]);
    expect(ir.choices[0].finishReason).toBe("stop");
  });
});

// ========================================================================
// Test 5: Stream Events Cross-Access
// ========================================================================

describe("Stream Events Cross-Access", () => {
  it("OpenAI stream chunk -> IR (for Anthropic consumer)", () => {
    const chunk = {
      choices: [{
        index: 0,
        delta: { content: "Hello" },
      }],
    };

    const config: ProviderInstanceConfig = {
      providerId: "openai",
      providerName: "OpenAI",
      format: "openai",
      models: ["gpt-4o"],
    };
    const event = providerStreamChunkToEvent(chunk, config);

    expect(event).not.toBeNull();
    expect(event!.type).toBe("text_delta");
    expect((event as any).delta).toBe("Hello");
  });

  it("Anthropic stream chunk -> IR (for OpenAI consumer)", () => {
    const chunk = {
      type: "content_block_delta",
      index: 0,
      delta: { text: "Hello" },
    };

    const config: ProviderInstanceConfig = {
      providerId: "anthropic",
      providerName: "Anthropic",
      format: "anthropic",
      models: ["claude-3-sonnet"],
    };
    const event = providerStreamChunkToEvent(chunk, config);

    expect(event).not.toBeNull();
    expect(event!.type).toBe("text_delta");
    expect((event as any).delta).toBe("Hello");
  });
});

// ========================================================================
// Test 6: Tools Cross-Access
// ========================================================================

describe("Tools Cross-Access", () => {
  it("OpenAI tools IR -> Anthropic provider format", () => {
    const config: ProviderInstanceConfig = {
      providerId: "anthropic",
      providerName: "Anthropic",
      format: "anthropic",
      models: ["claude-3-sonnet"],
    };

    const ir: IRRequest = {
      model: "claude-3-sonnet",
      messages: [{ role: "user", content: [{ type: "text", text: "What's the weather?" }] }],
      tools: [{
        name: "get_weather",
        description: "Get weather info",
        parameters: {
          type: "object",
          properties: { location: { type: "string" } },
          required: ["location"],
        },
      }],
      toolChoice: { type: "auto" } as unknown as IRRequest["toolChoice"],
    };

    const body = providerRequestToBody(ir, config);
    expect(body.tools).toHaveLength(1);
    expect((body.tools as any[])[0]).toEqual({
      name: "get_weather",
      description: "Get weather info",
      input_schema: {
        type: "object",
        properties: { location: { type: "string" } },
        required: ["location"],
      },
    });
  });

  it("Anthropic tools IR -> OpenAI provider format", () => {
    const config: ProviderInstanceConfig = {
      providerId: "openai",
      providerName: "OpenAI",
      format: "openai",
      models: ["gpt-4o"],
    };

    const ir: IRRequest = {
      model: "gpt-4o",
      messages: [{ role: "user", content: [{ type: "text", text: "What's the weather?" }] }],
      tools: [{
        name: "get_weather",
        description: "Get weather info",
        parameters: {
          type: "object",
          properties: { location: { type: "string" } },
          required: ["location"],
        },
      }],
      toolChoice: { type: "auto" } as unknown as IRRequest["toolChoice"],
    };

    const body = providerRequestToBody(ir, config);
    expect(body.tools).toHaveLength(1);
    expect((body.tools as any[])[0]).toEqual({
      type: "function",
      function: {
        name: "get_weather",
        description: "Get weather info",
        parameters: {
          type: "object",
          properties: { location: { type: "string" } },
          required: ["location"],
        },
      },
    });
  });
});
