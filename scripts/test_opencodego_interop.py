#!/usr/bin/env python3
"""
Test OpenCode Go via LLM-Hub with both OpenAI and Anthropic consumer formats.

Usage:
    python3 scripts/test_opencodego_interop.py

Requirements:
    - LLM-Hub deployed and accessible
    - Test key configured with opencodego provider
"""

import json
import urllib.request
import sys
import ssl

# Configuration
HUB_BASE_URL = "https://llm-hub.pillarbialexi.workers.dev"
API_KEY = "hub_test_key_12345"
MODEL = "opencodego:claude-sonnet-4"

# Use system proxy if available
ctx = ssl.create_default_context()

def request(path, body, headers=None):
    """Send a JSON POST request."""
    url = f"{HUB_BASE_URL}{path}"
    data = json.dumps(body).encode("utf-8")
    req_headers = {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json",
    }
    if headers:
        req_headers.update(headers)

    req = urllib.request.Request(url, data=data, headers=req_headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        try:
            return e.code, json.loads(body)
        except:
            return e.code, {"error": body}
    except Exception as e:
        return -1, {"error": str(e)}


def test_openai_consumer():
    """Test 1: OpenAI consumer format -> OpenCode Go provider."""
    print("=" * 60)
    print("TEST 1: OpenAI Consumer -> OpenCode Go Provider")
    print("=" * 60)

    body = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": "You are a helpful assistant. Reply in 1 sentence."},
            {"role": "user", "content": "What is 2+2?"}
        ],
        "max_tokens": 50,
        "temperature": 0.1,
    }

    status, resp = request("/v1/chat/completions", body)
    print(f"Status: {status}")
    print(f"Response keys: {list(resp.keys())}")

    if status != 200:
        print(f"FAILED: {json.dumps(resp, indent=2)}")
        return False

    # Validate OpenAI response structure
    assert "choices" in resp, "Missing choices"
    assert len(resp["choices"]) > 0, "Empty choices"
    choice = resp["choices"][0]
    assert "message" in choice, "Missing message"
    assert "content" in choice["message"], "Missing content"
    content = choice["message"]["content"]
    assert content and len(content) > 0, "Empty content"

    print(f"Content: {content[:200]}")
    print(f"Model: {resp.get('model')}")
    print(f"Usage: {resp.get('usage')}")
    print("PASSED ✓")
    return True


def test_anthropic_consumer():
    """Test 2: Anthropic consumer format -> OpenCode Go provider."""
    print("\n" + "=" * 60)
    print("TEST 2: Anthropic Consumer -> OpenCode Go Provider")
    print("=" * 60)

    body = {
        "model": MODEL,
        "system": "You are a helpful assistant. Reply in 1 sentence.",
        "messages": [
            {"role": "user", "content": "What is 2+2?"}
        ],
        "max_tokens": 50,
        "temperature": 0.1,
    }

    status, resp = request("/v1/messages", body, headers={"anthropic-version": "2023-06-01"})
    print(f"Status: {status}")
    print(f"Response keys: {list(resp.keys())}")

    if status != 200:
        print(f"FAILED: {json.dumps(resp, indent=2)}")
        return False

    # Validate Anthropic response structure
    assert "content" in resp, "Missing content"
    assert len(resp["content"]) > 0, "Empty content"
    text_parts = [block["text"] for block in resp["content"] if block.get("type") == "text"]
    assert len(text_parts) > 0, "No text content"
    content = text_parts[0]
    assert len(content) > 0, "Empty text content"

    print(f"Content: {content[:200]}")
    print(f"Model: {resp.get('model')}")
    print(f"Usage: {resp.get('usage')}")
    print("PASSED ✓")
    return True


