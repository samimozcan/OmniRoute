import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test, type TestContext } from "node:test";

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-openai-effort-18912-"));
process.env.DATA_DIR = testDataDir;
process.env.API_KEY_SECRET = "openai-effort-offline-test-only";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const { ensureDbInitialized, resetDbInstance } = await import("../../src/lib/db/core.ts");
const { translateRequest } = await import("../../open-sse/translator/index.ts");
const { FORMATS } = await import("../../open-sse/translator/formats.ts");
const { prepareUpstreamBody } = await import("../../open-sse/handlers/chatCore/upstreamBody.ts");
const { DefaultExecutor } = await import("../../open-sse/executors/default.ts");
const { handleComboChat } = await import("../../open-sse/services/combo.ts");

const MODEL = "gpt-6.1-terra";
const credentials = { apiKey: "offline-test-key" };
const noop = () => {};
const log = { info: noop, warn: noop, debug: noop, error: noop };

before(async () => {
  await ensureDbInitialized();
});

after(() => {
  resetDbInstance();
});

// Combo success queues best-effort metadata work. Keep its isolated directory
// until process exit so those pending reads cannot reopen a deleted DB path.
process.once("exit", () => {
  fs.rmSync(testDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function chatBody(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: MODEL,
    messages: [{ role: "user", content: "Reply with OK." }],
    stream: false,
    ...fields,
  };
}

function captureUpstream(t: TestContext) {
  const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
  // Only the external HTTP boundary is replaced. Translation, attempt guards,
  // executor transforms, and JSON serialization all run as they do in production.
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return Response.json({
      id: "chatcmpl-offline-effort",
      object: "chat.completion",
      model: MODEL,
      choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
    });
  });
  return sent;
}

async function dispatchOpenAIChat(body: Record<string, unknown>, model = MODEL) {
  const translatedBody = translateRequest(
    FORMATS.OPENAI,
    FORMATS.OPENAI,
    model,
    structuredClone({ ...body, model }),
    false,
    credentials,
    "openai"
  );
  const upstreamBody = await prepareUpstreamBody({
    translatedBody,
    modelToCall: model,
    originModel: model,
    provider: "openai",
    targetFormat: FORMATS.OPENAI,
    credentials,
  });
  const result = await new DefaultExecutor("openai").execute({
    model,
    body: upstreamBody,
    stream: false,
    credentials,
  });
  return result.response;
}

const effortCases: Array<{
  name: string;
  fields: Record<string, unknown>;
  expected: string;
}> = [
  { name: "canonical high", fields: { effort: "high" }, expected: "high" },
  { name: "canonical none", fields: { effort: "none" }, expected: "none" },
  {
    name: "explicit flat effort overrides canonical effort",
    fields: { effort: "high", reasoning_effort: "low" },
    expected: "low",
  },
  {
    name: "explicit nested effort overrides canonical effort",
    fields: { effort: "high", reasoning: { effort: "low", summary: "auto" } },
    expected: "low",
  },
  {
    name: "explicit flat effort overrides nested effort",
    fields: { effort: "high", reasoning_effort: "none", reasoning: { effort: "low" } },
    expected: "none",
  },
  { name: "thinking true enables reasoning", fields: { thinking: true }, expected: "medium" },
  { name: "thinking false disables reasoning", fields: { thinking: false }, expected: "none" },
  {
    name: "disabled thinking object",
    fields: { thinking: { type: "disabled" } },
    expected: "none",
  },
  {
    name: "enabled thinking object without a budget",
    fields: { thinking: { type: "enabled" } },
    expected: "medium",
  },
  {
    name: "adaptive thinking object",
    fields: { thinking: { type: "adaptive" } },
    expected: "medium",
  },
  {
    name: "low thinking budget",
    fields: { thinking: { type: "enabled", budget_tokens: 1024 } },
    expected: "low",
  },
  {
    name: "medium thinking budget",
    fields: { thinking: { type: "enabled", budget_tokens: 10240 } },
    expected: "medium",
  },
  {
    name: "high thinking budget",
    fields: { thinking: { type: "enabled", budget_tokens: 32768 } },
    expected: "high",
  },
  {
    name: "xhigh thinking budget",
    fields: { thinking: { type: "enabled", budget_tokens: 131072 } },
    expected: "xhigh",
  },
  {
    name: "canonical effort wins over the thinking toggle",
    fields: { effort: "high", thinking: true },
    expected: "high",
  },
  {
    name: "explicit flat opt-out wins over thinking true",
    fields: { reasoning_effort: "none", thinking: true },
    expected: "none",
  },
  {
    name: "explicit flat effort wins over thinking false",
    fields: { reasoning_effort: "high", thinking: false },
    expected: "high",
  },
  {
    name: "explicit nested effort wins over thinking false",
    fields: { reasoning: { effort: "low" }, thinking: false },
    expected: "low",
  },
  {
    name: "explicit flat opt-out wins over an enabled thinking budget",
    fields: { reasoning_effort: "none", thinking: { type: "enabled", budget_tokens: 32768 } },
    expected: "none",
  },
];

