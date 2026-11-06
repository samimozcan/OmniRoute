import { z } from "zod";
import type {
  OpenAIAdminReport,
  OpenAICostSummary,
  OpenAIProjectRateLimit,
  OpenAIReportingApiKey,
  OpenAIReportingProject,
  OpenAIReportingRange,
  OpenAIReportingScope,
  OpenAIReportSection,
  OpenAIReportStatus,
  OpenAISpendAlert,
  OpenAISpendLimit,
  OpenAIUsageSummary,
  OpenAIUsageTotals,
} from "./openaiTypes.ts";

const API_ORIGIN = "https://api.openai.com";
const MAX_PAGES = 10;
const MAX_ROWS = 10000;
const REPORT_TIMEOUT_MS = 15000;
const id = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/);
const label = z.string().max(512);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const currency = z
  .string()
  .regex(/^[A-Za-z]{3}$/)
  .transform((value) => value.toUpperCase());

export const openAIReportingConfigSchema = z.object({
  adminKey: z
    .string()
    .trim()
    .max(4096)
    .regex(/^[^\r\n\0]*$/),
  projectId: id.nullable(),
  apiKeyId: id.nullable(),
  period: z.enum(["month", "7d", "30d"]),
});

const listSchema = z.object({
  object: z.literal("list"),
  data: z.array(z.unknown()),
  has_more: z.boolean(),
  last_id: z.string().nullable().optional(),
});
const pageSchema = z.object({
  object: z.literal("page"),
  has_more: z.boolean(),
  next_page: z.string().nullable().optional(),
  data: z.array(
    z.object({
      object: z.literal("bucket"),
      start_time: count,
      end_time: count,
      results: z.array(z.unknown()),
    })
  ),
});
const usageSchema = z.object({
  object: z.literal("organization.usage.completions.result"),
  input_tokens: count,
  output_tokens: count,
  num_model_requests: count,
  input_cached_tokens: count.nullable().optional(),
  model: label.nullable().optional(),
  project_id: id.nullable().optional(),
  api_key_id: id.nullable().optional(),
});
const costSchema = z.object({
  object: z.literal("organization.costs.result"),
  amount: z.object({ value: z.number().finite(), currency }),
  line_item: label.nullable().optional(),
  project_id: id.nullable().optional(),
  api_key_id: id.nullable().optional(),
});
const spendSchema = z.object({
  object: z.enum(["organization.spend_limit", "project.spend_limit"]),
  threshold_amount: count,
  currency,
  interval: z.string().min(1).max(40),
  enforcement: z.object({ status: z.string().min(1).max(64) }),
});
const alertSchema = z.object({
  object: z.enum(["organization.spend_alert", "project.spend_alert"]),
  id,
  threshold_amount: count,
  currency,
  interval: z.string().min(1).max(40),
});
const projectSchema = z.object({
  object: z.literal("organization.project"),
  id,
  name: label.nullable().optional(),
});
const keySchema = z.object({
  object: z.literal("organization.project.api_key"),
  id,
  name: label,
  created_at: count,
  last_used_at: count.nullable(),
  expires_at: count.nullable().optional(),
  owner_project_access: label.optional(),
});
const rateSchema = z.object({
  object: z.literal("project.rate_limit"),
  id,
  model: label,
  max_requests_per_1_minute: count,
  max_tokens_per_1_minute: count,
  max_requests_per_1_day: count.optional(),
  max_images_per_1_minute: count.optional(),
  max_audio_megabytes_per_1_minute: count.optional(),
  batch_1_day_max_input_tokens: count.optional(),
});

class ReportingError extends Error {
  constructor(
    readonly status: OpenAIReportStatus,
    message: string
  ) {
    super(message);
  }
}
function failure<T>(error: unknown): OpenAIReportSection<T> {
  const known =
    error instanceof ReportingError
      ? error
      : new ReportingError(
          "error",
          "OpenAI reporting is unreachable or returned an invalid response."
        );
  return { status: known.status, data: null, fetchedAt: null, message: known.message };
}
export function unavailableOpenAISection<T>(message: string): OpenAIReportSection<T> {
  return { status: "unavailable", data: null, fetchedAt: null, message };
}

