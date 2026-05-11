/**
 * Declarative Transform Engine v3 — Universal IR Mapping
 *
 * All provider converters (OpenAI, Anthropic, and custom) are expressed
 * as JSON configuration. The engine executes these mappings at runtime.
 *
 * Design principle: If a provider's wire format can be described as
 * "IR fields → provider fields with structural transforms", it should
 * be expressible in this engine without custom code.
 */

// ========================================================================
// Value Expressions
// ========================================================================

/** A value can be a literal, a path reference, or a computed expression */
export interface ValuePath { $path: string }
export interface ValueLiteral { $literal: unknown }
export interface ValueJoin { $join: { path: string; sep?: string } }
export interface ValueFilter { $filter: { path: string; where: { path: string; eq: unknown } } }
export interface ValueMap { $map: { path: string; item: string; produce: Record<string, unknown> } }
export interface ValueIf { $if: { cond: Condition; then: unknown; else?: unknown } }
export interface ValueSwitch { $switch: { path: string; cases: Record<string, unknown>; default?: unknown } }
export interface ValueContentText { $content_text: { path: string } }

export type ValueExpr =
  | ValuePath
  | ValueLiteral
  | ValueJoin
  | ValueFilter
  | ValueMap
  | ValueIf
  | ValueSwitch
  | ValueContentText
  | string | number | boolean | null
  | ValueExpr[]
  | { [key: string]: ValueExpr };

export interface Condition {
  $eq?: [unknown, unknown];
  $ne?: [unknown, unknown];
  $exists?: unknown;
  $and?: Condition[];
  $or?: Condition[];
}

// ========================================================================
// Request Transform
// ========================================================================

export interface RequestTransform {
  /** Top-level fields of the provider request body */
  body: Record<string, ValueExpr>;
  /** Array items to prepend (e.g., system instruction as first message) */
  prepend?: Array<{ target: string; value: ValueExpr }>;
  /** Fields to remove after construction */
  remove?: string[];
  /** Wrap entire body */
  wrap?: string;
}

// ========================================================================
// Response Transform
// ========================================================================

export interface ResponseTransform {
  /** Unwrap from nested field before processing */
  unwrap?: string;
  /** Map provider response fields to IR response fields */
  body: Record<string, ValueExpr>;
}

// ========================================================================
// Stream Transform
// ========================================================================

export interface StreamTransform {
  /** Route by event type field */
  routeBy?: string;
  /** Per-event-type transforms */
  events?: Record<string, Record<string, ValueExpr>>;
  /** Default for unmapped events */
  default?: Record<string, ValueExpr>;
  /** Done marker */
  doneMarker?: string;
}

// ========================================================================
// Full Config
// ========================================================================

export interface TransformConfig {
  request?: RequestTransform;
  response?: ResponseTransform;
  stream?: StreamTransform;
}

/** @deprecated Use TransformConfig */
export type CustomTransforms = TransformConfig;

// ========================================================================
// Path Utilities
// ========================================================================

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
// Expression Evaluator
// ========================================================================

