/**
 * Provider Engine
 *
 * Thin adapter layer over ProviderPlugin registry.
 * Replaces the old transform-engine based implementation.
 *
 * All provider logic is now in src/providers/x/x/index.ts (hand-written plugins).
 * This file provides:
 *   - ProviderInstanceConfig (runtime config + plugin reference)
 *   - Convenience wrappers for plugin methods
 *   - Backward-compatible exports for existing code
 */

import { providerRegistry } from "../providers";
import type { ProviderPlugin, ProviderCapabilities } from "../providers/types";
import type { IRRequest, IRResponse, StreamEvent } from "../core/ir";

export type { ProviderCapabilities };
export { ProviderCapabilities as ConverterCapabilities };

// ========================================================================
// Provider Instance Config
// ========================================================================

export interface ProviderInstanceConfig {
  providerId: string;
  providerName: string;
/* Plugin ID (must match a registered ProviderPlugin) */
  format: string;
/* Base URL override (optional) */
  baseUrl?: string;
/* Full endpoint override (optional) */
  endpoint?: string;
/* Auth configuration override */
  auth?: {
    type: "bearer" | "api-key" | "x-api-key";
    headerName?: string;
  };
/* Extra headers to include */
  extraHeaders?: Record<string, string>;
/* Supported models */
  models: string[];
/* Capability overrides */
  capabilities?: Partial<ProviderCapabilities>;
}

// ========================================================================
// Resolve Plugin
// ========================================================================

function resolvePlugin(config: ProviderInstanceConfig): ProviderPlugin {
  const plugin = providerRegistry.find(config.format);
  if (!plugin) {
    throw new Error(`Unknown provider format: ${config.format}. No plugin registered.`);
  }
  return plugin;
}

// ========================================================================
// Request -> Provider
// ========================================================================

export function providerRequestToBody(
  ir: IRRequest,
  config: ProviderInstanceConfig
): Record<string, unknown> {
  const plugin = resolvePlugin(config);
  return plugin.buildRequest(ir);
}

// ========================================================================
// Response -> IR
// ========================================================================

export function providerResponseToIR(
  raw: unknown,
  config: ProviderInstanceConfig
): IRResponse {
  const plugin = resolvePlugin(config);
  return plugin.parseResponse(raw);
}

// ========================================================================
// Stream Chunk -> StreamEvent
// ========================================================================

export function providerStreamChunkToEvent(
  chunk: unknown,
  config: ProviderInstanceConfig
): StreamEvent | null {
  const plugin = resolvePlugin(config);
  return plugin.parseStreamChunk(chunk);
}

// ========================================================================
// Endpoint Building
// ========================================================================

export function buildProviderEndpoint(
  config: ProviderInstanceConfig,
  model?: string
): string {
  const plugin = resolvePlugin(config);
  return plugin.buildEndpoint(config.baseUrl, model);
}

// ========================================================================
// Headers Building
// ========================================================================

export function buildProviderHeaders(
  config: ProviderInstanceConfig,
  apiKey: string
): Record<string, string> {
  const plugin = resolvePlugin(config);
  return plugin.buildHeaders(apiKey, config.extraHeaders);
}

// ========================================================================
// Error Parsing
// ========================================================================

export function parseProviderError(
  raw: unknown,
  config: ProviderInstanceConfig
): { message: string; type: string; code?: string } {
  const plugin = resolvePlugin(config);
  return plugin.parseError(raw);
}

// ========================================================================
// Capabilities
// ========================================================================

export function getProviderCapabilities(
  config: ProviderInstanceConfig
): ProviderCapabilities {
  const plugin = resolvePlugin(config);
  const base = plugin.capabilities;
  return { ...base, ...config.capabilities };
}

// ========================================================================
// Stream End Detection
// ========================================================================

export function isStreamEndMarker(
  chunk: unknown,
  config: ProviderInstanceConfig
): boolean {
  const plugin = resolvePlugin(config);
  return plugin.isStreamEndMarker(chunk);
}

// ========================================================================
// List Built-in Formats (for admin UI)
// ========================================================================

export interface ProviderFormatInfo {
  id: string;
  name: string;
  endpointTemplate: string;
  authType: "bearer" | "api-key" | "x-api-key";
  capabilities: ProviderCapabilities;
}

export function listBuiltinFormats(): ProviderFormatInfo[] {
  return providerRegistry.list().map((p) => ({
    id: p.id,
    name: p.name,
    endpointTemplate: "", // Plugins don't expose this directly; use buildEndpoint
    authType: "bearer",   // Default; plugins handle auth internally
    capabilities: p.capabilities,
  }));
}

export function getBuiltinFormat(formatId: string): ProviderFormatInfo | undefined {
  const plugin = providerRegistry.find(formatId);
  if (!plugin) return undefined;
  return {
    id: plugin.id,
    name: plugin.name,
    endpointTemplate: "",
    authType: "bearer",
    capabilities: plugin.capabilities,
  };
}