for (const { name, fields, expected } of effortCases) {
  test(`OpenAI Terra Chat sends only reasoning_effort on the first attempt: ${name}`, async (t) => {
    const sent = captureUpstream(t);
    const response = await dispatchOpenAIChat(chatBody(fields));

    assert.equal(response.status, 200);
    assert.equal(sent.length, 1, "normalization must happen before the first upstream request");
    assert.equal(new URL(sent[0].url).pathname, "/v1/chat/completions");
    assert.equal(sent[0].body.model, MODEL);
    assert.equal(
      Object.hasOwn(sent[0].body, "thinking"),
      false,
      "thinking is not an OpenAI Chat field"
    );
    assert.equal(sent[0].body.reasoning_effort, expected);
    assert.equal(Object.hasOwn(sent[0].body, "effort"), false, "canonical effort is router-only");
    assert.equal(Object.hasOwn(sent[0].body, "reasoning"), false, "reasoning is Responses-shaped");
  });
}

test("priority combo sends Terra's normalized effort on its first selected target", async (t) => {
  const sent = captureUpstream(t);
  const dispatchedModels: string[] = [];
  const response = await handleComboChat({
    body: chatBody({ model: "omni-refactor-models", effort: "high" }),
    combo: {
      name: "offline-terra-effort-combo",
      strategy: "priority",
      models: [`openai/${MODEL}`, "openai/gpt-6-luna"],
      config: { maxRetries: 2, maxSetRetries: 1, retryDelayMs: 0, setRetryDelayMs: 0 },
    },
    handleSingleModel: async (body, modelStr) => {
      dispatchedModels.push(modelStr);
      return dispatchOpenAIChat(body, modelStr.slice("openai/".length));
    },
    settings: {},
    allCombos: [],
    log,
  });

  assert.equal(response.status, 200);
  assert.deepEqual(dispatchedModels, [`openai/${MODEL}`]);
  assert.equal(sent.length, 1, "no retry or fallback may mask an invalid first request");
  assert.equal(new URL(sent[0].url).pathname, "/v1/chat/completions");
  assert.equal(sent[0].body.reasoning_effort, "high");
  assert.equal(Object.hasOwn(sent[0].body, "effort"), false);
  assert.equal(Object.hasOwn(sent[0].body, "reasoning"), false);
});

test("priority combo consumes a thinking-only request before Terra's first upstream call", async (t) => {
  const sent = captureUpstream(t);
  const dispatchedModels: string[] = [];
  const response = await handleComboChat({
    body: chatBody({ model: "omni-refactor-models", thinking: true }),
    combo: {
      name: "offline-terra-thinking-combo",
      strategy: "priority",
      models: [`openai/${MODEL}`, "openai/gpt-6-luna"],
      config: { maxRetries: 2, maxSetRetries: 1, retryDelayMs: 0, setRetryDelayMs: 0 },
    },
    handleSingleModel: async (body, modelStr) => {
      dispatchedModels.push(modelStr);
      return dispatchOpenAIChat(body, modelStr.slice("openai/".length));
    },
    settings: {},
    allCombos: [],
    log,
  });

  assert.equal(response.status, 200);
  assert.deepEqual(dispatchedModels, [`openai/${MODEL}`]);
  assert.equal(sent.length, 1, "no retry or fallback may hide an unsupported thinking field");
  assert.equal(Object.hasOwn(sent[0].body, "thinking"), false);
  assert.equal(sent[0].body.reasoning_effort, "medium");
});

test("canonical effort cannot restore reasoning removed by the OpenAI function-tools guard", async (t) => {
  const sent = captureUpstream(t);
  await dispatchOpenAIChat(
    chatBody({
      effort: "high",
      tools: [
        {
          type: "function",
          function: { name: "lookup", parameters: { type: "object", properties: {} } },
        },
      ],
    })
  );

  assert.equal(sent.length, 1);
  assert.equal(Object.hasOwn(sent[0].body, "effort"), false);
  assert.equal(Object.hasOwn(sent[0].body, "reasoning"), false);
  assert.equal(Object.hasOwn(sent[0].body, "reasoning_effort"), false);
  assert.equal((sent[0].body.tools as unknown[]).length, 1);
});

