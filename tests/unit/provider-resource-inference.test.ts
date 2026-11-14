import assert from "node:assert/strict";
import test from "node:test";
import { createChatPipelineHarness } from "../integration/_chatPipelineHarness.ts";

const h = await createChatPipelineHarness("provider-resource-inference");
const { upsertSessionAccountAffinity } = await import("../../src/lib/db/sessionAccountAffinity.ts");
const responsesRoute = await import("../../src/app/api/v1/responses/route.ts");
const geminiRoute = await import("../../src/app/api/v1beta/models/[...path]/route.ts");
const { saveProviderResourceBinding } = await import("../../src/lib/db/providerResources.ts");
const { setBackgroundDegradationConfig } =
  await import("../../open-sse/services/backgroundTaskDetector.ts");
const { setCustomAliases } = await import("../../open-sse/services/modelDeprecation.ts");
const { setPayloadRulesConfig, resetPayloadRulesConfigForTests } =
  await import("../../open-sse/services/payloadRules.ts");
const { upsertUpstreamProxyConfig } = await import("../../src/lib/db/upstreamProxy.ts");
const { clearUpstreamProxyConfigCache } =
  await import("../../open-sse/handlers/chatCore/comboContextCache.ts");
const originalFetch = globalThis.fetch;

type Attempt = { url: string; key: string | null; headers: Headers; body: Record<string, unknown> };
let attempts: Attempt[] = [];
let failureStatus = 0;
let responseDelayMs = 0;

function nativeResponsesResult(stream: boolean) {
  const response = {
    id: "resp_resource_fixture",
    object: "response",
    created_at: 1,
    status: "completed",
    model: "gpt-4o-mini",
    output: [
      {
        id: "msg_resource_fixture",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "fixture response", annotations: [] }],
      },
    ],
    usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
  };
  if (!stream) return Response.json(response);
  return new Response(
    [
      {
        type: "response.output_text.delta",
        item_id: "msg_resource_fixture",
        delta: "fixture response",
      },
      { type: "response.completed", response },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join(""),
    { headers: { "Content-Type": "text/event-stream" } }
  );
}

test.beforeEach(async () => {
  await h.resetStorage();
  attempts = [];
  failureStatus = 0;
  responseDelayMs = 0;
  setBackgroundDegradationConfig({ enabled: false, degradationMap: {} });
  setCustomAliases({});
  resetPayloadRulesConfigForTests();
  clearUpstreamProxyConfigCache();
  h.BaseExecutor.RETRY_CONFIG.delayMs = 0;
  await h.settingsDb.updateSettings({ requestRetry: 0, maxRetryIntervalSec: 0 });
  globalThis.fetch = async (input, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = new Headers(init.headers);
    const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
    attempts.push({
      url,
      headers,
      key:
        headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? headers.get("x-goog-api-key"),
      body,
    });
    if (responseDelayMs) await new Promise((resolve) => setTimeout(resolve, responseDelayMs));
    if (failureStatus) {
      return Response.json(
        { error: { type: "rate_limit_error", message: "fixture account unavailable" } },
        { status: failureStatus, headers: { "Retry-After": "1" } }
      );
    }
    if (url.includes("generativelanguage.googleapis.com")) return h.buildGeminiResponse();
    if (url.endsWith("/responses")) return nativeResponsesResult(body.stream === true);
    return h.buildOpenAIResponse();
  };
});
test.afterEach(() => {
  globalThis.fetch = originalFetch;
  setBackgroundDegradationConfig({ enabled: false, degradationMap: {} });
  setCustomAliases({});
  resetPayloadRulesConfigForTests();
});
test.after(() => h.cleanup());

function chat(
  headers: Record<string, string>,
  overrides: Record<string, unknown> = {},
  authKey?: string
) {
  return h.handleChat(
    h.buildRequest({
      authKey,
      headers,
      body: {
        model: "openai/gpt-4o-mini",
        stream: false,
        messages: [{ role: "user", content: `resource prompt ${crypto.randomUUID()}` }],
        ...overrides,
      },
    })
  );
}

async function seedPair() {
  const first = await h.seedConnection("openai", {
    name: "native-zero",
    apiKey: "fixture-primary-zero",
    priority: 1,
  });
  const second = await h.seedConnection("openai", {
    name: "native-one",
    apiKey: "fixture-primary-one",
    priority: 2,
  });
  return { first, second };
}

