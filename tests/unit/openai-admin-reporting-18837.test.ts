import assert from "node:assert/strict";
import test from "node:test";
import { getOpenAIUsage } from "../../open-sse/services/usage/openai.ts";
import type { OpenAIUsageConnection } from "../../open-sse/services/usage/openaiTypes.ts";

type Call = { url: URL; init: RequestInit };
type Reply = (call: Call) => Response | Promise<Response>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const list = (data: unknown[] = [], hasMore = false, lastId: string | null = null) => ({
  object: "list",
  data,
  has_more: hasMore,
  last_id: lastId,
  first_id: null,
});
const page = (results: unknown[], hasMore = false, nextPage: string | null = null) => ({
  object: "page",
  has_more: hasMore,
  next_page: nextPage,
  data: [{ object: "bucket", start_time: 1, end_time: 2, results }],
});
const usageRow = (input = 100, cached: number | undefined = 40) => ({
  object: "organization.usage.completions.result",
  input_tokens: input,
  output_tokens: 25,
  num_model_requests: 2,
  ...(cached === undefined ? {} : { input_cached_tokens: cached }),
  project_id: "proj_a",
  api_key_id: "key_a",
  model: "gpt-6.1-terra",
});
const costRow = (value = 1.25, currency = "usd") => ({
  object: "organization.costs.result",
  amount: { value, currency },
  project_id: "proj_a",
  api_key_id: "key_a",
  line_item: "gpt-6.1-terra",
});
const keyRow = (id = "key_a") => ({
  object: "organization.project.api_key",
  id,
  name: "Inference",
  created_at: 10,
  last_used_at: 20,
  expires_at: null,
  owner_project_access: "active",
  redacted_value: "sk-NEVER-USE-THIS",
  owner: { user: { email: "private@example.com" } },
});
const spend = (object = "organization.spend_limit") => ({
  object,
  threshold_amount: 10000,
  currency: "USD",
  interval: "month",
  enforcement: { status: "enforcing" },
});
let sequence = 0;
function connection(extra: Record<string, unknown> = {}): OpenAIUsageConnection {
  return {
    id: `admin-report-test-${++sequence}`,
    provider: "openai",
    apiKey: "sk-inference-NEVER-ADMIN",
    providerSpecificData: {
      openaiAdminApiKey: "sk-admin-TEST-ONLY",
      openaiReportingProjectId: "proj_a",
      openaiReportingApiKeyId: "key_a",
      openaiReportingPeriod: "month",
      ...extra,
    },
  };
}
function defaults({ url }: Call): Response {
  if (url.pathname.endsWith("/usage/completions")) return json(page([usageRow()]));
  if (url.pathname.endsWith("/costs")) return json(page([costRow()]));
  if (url.pathname.endsWith("/api_keys")) return json(list([keyRow()]));
  if (url.pathname === "/v1/organization/projects") {
    return json(list([{ object: "organization.project", id: "proj_a", name: "Production" }]));
  }
  if (url.pathname.endsWith("/spend_limit")) {
    return json(spend(url.pathname.includes("/projects/") ? "project.spend_limit" : undefined));
  }
  if (url.pathname.endsWith("/rate_limits")) {
    return json(
      list([
        {
          id: "rl_a",
          object: "project.rate_limit",
          model: "gpt-6.1-terra",
          max_requests_per_1_minute: 500,
          max_tokens_per_1_minute: 30000,
        },
      ])
    );
  }
  if (url.pathname.endsWith("/spend_alerts")) {
    return json(
      list([
        {
          id: "alert_a",
          object: url.pathname.includes("/projects/")
            ? "project.spend_alert"
            : "organization.spend_alert",
          threshold_amount: 7500,
          currency: "USD",
          interval: "month",
          notification_channel: { type: "email", recipients: ["private@example.com"] },
        },
      ])
    );
  }
  throw new Error(`Unexpected request ${url.pathname}`);
}
async function withFetch(run: (calls: Call[]) => Promise<void>, reply: Reply = defaults) {
  const original = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const call = { url: new URL(input instanceof Request ? input.url : input.toString()), init };
    calls.push(call);
    return reply(call);
  }) as typeof fetch;
  try {
    await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

test("ordinary inference key refresh never sends a probe or an Admin request", async () => {
  await withFetch(async (calls) => {
    const result = await getOpenAIUsage(connection({ openaiAdminApiKey: undefined }), {
      forceRefresh: true,
    });
    assert.equal(calls.length, 0);
    assert.deepEqual(result.quotas, {});
    assert.equal(result.openai.admin.configured, false);
    assert.equal(result.openai.admin.usage.status, "not_configured");
    assert.equal(result.openai.admin.usage.data, null);
    assert.equal(result.openai.creditBalance.status, "unavailable");
  });
});

test("the Admin credential is only used for fixed-origin read-only native reporting", async () => {
  await withFetch(async (calls) => {
    const result = await getOpenAIUsage(
      connection({ baseUrl: "https://attacker.invalid", headers: { "x-secret": "leak" } })
    );
    assert.equal(result.openai.admin.usage.status, "ready");
    assert.ok(calls.length > 0);
    for (const { url, init } of calls) {
      assert.equal(url.origin, "https://api.openai.com");
      assert.match(url.pathname, /^\/v1\/organization(?:\/|$)/);
      assert.equal(init.method, "GET");
      assert.equal(init.body, undefined);
      assert.equal(init.redirect, "error");
      assert.ok(init.signal instanceof AbortSignal);
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer sk-admin-TEST-ONLY");
      assert.equal(new Headers(init.headers).get("x-secret"), null);
      assert.doesNotMatch(JSON.stringify(init), /sk-inference/);
    }
    assert.doesNotMatch(JSON.stringify(result), /sk-admin|sk-inference|sk-NEVER|private@example/);
    assert.equal(result.openai.admin.scope.kind, "api_key");
  });
});

test("API-key metadata and usage/cost cursor pages are all consumed with exact filters", async () => {
  await withFetch(
    async (calls) => {
      const report = (await getOpenAIUsage(connection())).openai.admin;
      assert.deepEqual(report.usage.data, {
        requests: 4,
        inputTokens: 300,
        outputTokens: 50,
        cachedInputTokens: 80,
        models: [
          {
            model: "gpt-6.1-terra",
            requests: 4,
            inputTokens: 300,
            outputTokens: 50,
            cachedInputTokens: 80,
          },
        ],
      });
      assert.deepEqual(report.costs.data?.amounts, [{ value: 3.75, currency: "USD" }]);
      assert.equal(report.apiKeys.data?.length, 2);
      for (const { url } of calls.filter(({ url }) =>
        /\/usage\/completions$|\/costs$/.test(url.pathname)
      )) {
        assert.deepEqual(url.searchParams.getAll("project_ids[]"), ["proj_a"]);
        assert.deepEqual(url.searchParams.getAll("api_key_ids[]"), ["key_a"]);
        assert.ok(url.searchParams.getAll("group_by[]").includes("api_key_id"));
        assert.equal(url.searchParams.get("bucket_width"), "1d");
        assert.ok(
          Number(url.searchParams.get("start_time")) < Number(url.searchParams.get("end_time"))
        );
      }
      assert.ok(calls.some(({ url }) => url.searchParams.get("after") === "key_other"));
      assert.ok(calls.some(({ url }) => url.searchParams.get("page") === "next-cost"));
    },
    (call) => {
      const { url } = call;
      if (url.pathname.endsWith("/api_keys")) {
        return json(
          url.searchParams.has("after")
            ? list([keyRow()])
            : list([keyRow("key_other")], true, "key_other")
        );
      }
      if (url.pathname.endsWith("/usage/completions")) {
        return json(
          url.searchParams.has("page")
            ? page([usageRow(200)])
            : page([usageRow()], true, "next-usage")
        );
      }
      if (url.pathname.endsWith("/costs")) {
        return json(
          url.searchParams.has("page") ? page([costRow(2.5)]) : page([costRow()], true, "next-cost")
        );
      }
      return defaults(call);
    }
  );
});

test("spend caps/alerts convert cents; costs stay monetary units; no credit balance is invented", async () => {
  await withFetch(async () => {
    const { openai } = await getOpenAIUsage(connection());
    assert.equal(openai.admin.organizationSpendLimit.data?.value, 100);
    assert.equal(openai.admin.projectSpendLimit.data?.enforcement, "enforcing");
    assert.equal(openai.admin.projectAlerts.data?.[0].value, 75);
    assert.equal(openai.admin.costs.data?.amounts[0].value, 1.25);
    assert.equal(openai.admin.projectRateLimits.data?.[0].requestsPerMinute, 500);
    assert.equal(openai.admin.projectRateLimits.data?.[0].requestsPerDay, null);
    assert.deepEqual(openai.creditBalance, {
      status: "unavailable",
      billingUrl: "https://platform.openai.com/settings/organization/billing/overview",
    });
  });
});

test("valid empty history is zero, but missing cached-token data remains unknown", async () => {
  await withFetch(
    async () => {
      const report = (await getOpenAIUsage(connection())).openai.admin;
      assert.equal(report.usage.status, "ready");
      assert.equal(report.usage.data?.cachedInputTokens, null);
      assert.equal(report.costs.status, "ready");
      assert.deepEqual(report.costs.data?.amounts, []);
    },
    (call) =>
      call.url.pathname.endsWith("/usage/completions")
        ? json(page([{ ...usageRow(), input_cached_tokens: undefined }]))
        : call.url.pathname.endsWith("/costs")
          ? json(page([]))
          : defaults(call)
  );
  await withFetch(
    async () => {
      const report = (await getOpenAIUsage(connection())).openai.admin;
      assert.equal(report.usage.status, "ready");
      assert.equal(report.usage.data?.requests, 0);
      assert.equal(report.usage.data?.inputTokens, 0);
    },
    (call) => (call.url.pathname.endsWith("/usage/completions") ? json(page([])) : defaults(call))
  );
});

test("an invalid selected key never silently widens reports to its project or organization", async () => {
  await withFetch(async (calls) => {
    const report = (await getOpenAIUsage(connection({ openaiReportingApiKeyId: "key_missing" })))
      .openai.admin;
    assert.equal(report.scope.kind, "api_key");
    assert.equal(report.usage.data, null);
    assert.equal(report.costs.data, null);
    assert.notEqual(report.usage.status, "ready");
    assert.equal(
      calls.filter(({ url }) => /\/usage\/completions$|\/costs$/.test(url.pathname)).length,
      0
    );
    assert.equal(report.organizationSpendLimit.status, "ready");
  });
});

test("project and organization scopes are explicit without pretending to describe one API key", async () => {
  for (const [projectId, kind] of [
    ["proj_a", "project"],
    [undefined, "organization"],
  ] as const) {
    await withFetch(async (calls) => {
      const report = (
        await getOpenAIUsage(
          connection({ openaiReportingApiKeyId: undefined, openaiReportingProjectId: projectId })
        )
      ).openai.admin;
      assert.equal(report.scope.kind, kind);
      assert.equal(report.scope.apiKeyId, null);
      for (const { url } of calls.filter(({ url }) =>
        /\/usage\/completions$|\/costs$/.test(url.pathname)
      )) {
        assert.equal(url.searchParams.has("api_key_ids[]"), false);
        assert.equal(url.searchParams.has("project_ids[]"), Boolean(projectId));
      }
    });
  }
});

test("reporting failures are independent and never echo response bodies or credential text", async () => {
  await withFetch(
    async () => {
      const { openai, quotas } = await getOpenAIUsage(connection());
      assert.equal(openai.admin.usage.status, "ready");
      assert.equal(openai.admin.costs.status, "unauthorized");
      assert.equal(openai.admin.costs.data, null);
      assert.equal(openai.admin.projectRateLimits.status, "unavailable");
      assert.deepEqual(quotas, {});
      assert.doesNotMatch(JSON.stringify(openai), /secret-error|sk-admin|private@example/);
    },
    (call) =>
      call.url.pathname.endsWith("/costs")
        ? json({ error: { message: "secret-error sk-admin-TEST-ONLY" } }, 403)
        : call.url.pathname.endsWith("/rate_limits")
          ? json({}, 404)
          : defaults(call)
  );
});

test("malformed histories and out-of-scope rows never become a fake zero or another key's usage", async () => {
  for (const response of [
    {},
    page([{ ...usageRow(), api_key_id: "key_other" }]),
    page([{ ...usageRow(), input_tokens: -1 }]),
  ]) {
    await withFetch(
      async () => {
        const section = (await getOpenAIUsage(connection())).openai.admin.usage;
        assert.equal(section.status, "error");
        assert.equal(section.data, null);
      },
      (call) => (call.url.pathname.endsWith("/usage/completions") ? json(response) : defaults(call))
    );
  }
});

test("pagination errors retain explicitly partial data and cannot loop forever", async () => {
  await withFetch(
    async (calls) => {
      const section = (await getOpenAIUsage(connection())).openai.admin.usage;
      assert.equal(section.status, "partial");
      assert.equal(section.data?.requests, 2);
      assert.ok(calls.filter(({ url }) => url.pathname.endsWith("/usage/completions")).length <= 3);
    },
    (call) =>
      call.url.pathname.endsWith("/usage/completions")
        ? json(page([usageRow()], true, "same-cursor"))
        : defaults(call)
  );
});

test("cached sections retain their original timestamp and visible error on a failed refresh", async () => {
  const c = connection();
  let failed = false;
  await withFetch(
    async (calls) => {
      const first = (await getOpenAIUsage(c)).openai.admin;
      const callCount = calls.length;
      await getOpenAIUsage(c);
      assert.equal(calls.length, callCount, "normal refresh should use the bounded report cache");
      failed = true;
      const next = (await getOpenAIUsage(c, { forceRefresh: true })).openai.admin;
      assert.equal(next.costs.status, "error");
      assert.equal(next.costs.stale, true);
      assert.deepEqual(next.costs.data, first.costs.data);
      assert.equal(next.costs.fetchedAt, first.costs.fetchedAt);
      const changed = (
        await getOpenAIUsage({
          ...c,
          providerSpecificData: {
            ...c.providerSpecificData,
            openaiAdminApiKey: "sk-admin-replaced",
          },
        })
      ).openai.admin;
      assert.equal(
        changed.costs.data,
        null,
        "a different credential must not inherit prior credential's cache"
      );
    },
    (call) => (failed && call.url.pathname.endsWith("/costs") ? json({}, 503) : defaults(call))
  );
});

test("transport errors and redirects are bounded and never use an inference credential fallback", async () => {
  await withFetch(
    async (calls) => {
      const report = (await getOpenAIUsage(connection())).openai.admin;
      assert.notEqual(report.usage.status, "ready");
      assert.doesNotMatch(JSON.stringify(report), /SECRET-FROM-ERROR/);
      assert.ok(
        calls.every(
          ({ init }) =>
            new Headers(init.headers).get("authorization") === "Bearer sk-admin-TEST-ONLY"
        )
      );
    },
    () => {
      throw new Error("SECRET-FROM-ERROR");
    }
  );
});

test("a non-native connection cannot activate native Admin reporting", async () => {
  await withFetch(async (calls) => {
    await getOpenAIUsage({ ...connection(), provider: "openai-compatible-custom" });
    assert.equal(calls.length, 0);
  });
});

test("each selected period has explicit UTC bounds and participates in the report cache key", async (t) => {
  const now = Date.parse("2026-11-06T12:30:00Z");
  t.mock.timers.enable({ apis: ["Date"], now });
  const c = connection();
  await withFetch(async () => {
    for (const [preset, expectedStart] of [
      ["month", "2026-11-01T00:00:00Z"],
      ["7d", "2026-10-31T00:00:00Z"],
      ["30d", "2026-10-08T00:00:00Z"],
    ]) {
      const report = (
        await getOpenAIUsage({
          ...c,
          providerSpecificData: { ...c.providerSpecificData, openaiReportingPeriod: preset },
        })
      ).openai.admin;
      assert.equal(report.period.startTime, Date.parse(expectedStart) / 1000);
      assert.equal(report.period.endTime, now / 1000);
      assert.equal(report.period.preset, preset);
    }
  });
});

test("the report deadline aborts pending metadata requests without hanging or leaking errors", async () => {
  let signal: AbortSignal | null = null;
  await withFetch(
    async () => {
      const promise = getOpenAIUsage(connection());
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.ok(signal);
      signal.dispatchEvent(new Event("abort"));
      const report = (await promise).openai.admin;
      assert.equal(report.projects.status, "error");
      assert.equal(report.usage.data, null);
      assert.doesNotMatch(JSON.stringify(report), /ABORT-PRIVATE/);
    },
    ({ init }) => {
      signal = init.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("ABORT-PRIVATE")), { once: true });
      });
    }
  );
});

