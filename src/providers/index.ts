/**
 * Provider Registry
 *
 * Auto-imports all converters so they self-register.
 */

// Core protocol formats (wire protocols)
import "./openai/converter";
import "./anthropic/converter";

// Provider-specific converters that extend core protocols
import "./deepseek/converter";
import "./opencodego/converter";

// Export the registry for use elsewhere
export { registry } from "../core/converter";
