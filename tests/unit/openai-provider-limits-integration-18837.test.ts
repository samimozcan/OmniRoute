import assert from "node:assert/strict";
import test from "node:test";
import { createTempDataDir } from "../_setup/tempDataDir.ts";

const { cleanup } = createTempDataDir("omniroute-openai-native-integration-");
process.env.API_KEY_SECRET = "openai-integration-test-only-secret";
test.after(cleanup);

test("native usage dispatch, refresh and SQLite reads retain passive reports without any inference request", async () => {
  const { createProviderConnection } = await import("../../src/lib/db/providers.ts");
  const { getUsageForProvider } = await import("../../open-sse/services/usage.ts");
  const { updateFromHeaders } = await import("../../open-sse/services/rateLimitManager.ts");
  const {
    fetchAndPersistProviderLimits,
    isSupportedUsageConnection,
    getSanitizedCachedProviderLimitsMap,
  } = await import("../../src/lib/usage/providerLimits.ts");
  const { getProviderLimitsCache } = await import("../../src/lib/db/providerLimits.ts");
  const connection = await createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "Native reporting integration",
    apiKey: "sk-test-ordinary-only",
  });
  assert.ok(connection?.id);
  assert.equal(isSupportedUsageConnection(connection), true);
  let outboundRequests = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    outboundRequests++;
    throw new Error("ordinary OpenAI usage refresh must never send an outbound request");
  }) as typeof fetch;
  try {
    const first = await getUsageForProvider(connection);
    assert.equal(first.plan, "API key");
    assert.deepEqual(first.quotas, {});
    assert.equal(first.openai.rateLimits.status, "not_observed");
    assert.equal(first.openai.admin.usage.status, "not_configured");
    updateFromHeaders(
      "openai",
      connection.id,
      new Headers({
        "x-ratelimit-limit-requests": "500",
        "x-ratelimit-remaining-requests": "0",
        "x-ratelimit-reset-requests": "30s",
        "x-ratelimit-limit-tokens": "30000",
        "x-ratelimit-remaining-tokens": "28000",
      }),
      429,
      "gpt-test"
    );
    const { usage, cache } = await fetchAndPersistProviderLimits(connection.id, "manual");
    assert.equal(usage.plan, "API key");
    assert.deepEqual(usage.quotas, {});
    assert.equal(usage.modelQuotas, undefined);
    assert.equal(cache.openai?.rateLimits.observations[0].requests?.remaining, 0);
    assert.equal(cache.openai?.rateLimits.observations[0].tokens?.remaining, 28000);
    assert.equal(cache.openai?.admin.usage.status, "not_configured");
    assert.equal(
      getProviderLimitsCache(connection.id)?.openai?.rateLimits.observations[0].model,
      "gpt-test"
    );
    const dashboardCache = await getSanitizedCachedProviderLimitsMap();
    assert.equal(dashboardCache[connection.id].openai?.rateLimits.status, "observed");
    assert.deepEqual(dashboardCache[connection.id].quotas, {});
    assert.equal(outboundRequests, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
