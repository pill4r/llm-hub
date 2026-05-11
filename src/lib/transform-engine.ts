/**
 * Declarative Transform Engine
 *
 * Users describe protocol differences via JSON configuration rather than code.
 * The engine applies these transforms at runtime to convert between
 * provider-specific formats and the hub's Internal Representation (IR).
 */

// ========================================================================
// Transform Types
// ========================================================================

/** Request body transforms (applied AFTER base protocol conversion) */
export interface RequestTransform {
  /** Wrap the entire body in a field: { [wrap]: body } */
  wrap?: string;
  /** Add/replace fields */
  set?: Record<string, unknown>;
  /** Rename fields: { oldName: newName } */
  rename?: Record<string, string>;
  /** Remove fields */
  unset?: string[];
}

/** Response body transforms (applied BEFORE base protocol parsing) */
export interface ResponseTransform {
  /** Unwrap from a nested field: body[unwrap] */
  unwrap?: string;
  /** Extract fields by dot-path and assign to top-level */
  extract?: Record<string, string>;
  /** Construct a standard OpenAI-like response from extracted fields */
  construct?: {
    id?: string;
    model?: string;
    content?: string;
    promptTokens?: string;
    completionTokens?: string;
    totalTokens?: string;
    finishReason?: string;
  };
}

/** Stream chunk transforms */
export interface StreamTransform {
  /** Extract text delta from chunk by dot-path */
  contentPath?: string;
  /** Extract usage from chunk by dot-path */
  usagePath?: string;
  /** Done marker string */
  doneMarker?: string;
}

/** Full custom transform configuration */
export interface CustomTransforms {
  request?: RequestTransform;
  response?: ResponseTransform;
  stream?: StreamTransform;
}

// ========================================================================
// Path Utilities
// ========================================================================

/**
 * Get a value from an object by dot-path.
 * Examples:
 *   getPath({ a: { b: 1 } }, "a.b") → 1
 *   getPath({ arr: [{ x: 2 }] }, "arr[0].x") → 2
 */
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

/**
 * Set a value in an object by dot-path (creates nested objects as needed).
 */
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
// Transform Application
// ========================================================================

/**
 * Apply request transforms to a provider request body.
 * Called AFTER the base converter has built the standard request.
 */
export function applyRequestTransform(
  body: Record<string, unknown>,
  transform: RequestTransform | undefined
): Record<string, unknown> {
  if (!transform) return body;

  let result: Record<string, unknown> = { ...body };

  // Rename fields
  if (transform.rename) {
    for (const [oldKey, newKey] of Object.entries(transform.rename)) {
      if (oldKey in result) {
        result[newKey] = result[oldKey];
        delete result[oldKey];
      }
    }
  }

  // Remove fields
  if (transform.unset) {
    for (const key of transform.unset) {
      delete result[key];
    }
  }

  // Add/replace fields
  if (transform.set) {
    Object.assign(result, transform.set);
  }

  // Wrap entire body
  if (transform.wrap) {
    result = { [transform.wrap]: result };
  }

  return result;
}

/**
 * Apply response transforms to normalize a provider response.
 * Called BEFORE the base converter parses the response.
 */
export function applyResponseTransform(
  raw: unknown,
  transform: ResponseTransform | undefined
): unknown {
  if (!transform || !raw || typeof raw !== "object") return raw;

  let data = raw as Record<string, unknown>;

  // Unwrap from nested field
  if (transform.unwrap) {
    const unwrapped = getPath(data, transform.unwrap);
    if (unwrapped && typeof unwrapped === "object") {
      data = unwrapped as Record<string, unknown>;
    }
  }

  // Extract fields by path
  if (transform.extract) {
    for (const [target, sourcePath] of Object.entries(transform.extract)) {
      const value = getPath(data, sourcePath);
      if (value !== undefined) {
        data[target] = value;
      }
    }
  }

  // Construct standard response from extracted fields
  if (transform.construct) {
    const c = transform.construct;
    return {
      id: getPath(data, c.id || "id") || crypto.randomUUID(),
      model: getPath(data, c.model || "model") || "unknown",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: getPath(data, c.content || "choices[0].message.content") || "",
        },
        finish_reason: getPath(data, c.finishReason || "choices[0].finish_reason") || "stop",
      }],
      usage: {
        prompt_tokens: getPath(data, c.promptTokens || "usage.prompt_tokens") || 0,
        completion_tokens: getPath(data, c.completionTokens || "usage.completion_tokens") || 0,
        total_tokens: getPath(data, c.totalTokens || "usage.total_tokens") || 0,
      },
    };
  }

  return data;
}

/**
 * Apply stream chunk transforms.
 * Returns a normalized chunk compatible with base protocol parsing.
 */
export function applyStreamTransform(
  chunk: unknown,
  transform: StreamTransform | undefined
): unknown {
  if (!transform || !chunk || typeof chunk !== "object") return chunk;

  const data = chunk as Record<string, unknown>;

  // Check done marker
  if (transform.doneMarker) {
    const raw = JSON.stringify(data);
    if (raw.includes(transform.doneMarker)) {
      return {}; // Empty chunk signals end
    }
  }

  // If contentPath is specified, construct a standard delta chunk
  if (transform.contentPath) {
    const content = getPath(data, transform.contentPath);
    if (content !== undefined) {
      return {
        choices: [{
          index: 0,
          delta: { content: String(content) },
        }],
      };
    }
  }

  // If usagePath is specified, construct a usage chunk
  if (transform.usagePath) {
    const usage = getPath(data, transform.usagePath);
    if (usage && typeof usage === "object") {
      return { usage };
    }
  }

  return data;
}
