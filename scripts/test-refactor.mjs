/**
 * Test OpenAIConverter dynamic config refactor
 */

const BASE = "http://localhost:8787";
const AUTH = "Bearer hub_dev_fallback_key_for_testing_only";

async function test(name, fn) {
  try {
    const result = await fn();
    console.log(`✅ ${name}:`, typeof result === "string" ? result : JSON.stringify(result));
  } catch (e) {
    console.error(`❌ ${name}:`, e.message);
  }
}

// Step 1: List providers (builtin should still work)
test("List providers", async () => {
  const res = await fetch(`${BASE}/admin/providers`, { headers: { Authorization: AUTH } });
  const data = await res.json();
  const ids = data.providers?.map((p) => p.providerId) || [];
  return ids.join(", ");
});

// Step 2: Register a dynamic provider using openai-compatible protocol
test("Register dynamic provider", async () => {
  const res = await fetch(`${BASE}/admin/providers`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: AUTH },
    body: JSON.stringify({
      providerId: "test-dynamic",
      displayName: "Test Dynamic",
      protocol: "openai-compatible",
      baseUrl: "https://api.openai.com/v1",
      authType: "bearer",
      models: [{ id: "gpt-4o", name: "GPT-4o" }],
    }),
  });
  return await res.json();
});

// Step 3: Test connectivity
test("Test connectivity", async () => {
  const res = await fetch(`${BASE}/admin/providers/test-dynamic/test`, {
    method: "POST",
    headers: { Authorization: AUTH },
  });
  return await res.json();
});

// Step 4: OpenAI consumer → dynamic provider
test("Chat via dynamic provider", async () => {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: AUTH },
    body: JSON.stringify({
      model: "test-dynamic/gpt-4o",
      messages: [{ role: "user", content: "Say hi" }],
      max_tokens: 10,
    }),
  });
  const data = await res.json();
  return data.choices?.[0]?.message?.content || `Error: ${JSON.stringify(data)}`;
});

// Step 5: Delete dynamic provider
test("Delete dynamic provider", async () => {
  const res = await fetch(`${BASE}/admin/providers/test-dynamic`, {
    method: "DELETE",
    headers: { Authorization: AUTH },
  });
  return await res.json();
});
