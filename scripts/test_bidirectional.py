#!/usr/bin/env python3
"""
LLM-Hub Bidirectional Converter Test

Tests two cross-format scenarios using OpenCode Go:
1. OpenAI consumer → Anthropic provider (MiniMax via /v1/messages)
2. Anthropic consumer → OpenAI provider (Kimi via /v1/chat/completions)

Prerequisites:
  pip install requests

Usage:
  export LLMHUB_KEY="hub_test_key_12345"
  python3 scripts/test_bidirectional.py
"""

import os
import json
import sys
import time

LLMHUB_URL = "https://llm-hub.pillarbialexi.workers.dev"
LLMHUB_KEY = os.environ.get("LLMHUB_KEY", "hub_test_key_12345")

def req(path, body, headers=None):
    import requests
    h = {
        "Authorization": f"Bearer {LLMHUB_KEY}",
        "Content-Type": "application/json",
    }
    if headers:
        h.update(headers)
    r = requests.post(f"{LLMHUB_URL}{path}", json=body, headers=h, timeout=60)
    return r

def test_1_openai_consumer_to_anthropic_provider():
    """
    OpenAI client calls /v1/chat/completions on llm-hub,
    llm-hub routes to Anthropic provider (OpenCode Go MiniMax).
    Consumer sees OpenAI format; provider speaks Anthropic format.
    """
    print("=" * 60)
    print("测试 1: OpenAI consumer → Anthropic provider (MiniMax M2.7)")
    print("=" * 60)

    body = {
        "model": "anthropic:minimax-m2.7",
        "messages": [
            {"role": "system", "content": "You are a helpful assistant."},
            {"role": "user", "content": "Say hello in exactly 3 words."},
        ],
        "max_tokens": 64,
        "temperature": 0.7,
    }

    r = req("/v1/chat/completions", body)
    print(f"Status: {r.status_code}")

    try:
        data = r.json()
    except Exception as e:
        print(f"Parse error: {e}")
        print(f"Raw: {r.text[:500]}")
        return False

    # Validate OpenAI-format response
    assert "choices" in data, "Missing 'choices' in OpenAI response"
    assert data["object"] == "chat.completion", f"Wrong object: {data.get('object')}"
    assert data["choices"][0]["message"]["role"] == "assistant"
    content = data["choices"][0]["message"].get("content", "")
    print(f"✓ Response format: OpenAI chat.completion")
    print(f"✓ Content: {content[:100]}")
    print(f"✓ Usage: {data.get('usage')}")
    return True

def test_2_anthropic_consumer_to_openai_provider():
    """
    Anthropic client calls /v1/messages on llm-hub,
    llm-hub routes to OpenAI provider (OpenCode Go Kimi).
    Consumer sees Anthropic format; provider speaks OpenAI format.
    """
    print()
    print("=" * 60)
    print("测试 2: Anthropic consumer → OpenAI provider (Kimi K2.6)")
    print("=" * 60)

    body = {
        "model": "openai:kimi-k2.6",
        "system": "You are a helpful assistant.",
        "messages": [
            {"role": "user", "content": "Say hello in exactly 3 words."},
        ],
        "max_tokens": 64,
        "temperature": 0.7,
    }

    # Anthropic client headers
    headers = {
        "x-api-key": LLMHUB_KEY,
        "anthropic-version": "2023-06-01",
    }

    r = req("/v1/messages", body, headers)
    print(f"Status: {r.status_code}")

    try:
        data = r.json()
    except Exception as e:
        print(f"Parse error: {e}")
        print(f"Raw: {r.text[:500]}")
        return False

    # Validate Anthropic-format response
    assert data.get("type") == "message", f"Wrong type: {data.get('type')}"
    assert data.get("role") == "assistant"
    assert "content" in data, "Missing 'content' in Anthropic response"
    content_blocks = data["content"]
    text = "".join(b.get("text", "") for b in content_blocks if b.get("type") == "text")
    print(f"✓ Response format: Anthropic message")
    print(f"✓ Content: {text[:100]}")
    print(f"✓ Usage: {data.get('usage')}")
    return True

