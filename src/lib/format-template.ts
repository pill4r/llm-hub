/**
 * Custom Protocol Format (User-Uploaded Templates)
 *
 * A "format" is a thin layer on top of a core protocol (openai/anthropic).
 * Users upload a JSON template describing how to extend the base protocol
 * for a specific provider (e.g., DeepSeek, OpenCode Go, SiliconFlow).
 *
 * The hub stores these in KV and dynamically creates converters at runtime.
 */

import type { ConverterCapabilities, ConverterOptions } from "../core/converter";

/** User-uploaded format template */
export interface FormatTemplate {
  /** Unique identifier (e.g., "deepseek", "siliconflow") */
  formatId: string;

  /** Human-readable name */
  displayName: string;

  /** Which core protocol this extends */
  baseProtocol: "openai-compatible" | "anthropic-compatible";

  /** Default base URL */
  baseUrl: string;

  /** Endpoint path (relative to baseUrl, e.g., "/chat/completions") */
  chatEndpoint?: string;

  /** Auth type */
  authType: "bearer" | "api-key" | "x-api-key";

  /** Default models */
  models: { id: string; name: string }[];

  /** Capability overrides (merged with base protocol defaults) */
  capabilities?: Partial<ConverterCapabilities>;

  /** Extra headers */
  extraHeaders?: Record<string, string>;

  /** Anthropic-version header (only for anthropic-compatible) */
  anthropicVersion?: string;

  /** When uploaded */
  uploadedAt: string;
}

/** Validate a user-uploaded format template */
export function validateFormatTemplate(raw: unknown): FormatTemplate | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  const formatId = String(r.formatId || "").trim();
  if (!formatId || !/^[a-zA-Z0-9_-]+$/.test(formatId)) return null;

  const baseProtocol = r.baseProtocol as "openai-compatible" | "anthropic-compatible";
  if (!["openai-compatible", "anthropic-compatible"].includes(baseProtocol)) return null;

  const baseUrl = String(r.baseUrl || "").trim();
  if (!baseUrl || !baseUrl.startsWith("http")) return null;

  const authType = (r.authType as "bearer" | "api-key" | "x-api-key") || "bearer";
  if (!["bearer", "api-key", "x-api-key"].includes(authType)) return null;

  const models = Array.isArray(r.models)
    ? r.models
        .map((m: any) => {
          if (typeof m === "string") return { id: m, name: m };
          return { id: String(m.id || ""), name: String(m.name || m.id || "") };
        })
        .filter((m) => m.id)
    : [];

  return {
    formatId,
    displayName: String(r.displayName || formatId),
    baseProtocol,
    baseUrl,
    chatEndpoint: r.chatEndpoint ? String(r.chatEndpoint) : undefined,
    authType,
    models,
    capabilities: r.capabilities as Partial<ConverterCapabilities> | undefined,
    extraHeaders: r.extraHeaders as Record<string, string> | undefined,
    anthropicVersion: r.anthropicVersion ? String(r.anthropicVersion) : undefined,
    uploadedAt: String(r.uploadedAt || new Date().toISOString()),
  };
}

/** KV key for storing format templates */
const FORMATS_KV_KEY = "provider:formats";

/** Fetch all uploaded format templates from KV */
export async function getAllFormatTemplates(kv: KVNamespace): Promise<FormatTemplate[]> {
  const raw = await kv.get(FORMATS_KV_KEY);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as unknown[];
    return arr.map(validateFormatTemplate).filter(Boolean) as FormatTemplate[];
  } catch {
    return [];
  }
}

/** Save format templates to KV */
export async function saveFormatTemplates(kv: KVNamespace, formats: FormatTemplate[]): Promise<void> {
  await kv.put(FORMATS_KV_KEY, JSON.stringify(formats));
}

/** Get a single format template by ID */
export async function getFormatTemplate(kv: KVNamespace, formatId: string): Promise<FormatTemplate | null> {
  const formats = await getAllFormatTemplates(kv);
  return formats.find((f) => f.formatId === formatId) || null;
}

/** Delete a format template */
export async function deleteFormatTemplate(kv: KVNamespace, formatId: string): Promise<boolean> {
  const formats = await getAllFormatTemplates(kv);
  const filtered = formats.filter((f) => f.formatId !== formatId);
  if (filtered.length === formats.length) return false;
  await saveFormatTemplates(kv, filtered);
  return true;
}
