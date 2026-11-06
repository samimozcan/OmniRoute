import { createHash } from "node:crypto";
import { collectOpenAIAdminReport, openAIReportingConfigSchema } from "./openaiAdmin.ts";
import { getOpenAIRateLimitObservations } from "./openaiRateLimits.ts";
import type {
  OpenAIAdminReport,
  OpenAIReportingRange,
  OpenAIReportingScope,
  OpenAIReportSection,
  OpenAIReportingPeriod,
  OpenAIUsageConnection,
  OpenAIUsageReport,
} from "./openaiTypes.ts";

const REPORT_CACHE_MS = 60000;
const MAX_CACHED_REPORTS = 100;
const cache = new Map<string, { admin: OpenAIAdminReport; expiresAt: number }>();
const pending = new Map<string, Promise<OpenAIAdminReport>>();
const SECTIONS = [
  "usage",
  "costs",
  "organizationSpendLimit",
  "projectSpendLimit",
  "projectRateLimits",
  "organizationAlerts",
  "projectAlerts",
  "projects",
  "apiKeys",
] as const;

export function emptyOpenAIAdminReport(
  configured: boolean,
  scope: OpenAIReportingScope,
  period: OpenAIReportingRange
): OpenAIAdminReport {
  const missing = <T>(): OpenAIReportSection<T> => ({
    status: "not_configured",
    data: null,
    fetchedAt: null,
  });
  return {
    configured,
    scope,
    period,
    usage: missing(),
    costs: missing(),
    organizationSpendLimit: missing(),
    projectSpendLimit: missing(),
    projectRateLimits: missing(),
    organizationAlerts: missing(),
    projectAlerts: missing(),
    projects: missing(),
    apiKeys: missing(),
  };
}

function reportingRange(preset: OpenAIReportingPeriod): OpenAIReportingRange {
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000;
  return {
    preset,
    startTime:
      preset === "month"
        ? Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000
        : today - (preset === "7d" ? 6 : 29) * 86400,
    endTime: Math.floor(now.getTime() / 1000),
    bucketWidth: "1d",
  };
}

async function adminReport(connection: OpenAIUsageConnection, forceRefresh: boolean) {
  const data = connection.providerSpecificData ?? {};
  const rawAdminKey = connection.provider === "openai" ? data.openaiAdminApiKey : undefined;
  const parsed = openAIReportingConfigSchema.safeParse({
    adminKey: rawAdminKey ?? "",
    projectId: data.openaiReportingProjectId || null,
    apiKeyId: data.openaiReportingApiKeyId || null,
    period: data.openaiReportingPeriod || "month",
  });
  const config = parsed.success ? parsed.data : null;
  const scope: OpenAIReportingScope = {
    kind: config?.apiKeyId ? "api_key" : config?.projectId ? "project" : "organization",
    projectId: config?.projectId ?? null,
    apiKeyId: config?.apiKeyId ?? null,
  };
  const period = reportingRange(config?.period ?? "month");
  const report = emptyOpenAIAdminReport(Boolean(rawAdminKey), scope, period);
  if (!config) {
    for (const name of SECTIONS)
      report[name] = {
        status: "error",
        data: null,
        fetchedAt: null,
        message: "The OpenAI reporting settings are invalid.",
      };
    return report;
  }
  if (!config.adminKey || connection.provider !== "openai") return report;
  // Hash credentials/config so neither cache keys nor cached reports contain an Admin secret.
  const cacheKey = createHash("sha256")
    .update(
      JSON.stringify([connection.id ?? "", config.adminKey, scope, period.preset, period.startTime])
    )
    .digest("hex");
  const previous = cache.get(cacheKey);
  if (!forceRefresh && previous && previous.expiresAt > Date.now())
    return structuredClone(previous.admin);
  const inFlight = pending.get(cacheKey);
  if (inFlight) return structuredClone(await inFlight);
  const collect = (async () => {
    const next = await collectOpenAIAdminReport(config.adminKey, report);
    if (previous) {
      for (const name of SECTIONS) {
        const section: OpenAIReportSection<unknown> = next[name];
        const prior: OpenAIReportSection<unknown> = previous.admin[name];
        if (section.status !== "ready" && section.data === null && prior.data !== null) {
          // Keep the current failure visible while retaining the last measured value/time.
          Object.assign(next, {
            [name]: { ...section, data: prior.data, fetchedAt: prior.fetchedAt, stale: true },
          });
        }
      }
    }
    cache.delete(cacheKey);
    cache.set(cacheKey, { admin: next, expiresAt: Date.now() + REPORT_CACHE_MS });
    while (cache.size > MAX_CACHED_REPORTS) cache.delete(cache.keys().next().value);
    return next;
  })();
  pending.set(cacheKey, collect);
  try {
    return structuredClone(await collect);
  } finally {
    pending.delete(cacheKey);
  }
}

export async function getOpenAIUsage(
  connection: OpenAIUsageConnection,
  options: { forceRefresh?: boolean } = {}
): Promise<{ plan: string; quotas: Record<string, never>; openai: OpenAIUsageReport }> {
  return {
    plan: "API key",
    quotas: {},
    openai: {
      version: 1,
      rateLimits: getOpenAIRateLimitObservations({ connectionId: connection.id || "" }),
      admin: await adminReport(connection, options.forceRefresh === true),
      creditBalance: {
        status: "unavailable",
        billingUrl: "https://platform.openai.com/settings/organization/billing/overview",
      },
    },
  };
}
