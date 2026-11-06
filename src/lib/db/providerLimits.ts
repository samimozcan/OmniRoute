import {
  sanitizeProviderBillingStatus,
  type ProviderBillingStatus,
} from "@/shared/utils/providerBilling";
import { getDbInstance, isBuildPhase, isCloud } from "./core";
import { parseCodexPaidCredits, type CodexPaidCredits } from "@/lib/providers/codexPaidCredits";
import type { OpenAIUsageReport } from "@omniroute/open-sse/services/usage/openaiTypes.ts";
import {
  ageOpenAIRateLimitObservations,
  getOpenAIRateLimitObservations,
} from "@omniroute/open-sse/services/usage/openaiRateLimits.ts";

type JsonRecord = Record<string, unknown>;

interface StatementLike<TRow = unknown> {
  all: (...params: unknown[]) => TRow[];
  get: (...params: unknown[]) => TRow | undefined;
  run: (...params: unknown[]) => { changes?: number };
}

interface DbLike {
  prepare: <TRow = unknown>(sql: string) => StatementLike<TRow>;
  transaction: <T extends (...args: any[]) => unknown>(fn: T) => T;
}

interface KeyValueRow {
  key: string;
  value: string;
}

export interface ProviderLimitsCacheEntry {
  quotas: JsonRecord | null;
  modelQuotas?: JsonRecord;
  plan: unknown;
  message: string | null;
  fetchedAt: string;
  source?: string | null;
  bankedResetCredits?: number;
  paidCredits?: CodexPaidCredits;
  billing?: ProviderBillingStatus;
  quotaGroups?: Array<Record<string, unknown>>;
  openai?: OpenAIUsageReport;
}

const PROVIDER_LIMITS_CACHE_NAMESPACE = "providerLimitsCache";

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function toRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function sanitizeCacheEntryForStorage(entry: ProviderLimitsCacheEntry): ProviderLimitsCacheEntry {
  const { billing: rawBilling, ...rest } = entry;
  const billing = sanitizeProviderBillingStatus(rawBilling);
  return billing ? { ...rest, billing } : rest;
}

function normalizeOpenAIReport(
  value: unknown,
  connectionId: string
): OpenAIUsageReport | undefined {
  const report = toRecord(value);
  const rateLimits = toRecord(report?.rateLimits);
  if (
    report?.version !== 1 ||
    !rateLimits ||
    !Array.isArray(rateLimits.observations) ||
    !toRecord(report.admin) ||
    !toRecord(report.creditBalance)
  )
    return undefined;
  for (const candidate of rateLimits.observations) {
    const observation = toRecord(candidate);
    if (!observation || typeof observation.observedAt !== "string") return undefined;
    for (const name of ["requests", "tokens", "projectTokens"]) {
      const window = observation[name];
      if (
        window !== null &&
        (!toRecord(window) || typeof (window as JsonRecord).observedAt !== "string")
      )
        return undefined;
    }
  }
  const parsed = report as unknown as OpenAIUsageReport;
  const live = getOpenAIRateLimitObservations({ connectionId });
  return {
    ...parsed,
    rateLimits:
      live.status === "observed"
        ? live
        : ageOpenAIRateLimitObservations(parsed.rateLimits, { forceStale: true }),
  };
}

function normalizeCacheEntry(
  value: unknown,
  connectionId: string
): ProviderLimitsCacheEntry | null {
  const record = toRecord(value);
  if (!record) return null;

  const fetchedAt =
    typeof record.fetchedAt === "string" && record.fetchedAt.trim() ? record.fetchedAt : null;
  if (!fetchedAt) return null;

  const bankedResetCredits = Number(record.bankedResetCredits);
  const paidCredits = parseCodexPaidCredits(record.paidCredits);
  const billing = sanitizeProviderBillingStatus(record.billing);
  const modelQuotas = toRecord(record.modelQuotas);
  const openai = normalizeOpenAIReport(record.openai, connectionId);

  return {
    quotas: toRecord(record.quotas),
    ...(modelQuotas ? { modelQuotas } : {}),
    plan: record.plan ?? null,
    message: typeof record.message === "string" ? record.message : null,
    fetchedAt,
    source: typeof record.source === "string" ? record.source : null,
    ...(Number.isFinite(bankedResetCredits) ? { bankedResetCredits } : {}),
    ...(paidCredits ? { paidCredits } : {}),
    ...(billing ? { billing } : {}),
    ...(openai ? { openai } : {}),
    ...(Array.isArray(record.quotaGroups)
      ? { quotaGroups: record.quotaGroups as Array<Record<string, unknown>> }
      : {}),
  };
}

export function getProviderLimitsCache(connectionId: string): ProviderLimitsCacheEntry | null {
  if (isBuildPhase || isCloud) return null;
  const db = getDbInstance() as unknown as DbLike;
  const row = db
    .prepare("SELECT value FROM key_value WHERE namespace = ? AND key = ?")
    .get(PROVIDER_LIMITS_CACHE_NAMESPACE, connectionId) as KeyValueRow | undefined;
  if (!row?.value) return null;
  return normalizeCacheEntry(parseJson(row.value), connectionId);
}

export function getAllProviderLimitsCache(): Record<string, ProviderLimitsCacheEntry> {
  if (isBuildPhase || isCloud) return {};
  const db = getDbInstance() as unknown as DbLike;
  const rows = db
    .prepare("SELECT key, value FROM key_value WHERE namespace = ?")
    .all(PROVIDER_LIMITS_CACHE_NAMESPACE) as KeyValueRow[];

  const result: Record<string, ProviderLimitsCacheEntry> = {};
  for (const row of rows) {
    const parsed = normalizeCacheEntry(parseJson(row.value), row.key);
    if (parsed) {
      result[row.key] = parsed;
    }
  }
  return result;
}

export function setProviderLimitsCache(
  connectionId: string,
  entry: ProviderLimitsCacheEntry
): ProviderLimitsCacheEntry {
  const sanitized = sanitizeCacheEntryForStorage(entry);
  if (isBuildPhase || isCloud) return sanitized;
  const db = getDbInstance() as unknown as DbLike;
  db.prepare("INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES (?, ?, ?)").run(
    PROVIDER_LIMITS_CACHE_NAMESPACE,
    connectionId,
    JSON.stringify(sanitized)
  );
  return sanitized;
}

export function setProviderLimitsCacheBatch(
  entries: Array<{ connectionId: string; entry: ProviderLimitsCacheEntry }>
): number {
  if (isBuildPhase || isCloud || entries.length === 0) return 0;
  const db = getDbInstance() as unknown as DbLike;
  const insert = db.prepare(
    "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES (?, ?, ?)"
  );
  const tx = db.transaction(
    (items: Array<{ connectionId: string; entry: ProviderLimitsCacheEntry }>) => {
      for (const item of items) {
        insert.run(
          PROVIDER_LIMITS_CACHE_NAMESPACE,
          item.connectionId,
          JSON.stringify(sanitizeCacheEntryForStorage(item.entry))
        );
      }
    }
  );
  tx(entries);
  return entries.length;
}

export function deleteProviderLimitsCache(connectionId: string): void {
  if (isBuildPhase || isCloud) return;
  const db = getDbInstance() as unknown as DbLike;
  db.prepare("DELETE FROM key_value WHERE namespace = ? AND key = ?").run(
    PROVIDER_LIMITS_CACHE_NAMESPACE,
    connectionId
  );
}
