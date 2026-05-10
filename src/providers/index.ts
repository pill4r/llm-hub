/**
 * Provider Registry
 *
 * Auto-imports all converters so they self-register.
 */

// Import converters to trigger registration
import "./openai/converter";
import "./deepseek/converter";
import "./opencodego/converter";

// Export the registry for use elsewhere
export { registry } from "../core/converter";