type Client = (path: string, query?: URLSearchParams) => Promise<unknown>;
function createClient(adminKey: string): Client {
  const signal = AbortSignal.timeout(REPORT_TIMEOUT_MS);
  return async (path, query = new URLSearchParams()) => {
    const url = new URL(path, API_ORIGIN);
    url.search = query.toString();
    const response = await fetch(url, {
      method: "GET",
      headers: { authorization: `Bearer ${adminKey}`, accept: "application/json" },
      redirect: "error",
      cache: "no-store",
      signal,
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new ReportingError(
          "unauthorized",
          "The Admin key has no access to this reporting endpoint."
        );
      }
      if (response.status === 404) {
        throw new ReportingError(
          "unavailable",
          "This reporting endpoint or resource is unavailable."
        );
      }
      throw new ReportingError(
        "error",
        response.status === 429
          ? "OpenAI reporting is rate limited. Try again later."
          : `OpenAI reporting returned HTTP ${response.status}.`
      );
    }
    // Discard all unselected fields after parsing; never persist full upstream payloads.
    const body = await response.text();
    if (body.length > 2 * 1024 * 1024)
      throw new ReportingError("error", "The reporting response is too large.");
    return JSON.parse(body) as unknown;
  };
}

async function pages<T>(
  client: Client,
  path: string,
  query: URLSearchParams,
  mode: "list" | "page",
  parse: (raw: unknown) => T
): Promise<OpenAIReportSection<T[]>> {
  const rows: T[] = [];
  const seen = new Set<string>();
  let hasEvidence = false;
  let malformed = false;
  let fetchedAt: string | null = null;
  const incomplete = (message: string): OpenAIReportSection<T[]> => ({
    status: hasEvidence ? "partial" : "error",
    data: hasEvidence ? rows : null,
    fetchedAt,
    message,
  });
  try {
    for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber++) {
      const raw = await client(path, query);
      const body = mode === "page" ? pageSchema.parse(raw) : listSchema.parse(raw);
      const rawRows =
        "next_page" in body || body.object === "page"
          ? (body as z.infer<typeof pageSchema>).data.flatMap((bucket) => bucket.results)
          : (body as z.infer<typeof listSchema>).data;
      const cursor = body.object === "page" ? body.next_page : body.last_id;
      // A repeated continuation indicates an unusable page, which must not double totals.
      if (body.has_more && cursor && seen.has(cursor))
        return incomplete("Reporting pagination repeated a cursor; totals are incomplete.");
      fetchedAt = new Date().toISOString();
      if (rawRows.length === 0) hasEvidence = true;
      for (const row of rawRows) {
        if (rows.length >= MAX_ROWS)
          return incomplete("The reporting row limit was reached; totals are incomplete.");
        try {
          rows.push(parse(row));
          hasEvidence = true;
        } catch {
          malformed = true;
        }
      }
      if (!body.has_more) {
        if (malformed)
          return incomplete(
            "Some reporting rows were invalid or outside the selected scope; totals are incomplete."
          );
        return { status: "ready", data: rows, fetchedAt };
      }
      if (!cursor || cursor.length > 2048)
        return incomplete(
          "Reporting pagination did not provide a valid continuation; totals are incomplete."
        );
      seen.add(cursor);
      query.set(mode === "page" ? "page" : "after", cursor);
    }
    return incomplete("The reporting page limit was reached; totals are incomplete.");
  } catch (error) {
    if (hasEvidence)
      return incomplete("A later reporting page could not be retrieved; totals are incomplete.");
    return failure(error);
  }
}

async function spendLimit(
  client: Client,
  path: string
): Promise<OpenAIReportSection<OpenAISpendLimit>> {
  try {
    const raw = spendSchema.parse(await client(path));
    return {
      status: "ready",
      fetchedAt: new Date().toISOString(),
      data: {
        value: raw.threshold_amount / 100,
        currency: raw.currency,
        interval: raw.interval,
        enforcement: raw.enforcement.status,
      },
    };
  } catch (error) {
    return failure(error);
  }
}

