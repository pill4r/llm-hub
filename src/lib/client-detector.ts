/**
 * Client Detector
 *
 * Detects which client SDK is making the request.
 * Used for telemetry, special handling, and routing.
 */

export type DetectedClient =
  | "openai-sdk"
  | "anthropic-sdk"
  | "claude-code-cli"
  | "claude-code-vscode"
  | "codex-cli"
  | "codex-desktop"
  | "unknown";

const UA_PATTERNS: Array<{ pattern: RegExp; client: DetectedClient }> = [
  // Claude Code
  { pattern: /claude[-_]?code/i, client: "claude-code-cli" },
  { pattern: /claude[-_]?code[-_]?vscode/i, client: "claude-code-vscode" },

  // Codex
  { pattern: /codex[-_]?cli/i, client: "codex-cli" },
  { pattern: /codex[-_]?desktop/i, client: "codex-desktop" },

  // OpenAI
  { pattern: /openai/i, client: "openai-sdk" },

  // Anthropic
  { pattern: /anthropic/i, client: "anthropic-sdk" },
];

/**
 * Detect client from User-Agent header.
 */
export function detectClient(headers: Headers): DetectedClient {
  const ua = headers.get("user-agent") || "";

  for (const { pattern, client } of UA_PATTERNS) {
    if (pattern.test(ua)) {
      return client;
    }
  }

  return "unknown";
}

/**
 * Check if client is Claude Code family.
 */
export function isClaudeCode(client: DetectedClient): boolean {
  return client === "claude-code-cli" || client === "claude-code-vscode";
}

/**
 * Check if client is Codex family.
 */
export function isCodex(client: DetectedClient): boolean {
  return client === "codex-cli" || client === "codex-desktop";
}
