import assert from "node:assert/strict";
import test from "node:test";
import {
  __setGenericUsageFetcherForTests,
  fetchGenericQuota,
  registerGenericQuotaFetchers,
} from "../../open-sse/services/genericQuotaFetcher.ts";
import { getQuotaFetcher } from "../../open-sse/services/quotaPreflight.ts";

test("native OpenAI reporting support does not register an inference preflight fetcher", () => {
  registerGenericQuotaFetchers();
  assert.equal(getQuotaFetcher("openai"), undefined);
  assert.equal(typeof getQuotaFetcher("openrouter"), "function");
});

test("direct native OpenAI preflight never dispatches administrative reporting", async () => {
  let reportingCalls = 0;
  __setGenericUsageFetcherForTests(async () => {
    reportingCalls++;
    return { plan: "API key", quotas: {} };
  });
  try {
    const result = await fetchGenericQuota("openai-preflight-no-report", {
      provider: "openai",
      apiKey: "ordinary-key",
    });
    assert.equal(result, null);
    assert.equal(reportingCalls, 0);
  } finally {
    __setGenericUsageFetcherForTests(null);
  }
});