for (const thinking of [true, false]) {
  test(`thinking=${thinking} respects the OpenAI function-tools and sampling guards`, async (t) => {
    const sent = captureUpstream(t);
    await dispatchOpenAIChat(
      chatBody({
        thinking,
        temperature: 0.3,
        tools: [
          {
            type: "function",
            function: { name: "lookup", parameters: { type: "object", properties: {} } },
          },
        ],
      })
    );

    assert.equal(sent.length, 1);
    assert.equal(Object.hasOwn(sent[0].body, "thinking"), false);
    assert.equal(sent[0].body.reasoning_effort, thinking ? undefined : "none");
    assert.equal(sent[0].body.temperature, thinking ? undefined : 0.3);
    assert.equal((sent[0].body.tools as unknown[]).length, 1);
  });
}

test("thinking false remains an explicit opt-out on a tool-result continuation", async (t) => {
  const sent = captureUpstream(t);
  await dispatchOpenAIChat(
    chatBody({
      thinking: false,
      messages: [
        { role: "user", content: "Look up the answer." },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_lookup", type: "function", function: { name: "lookup", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "call_lookup", content: "The answer is 42." },
      ],
    })
  );

  assert.equal(sent.length, 1);
  assert.equal(Object.hasOwn(sent[0].body, "thinking"), false);
  assert.equal(sent[0].body.reasoning_effort, "none");
});

test("OpenAI Chat translation does not invent an effort when none was requested", () => {
  const result = translateRequest(
    FORMATS.OPENAI,
    FORMATS.OPENAI,
    MODEL,
    chatBody(),
    false,
    null,
    "openai"
  );
  assert.equal(Object.hasOwn(result, "reasoning_effort"), false);
  assert.equal(Object.hasOwn(result, "reasoning"), false);
});

test("OpenRouter Chat retains its native nested reasoning controls", () => {
  const result = translateRequest(
    FORMATS.OPENAI,
    FORMATS.OPENAI,
    `openai/${MODEL}`,
    chatBody({ reasoning: { effort: "high", exclude: true } }),
    false,
    null,
    "openrouter"
  );
  assert.deepEqual(result.reasoning, { effort: "high", exclude: true });
  assert.equal(Object.hasOwn(result, "reasoning_effort"), false);
});

test("OpenAI Responses retains its nested reasoning effort and summary", () => {
  const result = translateRequest(
    FORMATS.OPENAI,
    FORMATS.OPENAI_RESPONSES,
    "gpt-5.6",
    chatBody({ effort: "low", reasoning: { effort: "high", summary: "auto" } }),
    false,
    null,
    "openai"
  );
  assert.deepEqual(result.reasoning, { effort: "high", summary: "auto" });
  assert.equal(Object.hasOwn(result, "effort"), false);
  assert.equal(Object.hasOwn(result, "reasoning_effort"), false);
});

for (const thinking of [true, false, { type: "enabled", budget_tokens: 4096 }]) {
  test(`OpenRouter retains its own thinking control: ${JSON.stringify(thinking)}`, () => {
    const result = translateRequest(
      FORMATS.OPENAI,
      FORMATS.OPENAI,
      `openai/${MODEL}`,
      chatBody({ thinking }),
      false,
      null,
      "openrouter"
    );
    assert.deepEqual(result.thinking, thinking);
    assert.equal(Object.hasOwn(result, "reasoning_effort"), false);
  });
}

test("Anthropic translation retains an explicit native thinking budget", () => {
  const result = translateRequest(
    FORMATS.OPENAI,
    FORMATS.CLAUDE,
    "claude-sonnet-4-6",
    chatBody({ model: "claude-sonnet-4-6", thinking: { type: "enabled", budget_tokens: 4096 } }),
    false,
    null,
    "claude"
  );
  assert.deepEqual(result.thinking, { type: "enabled", budget_tokens: 4096 });
  assert.equal(Object.hasOwn(result, "reasoning_effort"), false);
});

test("Responses explicit reasoning remains authoritative over a Chat thinking toggle", () => {
  const result = translateRequest(
    FORMATS.OPENAI,
    FORMATS.OPENAI_RESPONSES,
    "gpt-5.6",
    chatBody({ thinking: false, reasoning: { effort: "high", summary: "auto" } }),
    false,
    null,
    "openai"
  );
  assert.deepEqual(result.reasoning, { effort: "high", summary: "auto" });
  assert.equal(Object.hasOwn(result, "thinking"), false);
  assert.equal(Object.hasOwn(result, "reasoning_effort"), false);
});
