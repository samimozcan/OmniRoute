import assert from "node:assert/strict";
import test from "node:test";
import { updateFromHeaders } from "../../open-sse/services/rateLimitManager.ts";

const observedAt = Date.parse("2026-11-06T12:00:00.000Z");

async function observer() {
  const module = await import("../../open-sse/services/usage/openaiRateLimits.ts").catch(
    () => null
  );
  assert.ok(module, "the passive OpenAI observation collector must exist");
  return module;
}

test("native OpenAI headers are captured with rate-limit protection disabled", async () => {
  const { getOpenAIRateLimitObservations } = await observer();
  const headers = new Headers({
    "x-ratelimit-limit-requests": "500",
    "x-ratelimit-remaining-requests": "499",
    "x-ratelimit-reset-requests": "1s",
  });
  updateFromHeaders("openai", "openai-passive-unprotected", headers, 200, "gpt-test");
  const result = getOpenAIRateLimitObservations({ connectionId: "openai-passive-unprotected" });
  assert.equal(result.status, "observed");
  assert.equal(result.observations[0].requests?.remaining, 499);
  assert.equal(result.observations[0].model, "gpt-test");
});

test("native-only capture excludes Codex and OpenAI-compatible providers", async () => {
  const { getOpenAIRateLimitObservations } = await observer();
  for (const provider of ["codex", "openai-compatible-chat-test"]) {
    const connectionId = `openai-passive-control-${provider}`;
    updateFromHeaders(provider, connectionId, { "x-ratelimit-limit-requests": "500" }, 429);
    assert.equal(getOpenAIRateLimitObservations({ connectionId }).status, "not_observed");
  }
});

test("request, token and project-token windows retain separate values and parsed reset times", async () => {
  const { observeOpenAIRateLimits, getOpenAIRateLimitObservations } = await observer();
  observeOpenAIRateLimits({
    connectionId: "openai-passive-windows",
    model: "gpt-test",
    status: 429,
    observedAt,
    headers: {
      "OpenAI-Organization": "org-visible",
      "OpenAI-Project": "proj-visible",
      "X-RateLimit-Limit-Requests": "500",
      "X-RateLimit-Remaining-Requests": "0",
      "X-RateLimit-Reset-Requests": "1m2.5s",
      "x-ratelimit-limit-tokens": "30000",
      "x-ratelimit-remaining-tokens": "1234",
      "x-ratelimit-reset-tokens": "500ms",
      "x-ratelimit-limit-project-tokens": "90000",
      "x-ratelimit-remaining-project-tokens": "70000",
      "x-ratelimit-reset-project-tokens": "2m",
      authorization: "Bearer never-store-this",
    },
  });
  const result = getOpenAIRateLimitObservations({
    connectionId: "openai-passive-windows",
    now: observedAt,
  });
  const value = result.observations[0];
  assert.equal(value.organizationId, "org-visible");
  assert.equal(value.projectId, "proj-visible");
  assert.deepEqual(value.requests, {
    limit: 500,
    remaining: 0,
    resetAt: "2026-11-06T12:01:02.500Z",
    observedAt: "2026-11-06T12:00:00.000Z",
    stale: false,
  });
  assert.equal(value.tokens?.resetAt, "2026-11-06T12:00:00.500Z");
  assert.equal(value.projectTokens?.limit, 90000);
  assert.equal(value.projectTokens?.resetAt, "2026-11-06T12:02:00.000Z");
  assert.equal(JSON.stringify(result).includes("never-store-this"), false);
  const expired = getOpenAIRateLimitObservations({
    connectionId: "openai-passive-windows",
    now: observedAt + 125_000,
  });
  assert.equal(expired.observations[0].requests?.stale, true);
  assert.equal(
    expired.observations[0].requests?.remaining,
    0,
    "expiry never invents replenishment"
  );
  assert.equal(expired.lastObservedAt, "2026-11-06T12:00:00.000Z");
});

test("partial headers stay unknown, are case insensitive and cannot mutate stored observations", async () => {
  const { observeOpenAIRateLimits, getOpenAIRateLimitObservations } = await observer();
  observeOpenAIRateLimits({
    connectionId: "openai-passive-partial",
    model: null,
    status: 200,
    observedAt,
    headers: {
      "X-RateLimit-Remaining-Tokens": "42",
      "x-ratelimit-limit-tokens": "100oops",
      "x-ratelimit-reset-tokens": "bad",
    },
  });
  const first = getOpenAIRateLimitObservations({
    connectionId: "openai-passive-partial",
    now: observedAt,
  });
  assert.equal(first.observations[0].requests, null);
  assert.equal(first.observations[0].tokens?.limit, null);
  assert.equal(first.observations[0].tokens?.resetAt, null);
  first.observations[0].tokens!.remaining = 999;
  const later = getOpenAIRateLimitObservations({
    connectionId: "openai-passive-partial",
    now: observedAt + 600_000,
  });
  assert.equal(later.observations[0].tokens?.remaining, 42);
  assert.equal(later.observations[0].tokens?.stale, true);
  observeOpenAIRateLimits({
    connectionId: "openai-passive-invalid",
    model: null,
    status: 200,
    observedAt,
    headers: { "x-ratelimit-limit-tokens": "-1", "x-ratelimit-remaining-requests": "NaN" },
  });
  assert.equal(
    getOpenAIRateLimitObservations({ connectionId: "openai-passive-invalid" }).status,
    "not_observed"
  );
});

test("model-scoped observations remain bounded and new observations replace older windows", async () => {
  const { observeOpenAIRateLimits, getOpenAIRateLimitObservations } = await observer();
  for (let index = 0; index < 1000; index++) {
    observeOpenAIRateLimits({
      connectionId: "openai-passive-bounded",
      model: `gpt-${index}`,
      status: 200,
      observedAt: observedAt + index,
      headers: { "x-ratelimit-remaining-requests": String(index) },
    });
  }
  const result = getOpenAIRateLimitObservations({
    connectionId: "openai-passive-bounded",
    now: observedAt + 1000,
  });
  assert.ok(result.observations.length <= 64);
  assert.equal(result.observations[0].model, "gpt-999");
  assert.equal(
    result.observations.some((entry) => entry.model === "gpt-0"),
    false
  );
  observeOpenAIRateLimits({
    connectionId: "openai-passive-bounded",
    model: "gpt-999",
    status: 429,
    observedAt: observedAt + 2000,
    headers: { "x-ratelimit-remaining-requests": "0" },
  });
  const updated = getOpenAIRateLimitObservations({
    connectionId: "openai-passive-bounded",
    now: observedAt + 2000,
  });
  assert.equal(updated.observations[0].requests?.remaining, 0);
  assert.equal(updated.observations.length, result.observations.length);
});
