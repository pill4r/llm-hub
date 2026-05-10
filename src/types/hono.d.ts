/**
 * Hono Context Type Extensions
 *
 * Declares custom variables that can be stored in Hono context.
 */

declare module "hono" {
  interface ContextVariableMap {
    keyRecord: import("../middleware/auth").KeyRecord;
    providerKeys: Record<string, import("../middleware/auth").ProviderKeyRecord>;
    providerId: string;
    model: string;
    usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  }
}

export {};
