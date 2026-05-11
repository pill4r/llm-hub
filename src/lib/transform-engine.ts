/**
 * Declarative Transform Engine v2 — IR-Centric
 *
 * Users describe how IR fields map to provider fields.
 * The engine builds request/response directly from IR, without relying on
 * a "base protocol" as intermediate.
 */

// ========================================================================
// IR Field Mapping Types
// ========================================================================

/**
 * Maps IR request fields to provider request fields.
 *
 * Example — provider wraps everything in "input" and renames maxTokens:
 * {
 *   wrap: "input",
 *   fieldMap: {
 *     "generation.maxTokens": "max_tokens",
 *     "model": "model_id"
 *   }
 * }
 */
export interface RequestFieldMap {
  /** Wrap the entire request body in a field: { [wrap]: body } */
  wrap?: string;
  /** Map IR dot-paths → provider field names.
   *  Key = IR field path, Value = provider field name.
   *  Unmapped IR fields are passed through as-is.
   */
  fieldMap?: Record<string, string>;
  /** Static fields to add regardless of IR content */
  static?: Record<string, unknown>;
  /** IR fields to exclude from the output */
  exclude?: string[];
}

/**
 * Maps provider response fields back to IR response fields.
 *
 * Example — provider nests response under "output":
 * {
 *   unwrap: "output",
 *   fieldMap: {
 *     "output.text": "choices[0].message.content",
 *     "output.model_id": "model"
 *   }
 * }
 */
export interface ResponseFieldMap {
  /** Unwrap from a nested field before mapping */
  unwrap?: string;
  /** Map provider dot-paths → IR field paths.
   *  Key = provider field path, Value = IR field path.
   */
  fieldMap?: Record<string, string>;
  /** Static fields to add */
  static?: Record<string, unknown>;
}

/**
 * Maps provider stream chunks to IR stream events.
 */
export interface StreamFieldMap {
  /** Path to text delta in provider chunk */
  textDeltaPath?: string;
  /** Path to usage data in provider chunk */
  usagePath?: string;
  /** Path to finish reason in provider chunk */
  finishReasonPath?: string;
  /** String that marks stream end */
  doneMarker?: string;
}

/** Full custom transform configuration */
export interface CustomTransforms {
  request?: RequestFieldMap;
  response?: ResponseFieldMap;
  stream?: StreamFieldMap;
}

// ========================================================================
// Path Utilities
// ========================================================================

/** Get value by dot-path from object. Supports array indices: "choices[0].text" */
export function getPath(obj: unknown, path: string): unknown {
  if (!obj || typeof obj !== "object") return undefined;
  if (!path) return obj;

  const parts = path.split(/\.|\[(\d+)\]/).filter(Boolean);
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    const idx = parseInt(part, 10);
    if (!isNaN(idx) && Array.isArray(current)) {
      current = current[idx];
    } else if (typeof current === "object" && current !== null) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }

  return current;
}

/** Set value by dot-path, creating nested objects/arrays as needed. */
export function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(/\.|\[(\d+)\]/).filter(Boolean);
  let current: any = obj;

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    const nextPart = parts[i + 1];
    const isNextArray = !isNaN(parseInt(nextPart, 10));

    if (!(part in current)) {
      current[part] = isNextArray ? [] : {};
    }
    current = current[part];
  }

  current[parts[parts.length - 1]] = value;
}

// ========================================================================
// Flatten / Unflatten IR
// ========================================================================

/** Flatten nested object to dot-paths: { a: { b: 1 } } → { "a.b": 1 } */
function flatten(obj: unknown, prefix = "", result: Record<string, unknown> = {}): Record<string, unknown> {
  if (obj === null || obj === undefined) return result;
  if (typeof obj !== "object") {
    result[prefix] = obj;
    return result;
  }
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      flatten(obj[i], prefix ? `${prefix}[${i}]` : `[${i}]`, result);
    }
    return result;
  }
  for (const [key, value] of Object.entries(obj)) {
    const newKey = prefix ? `${prefix}.${key}` : key;
    flatten(value, newKey, result);
  }
  return result;
}

// ========================================================================
// v2 Transform Engine — IR-Centric
// ========================================================================

/**
 * Build provider request body from IR request.
 *
 * @param ir - The IR request object
 * @param map - Field mapping configuration
 * @returns Provider-specific request body
 */
export function buildProviderRequest(
  ir: Record<string, unknown>,
  map: RequestFieldMap | undefined
): Record<string, unknown> {
  if (!map) return { ...ir };

  // 1. Flatten IR to dot-paths
  const flatIR = flatten(ir);

  // 2. Build provider body from fieldMap
  const body: Record<string, unknown> = {};

  // Pass through unmapped fields first (unless excluded)
  const excluded = new Set(map.exclude || []);
  for (const [irPath, value] of Object.entries(flatIR)) {
    if (excluded.has(irPath)) continue;
    if (map.fieldMap && irPath in map.fieldMap) {
      // Mapped field → use provider field name
      setPath(body, map.fieldMap[irPath], value);
    } else {
      // Unmapped field → pass through as-is
      setPath(body, irPath, value);
    }
  }

  // 3. Add static fields
  if (map.static) {
    for (const [key, value] of Object.entries(map.static)) {
      setPath(body, key, value);
    }
  }

  // 4. Wrap if needed
  if (map.wrap) {
    return { [map.wrap]: body };
  }

  return body;
}