function mapSection<T, R>(
  section: OpenAIReportSection<T>,
  map: (value: T) => R
): OpenAIReportSection<R> {
  if (section.data === null) return { ...section, data: null };
  try {
    return { ...section, data: map(section.data) };
  } catch (error) {
    return failure(error);
  }
}
function inScope(
  row: { project_id?: string | null; api_key_id?: string | null },
  scope: OpenAIReportingScope
) {
  if (
    (scope.projectId && row.project_id !== scope.projectId) ||
    (scope.apiKeyId && row.api_key_id !== scope.apiKeyId)
  ) {
    throw new ReportingError("error", "The reporting response does not match the selected scope.");
  }
}
function addUsage(total: OpenAIUsageTotals, row: z.infer<typeof usageSchema>) {
  total.requests += row.num_model_requests;
  total.inputTokens += row.input_tokens;
  total.outputTokens += row.output_tokens;
  total.cachedInputTokens =
    total.cachedInputTokens === null || row.input_cached_tokens == null
      ? null
      : total.cachedInputTokens + row.input_cached_tokens;
  if (
    ![total.requests, total.inputTokens, total.outputTokens, total.cachedInputTokens ?? 0].every(
      Number.isSafeInteger
    )
  ) {
    throw new ReportingError("error", "The reported usage is outside the supported numeric range.");
  }
}
function summarizeUsage(rows: z.infer<typeof usageSchema>[]): OpenAIUsageSummary {
  const empty = (): OpenAIUsageTotals => ({
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
  });
  const total = empty();
  const models = new Map<string | null, OpenAIUsageTotals>();
  for (const row of rows) {
    addUsage(total, row);
    const model = row.model ?? null;
    const modelTotal = models.get(model) ?? empty();
    addUsage(modelTotal, row);
    models.set(model, modelTotal);
  }
  return { ...total, models: [...models].map(([model, totals]) => ({ model, ...totals })) };
}
function summarizeCosts(rows: z.infer<typeof costSchema>[]): OpenAICostSummary {
  const totals = new Map<string, number>();
  const items: OpenAICostSummary["items"] = [];
  for (const row of rows) {
    const total = (totals.get(row.amount.currency) ?? 0) + row.amount.value;
    if (!Number.isFinite(total))
      throw new ReportingError(
        "error",
        "The reported cost is outside the supported numeric range."
      );
    totals.set(row.amount.currency, total);
    items.push({
      value: row.amount.value,
      currency: row.amount.currency,
      lineItem: row.line_item ?? null,
      projectId: row.project_id ?? null,
      apiKeyId: row.api_key_id ?? null,
    });
  }
  return { amounts: [...totals].map(([currency, value]) => ({ currency, value })), items };
}

function historyQuery(scope: OpenAIReportingScope, period: OpenAIReportingRange, costs: boolean) {
  const query = new URLSearchParams({
    start_time: String(period.startTime),
    end_time: String(period.endTime),
    bucket_width: "1d",
    limit: costs ? "180" : "31",
  });
  if (scope.projectId) query.append("project_ids[]", scope.projectId);
  if (scope.apiKeyId) query.append("api_key_ids[]", scope.apiKeyId);
  for (const field of ["project_id", "api_key_id", costs ? "line_item" : "model"])
    query.append("group_by[]", field);
  return query;
}

