import React from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ConnectionQuotaPanel from "../../../src/app/(dashboard)/dashboard/providers/[id]/components/ConnectionQuotaPanel";
import QuotaCardExpanded from "../../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/parts/QuotaCardExpanded";
import OpenAIQuotaReport from "../../../src/app/(dashboard)/dashboard/providers/[id]/components/OpenAIQuotaReport";
import type { OpenAIUsageReport } from "../../../open-sse/services/usage/openaiTypes";

afterEach(cleanup);

const missing = () => ({ status: "not_configured" as const, data: null, fetchedAt: null });
const report: OpenAIUsageReport = {
  version: 1,
  rateLimits: {
    status: "observed",
    lastObservedAt: "2026-11-06T10:00:00.000Z",
    observations: [
      {
        model: "gpt-observed-18837",
        organizationId: "org_1",
        projectId: "proj_1",
        observedAt: "2026-11-06T10:00:00.000Z",
        requests: {
          limit: 100,
          remaining: 42,
          resetAt: "2026-11-06T10:01:00.000Z",
          observedAt: "2026-11-06T10:00:00.000Z",
          stale: true,
        },
        tokens: null,
        projectTokens: null,
      },
    ],
  },
  admin: {
    configured: false,
    scope: { kind: "organization", projectId: null, apiKeyId: null },
    period: { preset: "month", startTime: 1793491200, endTime: 1793959200, bucketWidth: "1d" },
    usage: missing(),
    costs: missing(),
    organizationSpendLimit: missing(),
    projectSpendLimit: missing(),
    projectRateLimits: missing(),
    organizationAlerts: missing(),
    projectAlerts: missing(),
    projects: missing(),
    apiKeys: missing(),
  },
  creditBalance: {
    status: "unavailable",
    billingUrl: "https://platform.openai.com/settings/organization/billing/overview",
  },
};

describe("native OpenAI report surfaces", () => {
  it("renders observed limits in the connection panel even when generic quotas are empty", () => {
    render(
      <ConnectionQuotaPanel
        providerId="openai"
        connection={{ id: "conn_1", provider: "openai" }}
        cache={{ quotas: {}, openai: report }}
      />
    );
    expect(screen.getByText("gpt-observed-18837")).toBeTruthy();
  });

  it("keeps native report data visible in the main limits card during refresh", () => {
    render(
      <QuotaCardExpanded
        quotas={[]}
        openai={report}
        providerId="openai"
        loading={true}
        error={null}
        hasStaleData={false}
        onRefresh={vi.fn()}
        onOpenCutoff={vi.fn()}
        onOpenCost={vi.fn()}
        canEditCutoff={false}
        hasCutoffOverrides={false}
      />
    );
    expect(screen.getByText("gpt-observed-18837")).toBeTruthy();
    expect(screen.queryByText("No quota data")).toBeNull();
  });

  it("shows cached zero usage as stale while unavailable costs stay distinct from zero", () => {
    const scoped = structuredClone(report);
    scoped.admin.configured = true;
    scoped.admin.scope = { kind: "api_key", projectId: "proj_1", apiKeyId: "key_exact_1" };
    scoped.admin.usage = {
      status: "error",
      stale: true,
      fetchedAt: "2026-11-05T09:30:00.000Z",
      message: "The latest usage refresh failed.",
      data: { requests: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: null, models: [] },
    };
    scoped.admin.costs = {
      status: "unauthorized",
      fetchedAt: "2026-11-06T09:30:00.000Z",
      data: null,
      message: "This Admin key cannot read costs.",
    };
    render(<OpenAIQuotaReport report={scoped} />);
    expect(screen.getByText(/key_exact_1/)).toBeTruthy();
    const usage = screen.getByRole("heading", { name: "Usage" }).closest("section")!;
    expect(within(usage).getByText(/Refresh failed.*Stale/)).toBeTruthy();
    expect(within(usage).getAllByText("0")).toHaveLength(3);
    expect(within(usage).getByText(/Fetched/)).toBeTruthy();
    const costs = screen.getByRole("heading", { name: "Recorded costs" }).closest("section")!;
    expect(within(costs).getByText("No access")).toBeTruthy();
    expect(within(costs).queryByText(/No cost records/)).toBeNull();
    expect(within(costs).queryByText("0")).toBeNull();
    expect(screen.getByText(/Prepaid credit balance is unavailable/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open OpenAI billing" }).getAttribute("href")).toBe(
      "https://platform.openai.com/settings/organization/billing/overview"
    );
  });
});
