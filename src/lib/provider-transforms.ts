/**
 * Built-in Provider Transform Configurations
 *
 * OpenAI and Anthropic converters are now expressed as declarative
 * transform configurations. Custom providers can use these as reference.
 */

import type { TransformConfig } from "./transform-engine";

// ========================================================================
// OpenAI Chat Completions API
// ========================================================================

export const openaiTransform: TransformConfig = {
  request: {
    body: {
      model: { $path: "model" },
      messages: {
        $map: {
          path: "messages",
          item: "m",
          produce: {
            role: { $path: "m.role" },
            content: {
              $if: {
                cond: { $eq: [{ $path: "m.role" }, { $literal: "assistant" }] },
                then: {
                  $if: {
                    cond: {
                      $exists: {
                        $path: "m.content",
                      },
                    },
                    then: {
                      $path: "m.content",
                    },
                    else: { $literal: null },
                  },
                },
                else: { $path: "m.content" },
              },
            },
          },
        },
      },
      temperature: { $path: "generation.temperature" },
      top_p: { $path: "generation.topP" },
      max_tokens: { $path: "generation.maxTokens" },
      stop: { $path: "generation.stopSequences" },
      frequency_penalty: { $path: "generation.frequencyPenalty" },
      presence_penalty: { $path: "generation.presencePenalty" },
      seed: { $path: "generation.seed" },
      tools: {
        $if: {
          cond: { $exists: { $path: "tools" } },
          then: {
            $map: {
              path: "tools",
              item: "t",
              produce: {
                type: { $literal: "function" },
                function: {
                  name: { $path: "t.name" },
                  description: { $path: "t.description" },
                  parameters: { $path: "t.parameters" },
                },
              },
            },
          },
        },
      },
      tool_choice: {
        $if: {
          cond: { $exists: { $path: "toolChoice" } },
          then: {
            $switch: {
              path: "toolChoice.type",
              cases: {
                tool: {
                  type: { $literal: "function" },
                  function: {
                    name: { $path: "toolChoice.name" },
                  },
                },
              },
              default: { $path: "toolChoice" },
            },
          },
        },
      },
      response_format: {
        $if: {
          cond: { $exists: { $path: "responseFormat" } },
          then: {
            $switch: {
              path: "responseFormat.type",
              cases: {
                json: { type: { $literal: "json_object" } },
                json_schema: {
                  type: { $literal: "json_schema" },
                  json_schema: {
                    name: { $path: "responseFormat.jsonSchema.name" },
                    description: { $path: "responseFormat.jsonSchema.description" },
                    schema: { $path: "responseFormat.jsonSchema.schema" },
                    strict: { $path: "responseFormat.jsonSchema.strict" },
                  },
                },
              },
            },
          },
        },
      },
      stream: {
        $if: {
          cond: { $eq: [{ $path: "stream.enabled" }, { $literal: true }] },
          then: { $literal: true },
        },
      },
      stream_options: {
        $if: {
          cond: { $eq: [{ $path: "stream.includeUsage" }, { $literal: true }] },
          then: { include_usage: { $literal: true } },
        },
      },
    },
    prepend: [
      {
        target: "messages",
        value: {
          $if: {
            cond: { $exists: { $path: "systemInstruction" } },
            then: {
              role: { $literal: "system" },
              content: { $path: "systemInstruction" },
            },
          },
        },
      },
    ],
  },

  response: {
    body: {
      id: { $path: "id" },
      model: { $path: "model" },
      choices: [
          {
            index: 0,
            message: {
              role: { $literal: "assistant" },
              content: { $path: "choices[0].message.content" },
              refusal: { $path: "choices[0].message.refusal" },
            },
            finishReason: { $path: "choices[0].finish_reason" },
          },
        ],
      usage: {
          promptTokens: { $path: "usage.prompt_tokens" },
          completionTokens: { $path: "usage.completion_tokens" },
          totalTokens: { $path: "usage.total_tokens" },
        },
    },
  },

  stream: {
    routeBy: "type",
    events: {
      text_delta: {
        type: { $literal: "text_delta" },
        index: { $path: "choices[0].index" },
        delta: { $path: "choices[0].delta.content" },
      },
      tool_call_start: {
        type: { $literal: "tool_call_start" },
        index: { $path: "choices[0].delta.tool_calls[0].index" },
        toolCallId: { $path: "choices[0].delta.tool_calls[0].id" },
        toolName: { $path: "choices[0].delta.tool_calls[0].function.name" },
      },
      tool_call_delta: {
        type: { $literal: "tool_call_delta" },
        index: { $path: "choices[0].delta.tool_calls[0].index" },
        toolCallId: { $path: "choices[0].delta.tool_calls[0].id" },
        delta: { $path: "choices[0].delta.tool_calls[0].function.arguments" },
      },
      usage: {
        type: { $literal: "usage" },
        usage: {
          promptTokens: { $path: "usage.prompt_tokens" },
          completionTokens: { $path: "usage.completion_tokens" },
          totalTokens: { $path: "usage.total_tokens" },
        },
      },
      finish: {
        type: { $literal: "finish" },
        finishReason: { $path: "choices[0].finish_reason" },
      },
    },
  },
};