test("provider index selects the requested primary connection and reports its stable id", async () => {
  const { second } = await seedPair();
  const response = await chat({ "x-omniroute-provider": "openai", "x-omniroute-key-index": "1" });
  await response.text();
  assert.equal(response.status, 200);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].key, "fixture-primary-one");
  assert.equal(response.headers.get("x-omniroute-selected-connection-id"), second.id);
  assert.equal(response.headers.get("x-omniroute-provider"), "openai");
  assert.equal(response.headers.get("x-omniroute-key-index"), "1");
});

test("provider without index uses zero and never rotates nested extra keys", async () => {
  await h.seedConnection("openai", {
    apiKey: "fixture-primary-zero",
    providerSpecificData: { extraApiKeys: ["fixture-extra-key"] },
  });
  for (let i = 0; i < 3; i += 1) {
    const response = await chat({ "x-omniroute-provider": "openai" });
    await response.text();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-omniroute-key-index"), "0");
  }
  assert.deepEqual(
    attempts.map((attempt) => attempt.key),
    Array(3).fill("fixture-primary-zero")
  );
});

test("stable connection followup wins over reordered indices", async () => {
  const { second } = await seedPair();
  const response = await chat({
    "x-omniroute-provider": "openai",
    "x-omniroute-connection": second.id as string,
  });
  await response.text();
  assert.equal(response.status, 200);
  assert.equal(attempts[0].key, "fixture-primary-one");
});

for (const blocked of ["inactive", "cooldown"] as const) {
  test(`selected ${blocked} index zero cannot fall through to its healthy sibling`, async () => {
    await h.seedConnection("openai", {
      name: "native-blocked",
      apiKey: "fixture-blocked",
      priority: 1,
      ...(blocked === "inactive"
        ? { isActive: false }
        : { rateLimitedUntil: new Date(Date.now() + 60_000).toISOString() }),
    });
    await h.seedConnection("openai", {
      name: "native-healthy",
      apiKey: "fixture-healthy-sibling",
      priority: 2,
    });
    const response = await chat({ "x-omniroute-provider": "openai" });
    await response.text();
    assert.ok(response.status >= 400);
    assert.equal(attempts.length, 0);
  });
}

test("API-key scope cannot renumber index zero to a permitted sibling", async () => {
  const { second } = await seedPair();
  const key = await h.seedApiKey({ allowedConnections: [second.id as string] });
  const response = await chat({ "x-omniroute-provider": "openai" }, {}, key.key);
  await response.text();
  assert.equal(response.status, 403);
  assert.equal(attempts.length, 0);
});

test("session affinity cannot replace the explicitly indexed connection", async () => {
  const { second } = await seedPair();
  await h.settingsDb.updateSettings({ sessionAffinityTtlMs: 60_000 });
  upsertSessionAccountAffinity(
    "header:native-resource-session",
    "openai",
    second.id as string,
    Date.now(),
    60_000
  );
  const response = await chat({
    "x-omniroute-provider": "openai",
    "x-session-id": "native-resource-session",
  });
  await response.text();
  assert.equal(response.status, 200);
  assert.equal(attempts[0].key, "fixture-primary-zero");
});

test("a selected account's upstream failure cannot use a healthy sibling", async () => {
  await seedPair();
  failureStatus = 429;
  const response = await chat({ "x-omniroute-provider": "openai" });
  await response.text();
  assert.equal(response.status, 429);
  assert.ok(attempts.length >= 1);
  assert.ok(attempts.every((attempt) => attempt.key === "fixture-primary-zero"));
});

test("provider mismatch is rejected before inference", async () => {
  await seedPair();
  await h.seedConnection("gemini");
  const response = await chat({ "x-omniroute-provider": "gemini" });
  await response.text();
  assert.equal(response.status, 400);
  assert.equal(attempts.length, 0);
});

test("selected native inference rejects configured combos and model aliases", async () => {
  await seedPair();
  await h.combosDb.createCombo({
    name: "native-pool",
    strategy: "priority",
    models: ["openai/gpt-4o-mini"],
  });
  await h.settingsDb.updateSettings({ modelAliases: { "native-alias": "openai/gpt-4o-mini" } });
  for (const model of ["native-pool", "combo/native-pool", "native-alias"]) {
    const response = await chat({ "x-omniroute-provider": "openai" }, { model });
    await response.text();
    assert.equal(response.status, 400, model);
  }
  assert.equal(attempts.length, 0);
});

