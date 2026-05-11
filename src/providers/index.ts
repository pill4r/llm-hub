/**
 * Provider Plugins
 *
 * Import all provider plugins to trigger registration.
 */

// Import provider plugins to register them
import "./openai";
import "./anthropic";

export { providerRegistry } from "./types";
export type { ProviderPlugin, ProviderCapabilities } from "./types";