def test_3_openai_consumer_streaming_to_anthropic_provider():
    """
    OpenAI streaming request routed to Anthropic provider.
    """
    print()
    print("=" * 60)
    print("测试 3: OpenAI streaming → Anthropic provider (MiniMax M2.7)")
    print("=" * 60)

    body = {
        "model": "anthropic:minimax-m2.7",
        "messages": [{"role": "user", "content": "Count 1,2,3"}],
        "max_tokens": 64,
        "stream": True,
    }

    import requests
    h = {
        "Authorization": f"Bearer {LLMHUB_KEY}",
        "Content-Type": "application/json",
    }
    r = requests.post(f"{LLMHUB_URL}/v1/chat/completions", json=body, headers=h, timeout=60, stream=True)
    print(f"Status: {r.status_code}")

    chunks = []
    for line in r.iter_lines():
        if line:
            text = line.decode("utf-8")
            if text.startswith("data: "):
                data = text[6:]
                if data == "[DONE]":
                    break
                try:
                    chunk = json.loads(data)
                    if chunk.get("choices") and chunk["choices"][0].get("delta", {}).get("content"):
                        chunks.append(chunk["choices"][0]["delta"]["content"])
                except:
                    pass

    full = "".join(chunks)
    print(f"✓ Streamed {len(chunks)} chunks")
    print(f"✓ Content: {full[:100]}")
    return len(chunks) > 0

def test_4_anthropic_consumer_streaming_to_openai_provider():
    """
    Anthropic streaming request routed to OpenAI provider.
    """
    print()
    print("=" * 60)
    print("测试 4: Anthropic streaming → OpenAI provider (Kimi K2.6)")
    print("=" * 60)

    body = {
        "model": "openai:kimi-k2.6",
        "messages": [{"role": "user", "content": "Count 1,2,3"}],
        "max_tokens": 64,
        "stream": True,
    }

    import requests
    h = {
        "Authorization": f"Bearer {LLMHUB_KEY}",
        "x-api-key": LLMHUB_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
    }
    r = requests.post(f"{LLMHUB_URL}/v1/messages", json=body, headers=h, timeout=60, stream=True)
    print(f"Status: {r.status_code}")

    chunks = []
    for line in r.iter_lines():
        if line:
            text = line.decode("utf-8")
            if text.startswith("data: "):
                data = text[6:]
                try:
                    chunk = json.loads(data)
                    delta = chunk.get("delta", {})
                    if delta.get("text"):
                        chunks.append(delta["text"])
                except:
                    pass

    full = "".join(chunks)
    print(f"✓ Streamed {len(chunks)} chunks")
    print(f"✓ Content: {full[:100]}")
    return len(chunks) > 0

def main():
    results = []
    try:
        results.append(("测试1", test_1_openai_consumer_to_anthropic_provider()))
    except Exception as e:
        print(f"✗ 测试1 失败: {e}")
        results.append(("测试1", False))

    try:
        results.append(("测试2", test_2_anthropic_consumer_to_openai_provider()))
    except Exception as e:
        print(f"✗ 测试2 失败: {e}")
        results.append(("测试2", False))

    try:
        results.append(("测试3", test_3_openai_consumer_streaming_to_anthropic_provider()))
    except Exception as e:
        print(f"✗ 测试3 失败: {e}")
        results.append(("测试3", False))

    try:
        results.append(("测试4", test_4_anthropic_consumer_streaming_to_openai_provider()))
    except Exception as e:
        print(f"✗ 测试4 失败: {e}")
        results.append(("测试4", False))

    print()
    print("=" * 60)
    print("测试总结")
    print("=" * 60)
    all_pass = True
    for name, ok in results:
        status = "✅ 通过" if ok else "❌ 失败"
        print(f"  {name}: {status}")
        if not ok:
            all_pass = False

    sys.exit(0 if all_pass else 1)

if __name__ == "__main__":
    main()
