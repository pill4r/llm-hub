/**
 * Consumer Plugins
 *
 * Import all consumer plugins to trigger registration.
 */

// Import consumer plugins to register them
import "./openai";
import "./anthropic";

export { consumerRegistry } from "./types";
export type { ConsumerPlugin } from "./types";
