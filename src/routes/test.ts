/**
 * Internal Test Routes
 *
 * Self-testing endpoints that run inside the Worker.
 * Used for validating consumer/provider interop without external network access.
 */

import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth";
import { forwardToProvider } from "../core/gateway";
import { providerResponseToIR } from "../lib/provider-engine";
import type { ProviderInstanceConfig } from "../lib/provider-engine";

const testApp = new Hono<{ Bindings: { KV: KVNamespace } }>();

testApp.get("/", (c) => c.json({ tests: ["/test/opencodego-openai", "/test/opencodego-anthropic"] }));

// ========================================================================
// Helper: Create OpenCode Go provider config
// ========================================================================

function createOpenCodeGoConfig(): ProviderInstanceConfig {
  return {
    providerId: "opencodego",
    providerName: "OpenCode Go",
    format: "openai",
    baseUrl: "https://opencode.ai/zen/go/v1",
    models: ["claude-sonnet-4"],
  };
}

// ========================================================================
// Test 1: OpenAI Consumer format -> OpenCode Go Provider
// ========================================================================

testApp.post("/opencodego-openai", authMiddleware(), async (c) => {
  const providerKeys = c.get("providerKeys");
  const pk = providerKeys["opencodego"];
  if (!pk) return c.json({ error: "No opencodego key configured" }, 400);

  const config = createOpenCodeGoConfig();

  // Build an IR request (simulating OpenAI consumer parsing)
  const irRequest = {
    model: "claude-sonnet-4",
    messages: [
      { role: "system" as const, content: [{ type: "text" as const, text: "You are a helpful assistant. Reply in 1 sentence." }] },
      { role: "user" as const, content: [{ type: "text" as const, text: "What is 2+2?" }] },
    ],
    generation: { maxTokens: 50, temperature: 0.1 },
  };

  try {
    const resp = await forwardToProvider(config, irRequest, pk.apiKey);
    const body = await resp.json();

    return c.json({
      test: "OpenAI Consumer -> OpenCode Go Provider",
      status: resp.status,
      providerResponse: body,
      irResponse: providerResponseToIR(body, config),
    });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ========================================================================
// Test 2: Anthropic Consumer format -> OpenCode Go Provider
// ========================================================================

testApp.post("/opencodego-anthropic", authMiddleware(), async (c) => {
  const providerKeys = c.get("providerKeys");
  const pk = providerKeys["opencodego"];
  if (!pk) return c.json({ error: "No opencodego key configured" }, 400);

  const config = createOpenCodeGoConfig();

  // Build an IR request (simulating Anthropic consumer parsing)
  const irRequest = {
    model: "claude-sonnet-4",
    messages: [
      { role: "system" as const, content: [{ type: "text" as const, text: "You are a helpful assistant. Reply in 1 sentence." }] },
      { role: "user" as const, content: [{ type: "text" as const, text: "What is 2+2?" }] },
    ],
    generation: { maxTokens: 50, temperature: 0.1 },
  };

  try {
    const resp = await forwardToProvider(config, irRequest, pk.apiKey);
    const body = await resp.json();

    return c.json({
      test: "Anthropic Consumer -> OpenCode Go Provider",
      status: resp.status,
      providerResponse: body,
      irResponse: providerResponseToIR(body, config),
    });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ========================================================================
// Test 3: Tools -> OpenCode Go Provider
// ========================================================================

testApp.post("/opencodego-tools", authMiddleware(), async (c) => {
  const providerKeys = c.get("providerKeys");
  const pk = providerKeys["opencodego"];
  if (!pk) return c.json({ error: "No opencodego key configured" }, 400);

  const config = createOpenCodeGoConfig();

  const irRequest = {
    model: "claude-sonnet-4",
    messages: [
      { role: "user" as const, content: [{ type: "text" as const, text: "What is the weather in Beijing?" }] },
    ],
    generation: { maxTokens: 100, temperature: 0.1 },
    tools: [
      {
        name: "get_weather",
        description: "Get weather for a location",
    parameters: {
      type: "object" as const,
      properties: {
            location: { type: "string" },
            unit: { type: "string", enum: ["celsius", "fahrenheit"] },
          },
          required: ["location"],
        },
      },
    ],
    toolChoice: "required" as const,
  };

  try {
    const resp = await forwardToProvider(config, irRequest, pk.apiKey);
    const body = await resp.json();

    return c.json({
      test: "Tools -> OpenCode Go Provider",
      status: resp.status,
      providerResponse: body,
      irResponse: providerResponseToIR(body, config),
    });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

export default testApp;
