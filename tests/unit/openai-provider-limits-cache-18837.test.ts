import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeProviderLimitsCacheEntry,
  toProviderLimitsCacheEntry,
} from "../../src/lib/usage/providerLimitsCache.ts";
import type { OpenAIUsageReport } from "../../open-sse/services/usage/openaiTypes.ts";
import { createTempDataDir } from "../_setup/tempDataDir.ts";

const { cleanup } = createTempDataDir("omniroute-openai-cache-");
test.after(cleanup);

function report(observed: boolean): OpenAIUsageReport {
  const empty = { status: "not_configured" as const, data: null, fetchedAt: null };
  return {
    version: 1,
    rateLimits: observed
      ? {
          status: "observed",
          lastObservedAt: "2026-11-06T12:00:00.000Z",
          observations: [
            {
              model: "gpt-test",
              organizationId: "org-first",
              projectId: "proj-first",
              observedAt: "2026-11-06T12:00:00.000Z",
              requests: {
                limit: 500,
                remaining: 0,
                resetAt: "2026-11-06T12:01:00.000Z",
                observedAt: "2026-11-06T12:00:00.000Z",
                stale: false,
              },
              tokens: null,
              projectTokens: null,
            },
          ],
        }
      : { status: "not_observed", observations: [], lastObservedAt: null },
    admin: {
      configured: false,
      scope: { kind: "organization", projectId: null, apiKeyId: null },
      period: { preset: "month", startTime: 1793491200, endTime: 1793966400, bucketWidth: "1d" },
      usage: empty,
      costs: empty,
      organizationSpendLimit: empty,
      projectSpendLimit: empty,
      projectRateLimits: empty,
      organizationAlerts: empty,
      projectAlerts: empty,
      projects: empty,
      apiKeys: empty,
    },
    creditBalance: {
      status: "unavailable",
      billingUrl: "https://platform.openai.com/settings/organization/billing/overview",
    },
  };
}

test("OpenAI descriptive report survives the mapper while routing quotas stay empty", () => {
  const openai = report(true);
  const cache = toProviderLimitsCacheEntry({ plan: "API key", quotas: {}, openai }, "manual");
  assert.deepEqual(cache.openai, openai);
  assert.deepEqual(cache.quotas, {});
  assert.equal(cache.modelQuotas, undefined);
});

test("cold OpenAI refresh preserves only prior passive observations as stale", () => {
  const previousReport = report(true);
  const nextReport = report(false);
  nextReport.admin.scope = { kind: "project", projectId: "proj-new", apiKeyId: null };
  const previous = toProviderLimitsCacheEntry({ quotas: {}, openai: previousReport }, "scheduled");
  const next = toProviderLimitsCacheEntry({ quotas: {}, openai: nextReport }, "manual");
  const merged = mergeProviderLimitsCacheEntry("openai", next, previous);
  assert.equal(merged.openai?.rateLimits.status, "observed");
  assert.equal(merged.openai?.rateLimits.observations[0].requests?.stale, true);
  assert.equal(merged.openai?.rateLimits.observations[0].requests?.remaining, 0);
  assert.equal(merged.openai?.rateLimits.lastObservedAt, "2026-11-06T12:00:00.000Z");
  assert.equal(merged.openai?.admin.scope.projectId, "proj-new");
  assert.equal(previous.openai?.rateLimits.observations[0].requests?.stale, false);
  assert.equal(mergeProviderLimitsCacheEntry("codex", next, previous), next);
});

test("fresh native observations supersede persisted observations without changing routing data", () => {
  const previous = toProviderLimitsCacheEntry({ quotas: {}, openai: report(true) }, "scheduled");
  const fresh = report(true);
  fresh.rateLimits.observations[0].requests!.remaining = 25;
  const next = toProviderLimitsCacheEntry({ quotas: {}, openai: fresh }, "manual");
  const merged = mergeProviderLimitsCacheEntry("openai", next, previous);
  assert.equal(merged.openai?.rateLimits.observations[0].requests?.remaining, 25);
  assert.deepEqual(merged.quotas, {});
});

test("persisted OpenAI reports survive SQLite normalization with cold observations marked stale", async () => {
  const { getProviderLimitsCache, setProviderLimitsCache, getAllProviderLimitsCache } =
    await import("../../src/lib/db/providerLimits.ts");
  const openai = report(true);
  const entry = {
    quotas: {},
    plan: "API key",
    message: null,
    fetchedAt: "2026-11-06T12:00:00.000Z",
    openai,
  };
  setProviderLimitsCache("openai-persisted-cache", entry);
  const result = getProviderLimitsCache("openai-persisted-cache");
  assert.equal(result?.openai?.rateLimits.observations[0].requests?.remaining, 0);
  assert.equal(result?.openai?.rateLimits.observations[0].requests?.stale, true);
  assert.equal(result?.openai?.admin.scope.kind, "organization");
  assert.equal(getAllProviderLimitsCache()["openai-persisted-cache"]?.openai?.version, 1);
});