test("native selection uses the official origin and identical OpenAI project context", async () => {
  await h.seedConnection("openai", {
    apiKey: "fixture-official-primary",
    providerSpecificData: {
      baseUrl: "https://custom.invalid/v1",
      customHeaders: {
        "OpenAI-Project": "fixture-project",
        "OpenAI-Organization": "fixture-org",
        Authorization: "Bearer fixture-wrong",
      },
    },
  });
  const response = await chat({ "x-omniroute-provider": "openai" });
  await response.text();
  assert.equal(response.status, 200);
  assert.equal(attempts[0].url, "https://api.openai.com/v1/chat/completions");
  assert.equal(attempts[0].key, "fixture-official-primary");
  assert.equal(attempts[0].headers.get("openai-project"), "fixture-project");
  assert.equal(attempts[0].headers.get("openai-organization"), "fixture-org");
});

test("idempotency and semantic caches cannot replay another selected account's response", async () => {
  await seedPair();
  await h.settingsDb.updateSettings({ semanticCacheEnabled: true });
  const body = {
    temperature: 0,
    messages: [{ role: "user", content: "identical provider resource request" }],
  };
  for (const index of ["0", "1"]) {
    const response = await chat(
      {
        "x-omniroute-provider": "openai",
        "x-omniroute-key-index": index,
        "idempotency-key": "fixture-shared-idempotency",
      },
      body
    );
    await response.text();
    assert.equal(response.status, 200);
  }
  assert.deepEqual(
    attempts.map((attempt) => attempt.key),
    ["fixture-primary-zero", "fixture-primary-one"]
  );
});

test("idempotency distinguishes owned Gemini cache references on the same account", async () => {
  const connection = await h.seedConnection("gemini", { apiKey: "fixture-google-primary" });
  const key = await h.seedApiKey();
  const cacheNames = ["cachedContents/fixture-one", "cachedContents/fixture-two"];
  for (const cachedContent of cacheNames) {
    saveProviderResourceBinding({
      provider: "gemini",
      connectionId: connection.id as string,
      kind: "cache",
      resourceId: cachedContent,
      apiKeyId: key.id,
      metadata: {},
    });
    const response = await chat(
      { "x-omniroute-provider": "gemini", "idempotency-key": "fixture-cache-references" },
      {
        model: "gemini/gemini-2.5-flash",
        cachedContent,
        messages: [{ role: "user", content: "summarize the cached document" }],
      },
      key.key
    );
    assert.equal(response.status, 200, await response.text());
  }
  assert.deepEqual(
    attempts.map((attempt) => attempt.body.cachedContent),
    cacheNames
  );
});

test("concurrent native Responses with different upstream continuations cannot share a call", async () => {
  await seedPair();
  responseDelayMs = 300;
  const continuations = ["resp_fixture_one", "resp_fixture_two"];
  const responses = await Promise.all(
    continuations.map(async (previous_response_id, index) => {
      if (index) await new Promise((resolve) => setTimeout(resolve, 40));
      const response = await responsesRoute.POST(
        h.buildRequest({
          url: "http://localhost/v1/responses",
          headers: { "x-omniroute-provider": "openai" },
          body: {
            model: "gpt-4o-mini",
            stream: false,
            temperature: 0,
            input: "continue",
            previous_response_id,
          },
        })
      );
      assert.equal(response.status, 200, await response.text());
      return response;
    })
  );
  assert.equal(responses.length, 2);
  assert.deepEqual(
    attempts.map((attempt) => attempt.body.previous_response_id).sort(),
    [...continuations].sort()
  );
});

test("a key index without a provider is rejected before inference", async () => {
  await seedPair();
  const response = await chat({ "x-omniroute-key-index": "0" });
  await response.text();
  assert.equal(response.status, 400);
  assert.equal(attempts.length, 0);
});

