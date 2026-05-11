/**
 * Custom Protocol Format Template
 *
 * This file defines a custom provider that uses an existing core protocol
 * (openai-compatible or anthropic-compatible) with provider-specific overrides.
 *
 * The LLM-Hub will:
 * 1. Load this template
 * 2. Pick the base converter from the chosen protocol
 * 3. Apply your overrides (baseUrl, models, capabilities, headers, etc.)
 *
 * No class inheritance needed — just a declarative config object.
 */

export default {
  /** Unique identifier for this provider format (alphanumeric, hyphens, underscores) */
  providerId: "my-provider",

  /** Human-readable name */
  providerName: "My Custom Provider",

  /** Which core protocol to extend */
  protocol: "openai-compatible", // or "anthropic-compatible"

  /** Default base URL (users can override in their provider config) */
  baseUrl: "https://api.example.com/v1",

  /** Chat completions endpoint path (relative to baseUrl) */
  chatEndpoint: "/chat/completions", // auto-detected if omitted

  /** Authentication method */
  authType: "bearer", // "bearer" | "api-key" | "x-api-key"

  /** Default models supported by this provider */
  models: [
    { id: "model-a", name: "Model A" },
    { id: "model-b", name: "Model B" },
  ],

  /** Capability overrides (merged with base protocol defaults) */
  capabilities: {
    streaming: true,
    tools: true,
    vision: false,
    systemMessages: true,
    reasoning: false,
    jsonMode: true,
    maxContextLength: 128_000,
  },

  /** Extra headers to send with every request */
  extraHeaders: {
    // "X-Custom-Header": "value",
  },

  /** Error response parser (optional — falls back to protocol default) */
  // parseError: (raw) => ({ message: "...", type: "...", code: "..." }),

  /** Request body transformer (optional — runs after base protocol conversion) */
  // transformRequest: (body) => { body.custom_field = "value"; return body; },

  /** Response body transformer (optional — runs before IR conversion) */
  // transformResponse: (raw) => { raw.custom_field = raw.other; return raw; },
};