/**
 * Parse provider response into IR response shape.
 *
 * @param raw - Provider raw response
 * @param map - Field mapping configuration
 * @returns Object shaped like IRResponse (or raw for base converter to handle)
 */
export function parseProviderResponse(
  raw: unknown,
  map: ResponseFieldMap | undefined
): Record<string, unknown> {
  if (!map || !raw || typeof raw !== "object") {
    return raw as Record<string, unknown>;
  }

  let data = raw as Record<string, unknown>;

  // 1. Unwrap if needed
  if (map.unwrap) {
    const unwrapped = getPath(data, map.unwrap);
    if (unwrapped && typeof unwrapped === "object") {
      data = unwrapped as Record<string, unknown>;
    }
  }

  // 2. Build IR-shaped result from fieldMap
  const ir: Record<string, unknown> = {};

  if (map.fieldMap) {
    for (const [providerPath, irPath] of Object.entries(map.fieldMap)) {
      const value = getPath(data, providerPath);
      if (value !== undefined) {
        setPath(ir, irPath, value);
      }
    }
  }

  // 3. Add static fields
  if (map.static) {
    for (const [key, value] of Object.entries(map.static)) {
      setPath(ir, key, value);
    }
  }

  return ir;
}

/**
 * Parse provider stream chunk into IR stream event.
 *
 * @param chunk - Provider raw chunk
 * @param map - Stream field mapping
 * @returns Normalized chunk or null if done
 */
export function parseStreamChunk(
  chunk: unknown,
  map: StreamFieldMap | undefined
): Record<string, unknown> | null {
  if (!map || !chunk || typeof chunk !== "object") {
    return chunk as Record<string, unknown>;
  }

  const data = chunk as Record<string, unknown>;

  // Check done marker
  if (map.doneMarker) {
    const raw = JSON.stringify(data);
    if (raw.includes(map.doneMarker)) {
      return null; // null signals end
    }
  }

  // Build normalized chunk
  const normalized: Record<string, unknown> = {};

  if (map.textDeltaPath) {
    const text = getPath(data, map.textDeltaPath);
    if (text !== undefined) {
      normalized.choices = [{
        index: 0,
        delta: { content: String(text) },
      }];
    }
  }

  if (map.usagePath) {
    const usage = getPath(data, map.usagePath);
    if (usage && typeof usage === "object") {
      normalized.usage = usage;
    }
  }

  if (map.finishReasonPath) {
    const reason = getPath(data, map.finishReasonPath);
    if (reason !== undefined) {
      normalized.choices = normalized.choices || [{}];
      (normalized.choices as Record<string, unknown>[])[0].finish_reason = reason;
    }
  }

  return Object.keys(normalized).length > 0 ? normalized : data;
}

// ========================================================================
// Backward Compatibility — v1 aliases
// ========================================================================

/** @deprecated Use buildProviderRequest */
export function applyRequestTransform(
  body: Record<string, unknown>,
  transform: { wrap?: string; set?: Record<string, unknown>; rename?: Record<string, string>; unset?: string[] } | undefined
): Record<string, unknown> {
  if (!transform) return body;

  const map: RequestFieldMap = {};
  if (transform.wrap) map.wrap = transform.wrap;
  if (transform.set) map.static = transform.set;
  if (transform.unset) map.exclude = transform.unset;
  if (transform.rename) {
    map.fieldMap = {};
    for (const [oldKey, newKey] of Object.entries(transform.rename)) {
      map.fieldMap[oldKey] = newKey;
    }
  }

  return buildProviderRequest(body, map);
}

/** @deprecated Use parseProviderResponse */
export function applyResponseTransform(
  raw: unknown,
  transform: { unwrap?: string; extract?: Record<string, string>; construct?: Record<string, string> } | undefined
): unknown {
  if (!transform) return raw;

  const map: ResponseFieldMap = {};
  if (transform.unwrap) map.unwrap = transform.unwrap;
  if (transform.extract) {
    map.fieldMap = {};
    for (const [target, source] of Object.entries(transform.extract)) {
      map.fieldMap[source] = target;
    }
  }

  return parseProviderResponse(raw, map);
}

/** @deprecated Use parseStreamChunk */
export function applyStreamTransform(
  chunk: unknown,
  transform: { contentPath?: string; usagePath?: string; doneMarker?: string } | undefined
): unknown {
  if (!transform) return chunk;

  const map: StreamFieldMap = {};
  if (transform.contentPath) map.textDeltaPath = transform.contentPath;
  if (transform.usagePath) map.usagePath = transform.usagePath;
  if (transform.doneMarker) map.doneMarker = transform.doneMarker;

  return parseStreamChunk(chunk, map);
}