test("selected OpenAI Responses use the native endpoint and retain cache controls", async () => {
  await seedPair();
  const response = await h.handleChat(
    h.buildRequest({
      url: "http://localhost/v1/responses",
      headers: { "x-omniroute-provider": "openai", "x-omniroute-key-index": "1" },
      body: {
        model: "openai/gpt-4o-mini",
        stream: false,
        input: [{ role: "user", content: [{ type: "input_text", text: "native resource" }] }],
        store: true,
        prompt_cache_key: "fixture-cache-affinity",
        prompt_cache_retention: "24h",
        metadata: { purpose: "resource-test" },
      },
    })
  );
  await response.text();
  assert.equal(response.status, 200);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].url, "https://api.openai.com/v1/responses");
  assert.equal(attempts[0].key, "fixture-primary-one");
  assert.equal(attempts[0].body.store, true);
  assert.equal(attempts[0].body.prompt_cache_key, "fixture-cache-affinity");
  assert.equal(attempts[0].body.prompt_cache_retention, "24h");
  assert.deepEqual(attempts[0].body.metadata, { purpose: "resource-test" });
  assert.ok(Array.isArray(attempts[0].body.input));
  assert.equal(attempts[0].body.messages, undefined);
});

test("Responses model preference cannot rewrite a selected OpenAI provider to Codex", async () => {
  const request = h.buildRequest({
    url: "http://localhost/v1/responses",
    headers: { "x-omniroute-provider": "openai" },
    body: { model: "gpt-5.5", input: "fixture", stream: false },
  });
  const resolved = await responsesRoute.withCodexPreferredModel(request);
  assert.equal(resolved.body.model, "gpt-5.5");
});

for (const stream of [false, true]) {
  test(`native Responses stream=${stream} keeps owned file ids on the selected account`, async () => {
    const { second } = await seedPair();
    const key = await h.seedApiKey();
    saveProviderResourceBinding({
      provider: "openai",
      connectionId: second.id as string,
      kind: "file",
      resourceId: "file-owned-fixture",
      apiKeyId: key.id,
      metadata: {},
    });
    const response = await responsesRoute.POST(
      h.buildRequest({
        url: "http://localhost/v1/responses",
        authKey: key.key,
        headers: { "x-omniroute-provider": "openai", "x-omniroute-key-index": "1" },
        body: {
          model: "gpt-4o-mini",
          stream,
          input: [
            {
              role: "user",
              content: [
                { type: "input_text", text: "summarize the file" },
                { type: "input_file", file_id: "file-owned-fixture" },
              ],
            },
          ],
          store: true,
        },
      })
    );
    const text = await response.text();
    assert.equal(response.status, 200, text);
    assert.equal(response.headers.get("x-omniroute-selected-connection-id"), second.id);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].url, "https://api.openai.com/v1/responses");
    assert.equal(attempts[0].key, "fixture-primary-one");
    assert.deepEqual(attempts[0].body.input, [
      {
        role: "user",
        content: [
          { type: "input_text", text: "summarize the file" },
          { type: "input_file", file_id: "file-owned-fixture" },
        ],
      },
    ]);
    assert.ok(text.includes("fixture response"));
  });
}

test("foreign or differently connected file ids are refused before native inference", async () => {
  const { second } = await seedPair();
  const key = await h.seedApiKey();
  saveProviderResourceBinding({
    provider: "openai",
    connectionId: second.id as string,
    kind: "file",
    resourceId: "file-foreign-fixture",
    apiKeyId: key.id,
    metadata: {},
  });
  const response = await h.handleChat(
    h.buildRequest({
      url: "http://localhost/v1/responses",
      authKey: key.key,
      headers: { "x-omniroute-provider": "openai" },
      body: {
        model: "gpt-4o-mini",
        stream: false,
        input: [
          { role: "user", content: [{ type: "input_file", file_id: "file-foreign-fixture" }] },
        ],
      },
    })
  );
  await response.text();
  assert.equal(response.status, 404);
  assert.equal(attempts.length, 0);
});

test("selected Responses preserve native previous_response_id without local history lookup", async () => {
  await seedPair();
  const response = await responsesRoute.POST(
    h.buildRequest({
      url: "http://localhost/v1/responses",
      headers: {
        "x-omniroute-provider": "openai",
        originator: "codex_cli_rs",
        "user-agent": "codex_cli_rs/0.101.0",
      },
      body: {
        model: "gpt-5.5",
        stream: false,
        input: "follow up",
        previous_response_id: "resp_upstream_fixture",
        store: true,
      },
    })
  );
  const text = await response.text();
  assert.equal(response.status, 200, text);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].url, "https://api.openai.com/v1/responses");
  assert.equal(attempts[0].body.previous_response_id, "resp_upstream_fixture");
});

