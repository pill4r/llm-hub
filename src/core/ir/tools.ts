/**
 * IR Tool Types
 *
 * Unified tool definition and tool choice representation.
 */

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameters;
}

export interface ToolParameters {
  type: "object";
  properties: Record<string, ToolParameterSchema>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolParameterSchema {
  type: string;
  description?: string;
  enum?: unknown[];
  items?: ToolParameterSchema;
  properties?: Record<string, ToolParameterSchema>;
  required?: string[];
}

export type ToolChoice =
  | "auto"
  | "required"
  | "none"
  | { type: "tool"; name: string };

export interface ToolConfig {
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
}