function evalValue(expr: unknown, ctx: Record<string, unknown>): unknown {
  // Shorthand literal
  if (typeof expr !== "object" || expr === null) return expr;

  // Path reference
  if ("$path" in expr) {
    return getPath(ctx, expr.$path as string);
  }

  // Literal
  if ("$literal" in expr) {
    return expr.$literal;
  }

  // Join array elements
  if ("$join" in expr) {
    const cfg = expr.$join as { path: string; sep?: string };
    const arr = getPath(ctx, cfg.path) as unknown[] | undefined;
    if (!arr || !Array.isArray(arr)) return "";
    return arr.join(cfg.sep ?? "");
  }

  // Filter array
  if ("$filter" in expr) {
    const cfg = expr.$filter as { path: string; where: { path: string; eq: unknown } };
    const arr = getPath(ctx, cfg.path) as Record<string, unknown>[] | undefined;
    if (!arr || !Array.isArray(arr)) return [];
    return arr.filter(item => {
      const val = getPath(item, cfg.where.path);
      return val === cfg.where.eq;
    });
  }

  // Map array
  if ("$map" in expr) {
    const cfg = expr.$map as { path: string; item: string; produce: Record<string, ValueExpr> };
    const arr = getPath(ctx, cfg.path) as Record<string, unknown>[] | undefined;
    if (!arr || !Array.isArray(arr)) return [];
    return arr.map((item, idx) => {
      const itemCtx = { ...ctx, [cfg.item]: item, [`${cfg.item}_index`]: idx };
      return evalObject(cfg.produce, itemCtx);
    }).filter((val) => val !== undefined && val !== null);
  }

  // Condition
  if ("$if" in expr) {
    const cfg = expr.$if as { cond: Condition; then: ValueExpr; else?: ValueExpr };
    return evalCondition(cfg.cond, ctx) ? evalValue(cfg.then, ctx) : (cfg.else !== undefined ? evalValue(cfg.else, ctx) : undefined);
  }

  // Switch by value
  if ("$switch" in expr) {
    const cfg = expr.$switch as { path: string; cases: Record<string, ValueExpr>; default?: ValueExpr };
    const val = String(getPath(ctx, cfg.path) ?? "");
    if (val in cfg.cases) return evalValue(cfg.cases[val], ctx);
    if (cfg.default) return evalValue(cfg.default, ctx);
    return null;
  }

  // Extract text from ContentPart[]
  if ("$content_text" in expr) {
    const cfg = expr.$content_text as { path: string };
    const val = getPath(ctx, cfg.path);
    if (typeof val === "string") return val;
    if (Array.isArray(val)) {
      // ContentPart[] → concatenate text parts
      return val
        .filter((part: unknown) => part && typeof part === "object" && (part as Record<string, unknown>).type === "text")
        .map((part: unknown) => String((part as Record<string, unknown>).text || ""))
        .join("");
    }
    return String(val || "");
  }

  // Plain object — recursively evaluate
  return evalObject(expr as Record<string, ValueExpr>, ctx);
}

function evalObject(
  template: Record<string, unknown> | unknown[],
  ctx: Record<string, unknown>
): Record<string, unknown> | unknown[] {
  // If it's an expression object, evaluate it directly
  if (!Array.isArray(template) && template !== null && typeof template === "object") {
    const keys = Object.keys(template);
    if (keys.length === 1 && keys[0].charAt(0) === "$") {
      return evalValue(template, ctx) as Record<string, unknown> | unknown[];
    }
  }

  if (Array.isArray(template)) {
    const result: unknown[] = [];
    for (const item of template) {
      const val = evalValue(item, ctx);
      if (val !== undefined) {
        result.push(val);
      }
    }
    return result;
  }

  const result: Record<string, unknown> = {};
  for (const key of Object.keys(template)) {
    const val = evalValue(template[key], ctx);
    if (val !== undefined) {
      result[key] = val;
    }
  }
  return result;
}

function evalCondition(cond: Condition, ctx: Record<string, unknown>): boolean {
  if (cond.$eq) {
    return evalValue(cond.$eq[0], ctx) === evalValue(cond.$eq[1], ctx);
  }
  if (cond.$ne) {
    return evalValue(cond.$ne[0], ctx) !== evalValue(cond.$ne[1], ctx);
  }
  if (cond.$exists) {
    const v = evalValue(cond.$exists, ctx);
    return v !== undefined && v !== null;
  }
  if (cond.$and) {
    return cond.$and.every(c => evalCondition(c, ctx));
  }
  if (cond.$or) {
    return cond.$or.some(c => evalCondition(c, ctx));
  }
  return false;
}

// ========================================================================
// Request Builder
// ========================================================================

export function buildProviderRequest(
  ir: Record<string, unknown>,
  transform: RequestTransform | undefined
): Record<string, unknown> {
  if (!transform) return { ...ir };

  // Build body from template
  let body = evalObject(transform.body, ir) as Record<string, unknown>;

  // Remove fields first (before prepend, so we can remove original system messages)
  if (transform.remove) {
    for (const path of transform.remove) {
      const parts = path.split(".");
      let current: any = body;
      for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i];
        // Handle array index notation: messages[0]
        const match = part.match(/^(.+)\[(\d+)\]$/);
        if (match) {
          const arr = current?.[match[1]];
          if (Array.isArray(arr)) {
            current = arr[parseInt(match[2], 10)];
          } else {
            current = undefined;
            break;
          }
        } else {
          current = current?.[part];
        }
      }
      if (current && typeof current === "object") {
        const lastPart = parts[parts.length - 1];
        // Handle array index removal
        const match = lastPart.match(/^(.+)\[(\d+)\]$/);
        if (match) {
          const arr = current[match[1]];
          if (Array.isArray(arr)) {
            arr.splice(parseInt(match[2], 10), 1);
          }
        } else {
          delete current[lastPart];
        }
      }
    }
  }

  // Prepend items (e.g., system message)
  if (transform.prepend) {
    for (const { target, value } of transform.prepend) {
      const arr = getPath(body, target) as unknown[] | undefined;
      const val = evalValue(value, ir);
      if (arr && Array.isArray(arr) && val != null) {
        setPath(body, target, [val, ...arr]);
      }
    }
  }

  // Wrap
  if (transform.wrap) {
    body = { [transform.wrap]: body };
  }

  return body;
}