for (const native of [false, true]) {
  test(`Gemini native=${native} retains owned cache and file URI on one selected primary`, async () => {
    await h.seedConnection("gemini", {
      name: "google-zero",
      priority: 1,
      apiKey: "fixture-google-zero",
    });
    const selected = await h.seedConnection("gemini", {
      name: "google-one",
      priority: 2,
      apiKey: "fixture-google-one",
    });
    const key = await h.seedApiKey();
    const uri = "https://generativelanguage.googleapis.com/v1beta/files/owned-google";
    for (const resource of [
      { kind: "file", resourceId: "files/owned-google" },
      { kind: "cache", resourceId: "cachedContents/owned-google" },
    ] as const) {
      saveProviderResourceBinding({
        provider: "gemini",
        connectionId: selected.id as string,
        apiKeyId: key.id,
        metadata: {},
        ...resource,
      });
    }
    const headers = { "x-omniroute-provider": "google", "x-omniroute-key-index": "1" };
    const cache = { cachedContent: "cachedContents/owned-google" };
    const response = native
      ? await geminiRoute.POST(
          h.buildRequest({
            url: "http://localhost/v1beta/models/gemini-2.5-flash:generateContent",
            authKey: key.key,
            headers,
            body: {
              ...cache,
              contents: [
                {
                  role: "user",
                  parts: [
                    { text: "summarize the file" },
                    { fileData: { fileUri: uri, mimeType: "application/pdf" } },
                  ],
                },
              ],
            },
          }),
          { params: Promise.resolve({ path: ["gemini-2.5-flash:generateContent"] }) }
        )
      : await chat(
          headers,
          {
            ...cache,
            model: "gemini/gemini-2.5-flash",
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: "summarize the file" },
                  { type: "file", file: { file_id: uri, mime_type: "application/pdf" } },
                ],
              },
            ],
          },
          key.key
        );
    const text = await response.text();
    assert.equal(response.status, 200, text);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].key, "fixture-google-one");
    assert.equal(attempts[0].body.cachedContent, "cachedContents/owned-google");
    assert.deepEqual(attempts[0].body.contents, [
      {
        role: "user",
        parts: [
          { text: "summarize the file" },
          { fileData: { fileUri: uri, mimeType: "application/pdf" } },
        ],
      },
    ]);
    assert.equal(response.headers.get("x-omniroute-selected-connection-id"), selected.id);
  });
}

for (const selected of [true, false]) {
  test(`selected=${selected} protects cached Gemini model from background downgrade`, async () => {
    const connection = await h.seedConnection("gemini", { apiKey: "fixture-google-primary" });
    const key = await h.seedApiKey();
    saveProviderResourceBinding({
      provider: "gemini",
      connectionId: connection.id as string,
      kind: "cache",
      resourceId: "cachedContents/model-bound",
      apiKeyId: key.id,
      metadata: { model: "models/gemini-2.5-flash" },
    });
    setBackgroundDegradationConfig({
      enabled: true,
      degradationMap: { "gemini-2.5-flash": "gemini-2.5-flash-lite" },
    });
    const response = await chat(
      selected ? { "x-omniroute-provider": "gemini" } : {},
      {
        model: "gemini/gemini-2.5-flash",
        max_tokens: 10,
        cachedContent: "cachedContents/model-bound",
      },
      key.key
    );
    assert.equal(response.status, 200, await response.text());
    assert.equal(attempts.length, 1);
    const expected = selected ? "gemini-2.5-flash" : "gemini-2.5-flash-lite";
    assert.equal(
      attempts[0].url,
      `https://generativelanguage.googleapis.com/v1beta/models/${expected}:generateContent`
    );
    assert.equal(attempts[0].body.cachedContent, "cachedContents/model-bound");
  });

  for (const rewrite of ["lifecycle alias", "payload rule"] as const) {
    test(`selected=${selected} refuses native model rewrite by ${rewrite}`, async () => {
      await h.seedConnection("gemini", { apiKey: "fixture-google-primary" });
      if (rewrite === "lifecycle alias") {
        setCustomAliases({ "gemini-2.5-flash": "gemini-2.5-flash-lite" });
      } else {
        setPayloadRulesConfig({
          override: [
            { models: [{ name: "gemini-2.5-flash" }], params: { model: "gemini-2.5-flash-lite" } },
          ],
        });
      }
      const response = await chat(selected ? { "x-omniroute-provider": "gemini" } : {}, {
        model: "gemini/gemini-2.5-flash",
      });
      assert.equal(response.status, selected ? 400 : 200, await response.text());
      if (selected) assert.equal(attempts.length, 0);
      else
        assert.equal(
          attempts[0].url,
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent"
        );
    });
  }
}