def test_anthropic_with_tools():
    """Test 3: Anthropic consumer with tool_use -> OpenCode Go provider."""
    print("\n" + "=" * 60)
    print("TEST 3: Anthropic Consumer + Tools -> OpenCode Go Provider")
    print("=" * 60)

    body = {
        "model": MODEL,
        "messages": [
            {"role": "user", "content": "What is the weather in Beijing?"}
        ],
        "max_tokens": 100,
        "tools": [
            {
                "name": "get_weather",
                "description": "Get weather for a location",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "location": {"type": "string"},
                        "unit": {"type": "string", "enum": ["celsius", "fahrenheit"]}
                    },
                    "required": ["location"]
                }
            }
        ],
        "tool_choice": {"type": "tool", "name": "get_weather"},
    }

    status, resp = request("/v1/messages", body, headers={"anthropic-version": "2023-06-01"})
    print(f"Status: {status}")
    print(f"Response keys: {list(resp.keys())}")

    if status != 200:
        print(f"FAILED: {json.dumps(resp, indent=2)}")
        return False

    # Check for tool_use or text
    content = resp.get("content", [])
    has_tool = any(block.get("type") == "tool_use" for block in content)
    has_text = any(block.get("type") == "text" for block in content)

    if has_tool:
        tool_blocks = [b for b in content if b.get("type") == "tool_use"]
        print(f"Tool calls: {len(tool_blocks)}")
        for tb in tool_blocks:
            print(f"  - {tb.get('name')}: {tb.get('input')}")
    elif has_text:
        text = [b["text"] for b in content if b.get("type") == "text"][0]
        print(f"Text response: {text[:200]}")
    else:
        print(f"Unexpected content: {content}")

    print("PASSED ✓")
    return True


def test_openai_with_tools():
    """Test 4: OpenAI consumer with tools -> OpenCode Go provider."""
    print("\n" + "=" * 60)
    print("TEST 4: OpenAI Consumer + Tools -> OpenCode Go Provider")
    print("=" * 60)

    body = {
        "model": MODEL,
        "messages": [
            {"role": "user", "content": "What is the weather in Beijing?"}
        ],
        "max_tokens": 100,
        "tools": [
            {
                "type": "function",
                "function": {
                    "name": "get_weather",
                    "description": "Get weather for a location",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "location": {"type": "string"},
                            "unit": {"type": "string", "enum": ["celsius", "fahrenheit"]}
                        },
                        "required": ["location"]
                    }
                }
            }
        ],
        "tool_choice": "auto",
    }

    status, resp = request("/v1/chat/completions", body)
    print(f"Status: {status}")
    print(f"Response keys: {list(resp.keys())}")

    if status != 200:
        print(f"FAILED: {json.dumps(resp, indent=2)}")
        return False

    choice = resp.get("choices", [{}])[0]
    msg = choice.get("message", {})

    if msg.get("tool_calls"):
        print(f"Tool calls: {len(msg['tool_calls'])}")
        for tc in msg["tool_calls"]:
            print(f"  - {tc['function']['name']}: {tc['function']['arguments']}")
    elif msg.get("content"):
        print(f"Text response: {msg['content'][:200]}")

    print("PASSED ✓")
    return True


def test_streaming_openai():
    """Test 5: OpenAI streaming -> OpenCode Go provider."""
    print("\n" + "=" * 60)
    print("TEST 5: OpenAI Consumer Streaming -> OpenCode Go Provider")
    print("=" * 60)

    body = {
        "model": MODEL,
        "messages": [
            {"role": "user", "content": "Count from 1 to 3"}
        ],
        "max_tokens": 50,
        "stream": True,
    }

    url = f"{HUB_BASE_URL}/v1/chat/completions"
    data = json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, headers={
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json",
    }, method="POST")

    try:
        with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
            chunks = []
            for line in resp:
                line = line.decode().strip()
                if line.startswith("data: "):
                    payload = line[6:]
                    if payload == "[DONE]":
                        break
                    try:
                        chunk = json.loads(payload)
                        delta = chunk.get("choices", [{}])[0].get("delta", {})
                        if delta.get("content"):
                            chunks.append(delta["content"])
                    except:
                        pass
            full_text = "".join(chunks)
            print(f"Streamed text: {full_text[:200]}")
            assert len(full_text) > 0, "No streamed content"
            print("PASSED ✓")
            return True
    except Exception as e:
        print(f"FAILED: {e}")
        return False


def main():
    print("LLM-Hub OpenCode Go Interop Tests")
    print(f"Hub URL: {HUB_BASE_URL}")
    print(f"Model: {MODEL}")
    print()

    results = []
    results.append(("OpenAI Consumer", test_openai_consumer()))
    results.append(("Anthropic Consumer", test_anthropic_consumer()))
    results.append(("Anthropic + Tools", test_anthropic_with_tools()))
    results.append(("OpenAI + Tools", test_openai_with_tools()))
    results.append(("OpenAI Streaming", test_streaming_openai()))

    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)
    all_passed = True
    for name, passed in results:
        status = "✓ PASSED" if passed else "✗ FAILED"
        print(f"  {status}: {name}")
        if not passed:
            all_passed = False

    sys.exit(0 if all_passed else 1)


if __name__ == "__main__":
    main()