// ========================================================================
// Anthropic Messages API
// ========================================================================

export const anthropicTransform: TransformConfig = {
  request: {
    body: {
      model: { $path: "model" },
      max_tokens: {
        $if: {
          cond: { $exists: { $path: "generation.maxTokens" } },
          then: { $path: "generation.maxTokens" },
          else: { $literal: 4096 },
        },
      },
      messages: {
        $map: {
          path: "messages",
          item: "m",
          produce: {
            role: { $path: "m.role" },
            content: { $path: "m.content" },
          },
        },
      },
      temperature: { $path: "generation.temperature" },
      top_p: { $path: "generation.topP" },
      top_k: { $path: "generation.topK" },
      stop_sequences: { $path: "generation.stopSequences" },
      stream: { $path: "stream.enabled" },
      tools: {
        $if: {
          cond: { $exists: { $path: "tools" } },
          then: {
            $map: {
              path: "tools",
              item: "t",
              produce: {
                name: { $path: "t.name" },
                description: { $path: "t.description" },
                input_schema: { $path: "t.parameters" },
              },
            },
          },
        },
      },
      tool_choice: {
        $if: {
          cond: { $exists: { $path: "toolChoice" } },
          then: {
            $switch: {
              path: "toolChoice",
              cases: {
                none: { type: { $literal: "none" } },
                auto: { type: { $literal: "auto" } },
                required: { type: { $literal: "any" } },
              },
              default: {
                type: { $literal: "tool" },
                name: { $path: "toolChoice.name" },
              },
            },
          },
        },
      },
    },
    prepend: [
      {
        target: "messages",
        value: {
          $if: {
            cond: { $exists: { $path: "systemInstruction" } },
            then: {
              role: { $literal: "system" },
              content: { $path: "systemInstruction" },
            },
          },
        },
      },
    ],
    remove: ["messages[0]"], // Remove system message from messages array (Anthropic handles it top-level)
  },

  response: {
    body: {
      id: { $path: "id" },
      model: { $path: "model" },
      choices: [
          {
            index: 0,
            message: {
              role: { $literal: "assistant" },
              content: { $path: "content" },
            },
            finishReason: { $path: "stop_reason" },
          },
        ],
      usage: {
          promptTokens: { $path: "usage.input_tokens" },
          completionTokens: { $path: "usage.output_tokens" },
          totalTokens: {
            $if: {
              cond: {
                $and: [
                  { $exists: { $path: "usage.input_tokens" } },
                  { $exists: { $path: "usage.output_tokens" } },
                ],
              },
              then: { $path: "usage.input_tokens" },
            },
          },
        },
    },
  },

  stream: {
    routeBy: "type",
    events: {
      message_start: {
        type: { $literal: "stream_start" },
        id: { $path: "message.id" },
        model: { $path: "message.model" },
      },
      content_block_delta: {
        type: { $literal: "text_delta" },
        index: { $path: "index" },
        delta: { $path: "delta.text" },
      },
      message_delta: {
        type: { $literal: "finish" },
        finishReason: { $path: "delta.stop_reason" },
      },
    },
  },
};