for (const mode of ["cliproxyapi", "dario"] as const) {
  test(`native selection cannot replace the selected account with ${mode}`, async () => {
    await seedPair();
    await upsertUpstreamProxyConfig({ providerId: "openai", mode, enabled: true });
    const response = await chat({ "x-omniroute-provider": "openai" });
    assert.equal(response.status, 200, await response.text());
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].url, "https://api.openai.com/v1/chat/completions");
    assert.equal(attempts[0].key, "fixture-primary-zero");
  });
}

test("native executor refuses a recovery call for a different model", async () => {
  const { resolveNativeProviderResourceExecutor } =
    await import("../../open-sse/handlers/chatCore/passthroughHelpers.ts");
  const executor = await resolveNativeProviderResourceExecutor("openai", "gpt-4o-mini");
  const result = await executor.execute({
    model: "gpt-4.1",
    body: { model: "gpt-4.1", messages: [{ role: "user", content: "fixture recovery" }] },
    stream: false,
    credentials: { apiKey: "fixture-primary-zero", providerSpecificData: {} },
  });
  assert.ok("response" in result);
  assert.equal(result.response.status, 400);
  await result.response.text();
  assert.equal(attempts.length, 0);
});

test("selected inference retains API-key model restrictions", async () => {
  await seedPair();
  const key = await h.seedApiKey({ allowedModels: ["openai/gpt-4.1"] });
  const response = await chat({ "x-omniroute-provider": "openai" }, {}, key.key);
  await response.text();
  assert.equal(response.status, 403);
  assert.equal(attempts.length, 0);
});

test("quota preflight cannot reselect a healthy sibling after the indexed primary is blocked", async () => {
  const { first } = await seedPair();
  await h.settingsDb.updateSettings({ resilienceSettings: { quotaPreflight: { enabled: true } } });
  const quotaPreflight = await import("../../open-sse/services/quotaPreflight.ts");
  const original = quotaPreflight.getQuotaFetcher("openai");
  quotaPreflight.registerQuotaFetcher("openai", async (connectionId) => ({
    used: connectionId === first.id ? 100 : 0,
    total: 100,
    percentUsed: connectionId === first.id ? 1 : 0,
    resetAt: new Date(Date.now() + 60_000).toISOString(),
  }));
  try {
    const response = await chat({ "x-omniroute-provider": "openai" });
    await response.text();
    assert.equal(response.status, 429);
    assert.equal(attempts.length, 0);
  } finally {
    quotaPreflight.registerQuotaFetcher("openai", original ?? (async () => null));
  }
});

test("native billing failure cannot trigger another provider's emergency fallback", async () => {
  await seedPair();
  await h.seedConnection("nvidia", { apiKey: "fixture-fallback-provider" });
  failureStatus = 402;
  const response = await chat({ "x-omniroute-provider": "openai" });
  await response.text();
  assert.equal(response.status, 402);
  assert.ok(attempts.length >= 1);
  assert.ok(attempts.every((attempt) => attempt.url.startsWith("https://api.openai.com/")));
  assert.ok(attempts.every((attempt) => attempt.key === "fixture-primary-zero"));
});

test("requests without new headers keep ordinary inference", async () => {
  const { first } = await seedPair();
  const response = await chat({ "x-omniroute-connection": first.id as string });
  await response.text();
  assert.equal(response.status, 200);
  assert.equal(attempts[0].url, "https://api.openai.com/v1/chat/completions");
  assert.equal(attempts[0].key, "fixture-primary-zero");
});