test("unknown project IDs and unsafe config never result in broader or custom-origin requests", async () => {
  await withFetch(async (calls) => {
    const report = (
      await getOpenAIUsage(
        connection({ openaiReportingProjectId: "proj_missing", openaiReportingApiKeyId: null })
      )
    ).openai.admin;
    assert.equal(report.usage.status, "unavailable");
    assert.equal(
      calls.some(({ url }) => url.pathname.endsWith("/costs")),
      false
    );
  });
  for (const fields of [
    { openaiReportingProjectId: "../projects/proj_a?secret=abc" },
    { openaiAdminApiKey: "sk-admin\r\nX-Leak: secret" },
    { openaiReportingPeriod: "lifetime" },
  ]) {
    await withFetch(async (calls) => {
      const report = (await getOpenAIUsage(connection(fields))).openai.admin;
      assert.equal(calls.length, 0);
      assert.equal(report.usage.status, "error");
    });
  }
});

test("currencies remain separate and unparseable cost amounts are unavailable rather than free", async () => {
  await withFetch(
    async () => {
      const costs = (await getOpenAIUsage(connection())).openai.admin.costs;
      assert.deepEqual(costs.data?.amounts, [
        { value: 1.25, currency: "USD" },
        { value: 2.5, currency: "EUR" },
      ]);
    },
    (call) =>
      call.url.pathname.endsWith("/costs")
        ? json(page([costRow(), costRow(2.5, "eur")]))
        : defaults(call)
  );
  await withFetch(
    async () => {
      const costs = (await getOpenAIUsage(connection())).openai.admin.costs;
      assert.equal(costs.status, "error");
      assert.equal(costs.data, null);
    },
    (call) =>
      call.url.pathname.endsWith("/costs")
        ? json(page([{ ...costRow(), amount: { currency: "usd" } }]))
        : defaults(call)
  );
});

test("invalid rows coexist with explicitly partial valid totals", async () => {
  await withFetch(
    async () => {
      const usage = (await getOpenAIUsage(connection())).openai.admin.usage;
      assert.equal(usage.status, "partial");
      assert.equal(usage.data?.requests, 2);
    },
    (call) =>
      call.url.pathname.endsWith("/usage/completions")
        ? json(page([usageRow(), { ...usageRow(), input_tokens: "unknown" }]))
        : defaults(call)
  );
});
