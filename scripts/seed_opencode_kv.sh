#!/usr/bin/env bash
# Seed KV with OpenCode Go credentials for both OpenAI and Anthropic formats
#
# Run locally (needs CLOUDFLARE_API_TOKEN env var or wrangler login):
#   export CLOUDFLARE_API_TOKEN=...
#   bash scripts/seed_opencode_kv.sh

set -e

KV_NS="74d8c4248b9c42039845bc9f837297a9"

# Update the test key's provider mapping to include opencode-go
# Both openai and anthropic use the same baseUrl but different endpoints
wrangler kv:key put "key:test-key-001:providers" \
  --namespace-id="$KV_NS" \
  --value='{
    "openai": {
      "apiKey": "sk-r5Wa04xRzxOvWE7sXmpdgLsMsI8RIWIQiiKf0MuSKsMoJ7lqQwMHwwajPplUrmW5",
      "baseUrl": "https://opencode.ai/zen/go/v1"
    },
    "deepseek": {
      "apiKey": "YOUR_DEEPSEEK_KEY"
    },
    "anthropic": {
      "apiKey": "sk-r5Wa04xRzxOvWE7sXmpdgLsMsI8RIWIQiiKf0MuSKsMoJ7lqQwMHwwajPplUrmW5",
      "baseUrl": "https://opencode.ai/zen/go/v1"
    }
  }'

echo "KV seeded successfully."