// ========================================================================
// Response Parser
// ========================================================================

export function parseProviderResponse(
  raw: unknown,
  transform: ResponseTransform | undefined
): Record<string, unknown> {
  if (!transform || !raw || typeof raw !== "object") {
    return raw as Record<string, unknown>;
  }

  let data = raw as Record<string, unknown>;

  // Unwrap
  if (transform.unwrap) {
    const unwrapped = getPath(data, transform.unwrap);
    if (unwrapped && typeof unwrapped === "object") {
      data = unwrapped as Record<string, unknown>;
    }
  }

  // Build IR from template
  return evalObject(transform.body, data) as Record<string, unknown>;
}

// ========================================================================
// Stream Parser
// ========================================================================

export function parseStreamChunk(
  chunk: unknown,
  transform: StreamTransform | undefined
): Record<string, unknown> | null {
  if (!transform || !chunk || typeof chunk !== "object") {
    return chunk as Record<string, unknown>;
  }

  const data = chunk as Record<string, unknown>;

  // Done marker
  if (transform.doneMarker) {
    const raw = JSON.stringify(data);
    if (raw.indexOf(transform.doneMarker) !== -1) return null;
  }

  // Route by event type
  if (transform.routeBy) {
    const eventType = String(getPath(data, transform.routeBy) ?? "");
    const eventTemplate = transform.events?.[eventType] ?? transform.default;
    if (eventTemplate) {
      return evalObject(eventTemplate, data) as Record<string, unknown>;
    }
    // If routeBy field is missing but we have a default, use it
    if (!eventType && transform.default) {
      return evalObject(transform.default, data) as Record<string, unknown>;
    }
    return null;
  }

  // Default: pass through
  return data;
}

// ========================================================================
// Backward Compatibility — v1/v2 aliases (deprecated, will be removed)
// ========================================================================

/** @deprecated Use buildProviderRequest with RequestTransform */
export function applyRequestTransform(
  body: Record<string, unknown>,
  transform: { wrap?: string; set?: Record<string, unknown>; rename?: Record<string, string>; unset?: string[] } | undefined
): Record<string, unknown> {
  if (!transform) return body;

  const req: RequestTransform = { body: {} };
  if (transform.wrap) req.wrap = transform.wrap;

  // Convert rename to body fieldMap
  for (const key of Object.keys(body)) {
    const val = body[key];
    const outKey = transform.rename?.[key] ?? key;
    req.body[outKey] = { $literal: val };
  }
  if (transform.set) {
    for (const key of Object.keys(transform.set)) {
      req.body[key] = { $literal: transform.set[key] };
    }
  }
  if (transform.unset) req.remove = transform.unset;

  return buildProviderRequest(body, req);
}

/** @deprecated Use parseProviderResponse with ResponseTransform */
export function applyResponseTransform(
  raw: unknown,
  transform: { unwrap?: string; extract?: Record<string, string>; construct?: Record<string, string> } | undefined
): unknown {
  if (!transform) return raw;

  const resp: ResponseTransform = { body: {} };
  if (transform.unwrap) resp.unwrap = transform.unwrap;
  if (transform.extract) {
    for (const target of Object.keys(transform.extract)) {
      const source = transform.extract[target];
      resp.body[target] = { $path: source };
    }
  }

  return parseProviderResponse(raw, resp);
}

/** @deprecated Use parseStreamChunk with StreamTransform */
export function applyStreamTransform(
  chunk: unknown,
  transform: { contentPath?: string; usagePath?: string; doneMarker?: string } | undefined
): unknown {
  if (!transform) return chunk;

  const st: StreamTransform = { doneMarker: transform.doneMarker };
  if (transform.contentPath) {
    st.default = {
      choices: [{ index: 0, delta: { content: { $path: transform.contentPath } } }]
    };
  }

  return parseStreamChunk(chunk, st);
}