export async function collectOpenAIAdminReport(
  adminKey: string,
  report: OpenAIAdminReport
): Promise<OpenAIAdminReport> {
  const client = createClient(adminKey);
  const { scope, period } = report;
  const projectPath = scope.projectId
    ? `/v1/organization/projects/${encodeURIComponent(scope.projectId)}`
    : null;
  const alerts = (path: string) =>
    pages<OpenAISpendAlert>(
      client,
      path,
      new URLSearchParams({ limit: "100", order: "asc" }),
      "list",
      (row) => {
        const raw = alertSchema.parse(row);
        return {
          id: raw.id,
          value: raw.threshold_amount / 100,
          currency: raw.currency,
          interval: raw.interval,
        };
      }
    );
  const needsProject = <T>() =>
    unavailableOpenAISection<T>("Select an OpenAI project to view this section.");
  const [
    projects,
    apiKeys,
    organizationSpendLimit,
    projectSpendLimit,
    projectRateLimits,
    organizationAlerts,
    projectAlerts,
  ] = await Promise.all([
    pages<OpenAIReportingProject>(
      client,
      "/v1/organization/projects",
      new URLSearchParams({ limit: "100", include_archived: "true" }),
      "list",
      (row) => {
        const raw = projectSchema.parse(row);
        return { id: raw.id, name: raw.name || raw.id };
      }
    ),
    projectPath
      ? pages<OpenAIReportingApiKey>(
          client,
          `${projectPath}/api_keys`,
          new URLSearchParams({ limit: "100", owner_project_access: "any" }),
          "list",
          (row) => {
            const raw = keySchema.parse(row);
            return {
              id: raw.id,
              name: raw.name,
              createdAt: raw.created_at,
              lastUsedAt: raw.last_used_at,
              expiresAt: raw.expires_at ?? null,
              ownerProjectAccess: raw.owner_project_access ?? null,
            };
          }
        )
      : Promise.resolve(needsProject<OpenAIReportingApiKey[]>()),
    spendLimit(client, "/v1/organization/spend_limit"),
    projectPath
      ? spendLimit(client, `${projectPath}/spend_limit`)
      : Promise.resolve(needsProject<OpenAISpendLimit>()),
    projectPath
      ? pages<OpenAIProjectRateLimit>(
          client,
          `${projectPath}/rate_limits`,
          new URLSearchParams({ limit: "100" }),
          "list",
          (row) => {
            const raw = rateSchema.parse(row);
            return {
              id: raw.id,
              model: raw.model,
              requestsPerMinute: raw.max_requests_per_1_minute,
              tokensPerMinute: raw.max_tokens_per_1_minute,
              requestsPerDay: raw.max_requests_per_1_day ?? null,
              imagesPerMinute: raw.max_images_per_1_minute ?? null,
              audioMegabytesPerMinute: raw.max_audio_megabytes_per_1_minute ?? null,
              batchInputTokensPerDay: raw.batch_1_day_max_input_tokens ?? null,
            };
          }
        )
      : Promise.resolve(needsProject<OpenAIProjectRateLimit[]>()),
    alerts("/v1/organization/spend_alerts"),
    projectPath
      ? alerts(`${projectPath}/spend_alerts`)
      : Promise.resolve(needsProject<OpenAISpendAlert[]>()),
  ]);
  Object.assign(report, {
    projects,
    apiKeys,
    organizationSpendLimit,
    projectSpendLimit,
    projectRateLimits,
    organizationAlerts,
    projectAlerts,
  });
  // A requested key/project must be authenticated metadata, never guessed from a redacted secret.
  let scopeError: string | null = null;
  if (scope.projectId && !projects.data?.some((project) => project.id === scope.projectId)) {
    scopeError =
      "The selected project could not be verified using the Admin key. No broader report was requested.";
  }
  if (
    scope.apiKeyId &&
    (!scope.projectId || !apiKeys.data?.some((key) => key.id === scope.apiKeyId))
  ) {
    scopeError =
      "The selected API-key ID could not be verified in the selected project. No broader report was requested.";
  }
  if (scopeError) {
    report.usage = unavailableOpenAISection(scopeError);
    report.costs = unavailableOpenAISection(scopeError);
    return report;
  }
  const [usage, costs] = await Promise.all([
    pages(
      client,
      "/v1/organization/usage/completions",
      historyQuery(scope, period, false),
      "page",
      (row) => {
        const raw = usageSchema.parse(row);
        inScope(raw, scope);
        return raw;
      }
    ),
    pages(client, "/v1/organization/costs", historyQuery(scope, period, true), "page", (row) => {
      const raw = costSchema.parse(row);
      inScope(raw, scope);
      return raw;
    }),
  ]);
  report.usage = mapSection(usage, summarizeUsage);
  report.costs = mapSection(costs, summarizeCosts);
  return report;
}
