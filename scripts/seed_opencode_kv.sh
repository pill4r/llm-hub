#!/usr/bin/env bash
# Seed KV with OpenCode Go credentials for both OpenAI and Anthropic formats
#
# Usage:
#   export OPENCODE_KEY="sk-..."
#   export CLOUDFLARE_API_TOKEN=...
#   bash scripts/seed_opencode_kv.sh

set -e

KV_NS="74d8c4248b9c42039845bc9f837297a9"

if [ -z "$OPENCODE_KEY" ]; then
  echo "Error: Set OPENCODE_KEY environment variable"
  exit 1
fi

wrangler kv:key put "key:test-key-001:providers" \
  --namespace-id="$KV_NS" \
  --value="{
    \"openai\": {
      \"apiKey\": \"$OPENCODE_KEY\",
      \"baseUrl\": \"https://opencode.ai/zen/go/v1\"
    },
    \"deepseek\": {
      \"apiKey\": \"YOUR_DEEPSEEK_KEY\"
    },
    \"anthropic\": {
      \"apiKey\": \"$OPENCODE_KEY\",
      \"baseUrl\": \"https://opencode.ai/zen/go/v1\"
    }
  }"

echo "KV seeded successfully."