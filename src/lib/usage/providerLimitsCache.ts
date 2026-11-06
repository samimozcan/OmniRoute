import type { ProviderLimitsCacheEntry } from "@/lib/db/providerLimits";
import { sanitizeProviderBillingStatus } from "@/shared/utils/providerBilling";
import { GROK_BUILD_ADDITIONAL_CREDITS_URL } from "@/shared/utils/grokBilling";
import { parseCodexPaidCredits } from "@/lib/providers/codexPaidCredits";
import type { OpenAIUsageReport } from "@omniroute/open-sse/services/usage/openaiTypes.ts";
import { ageOpenAIRateLimitObservations } from "@omniroute/open-sse/services/usage/openaiRateLimits.ts";

const GROK_CLI_PROVIDER = "grok-cli";
const GLM_RESET_CARD_PROVIDERS = new Set(["glm", "glm-cn", "glmt", "zai"]);

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasUsableCachedData(cache: ProviderLimitsCacheEntry | null | undefined): boolean {
  return Boolean(
    cache?.billing ||
    (cache?.quotas && Object.keys(cache.quotas).length > 0) ||
    (cache?.modelQuotas && Object.keys(cache.modelQuotas).length > 0)
  );
}

export function toProviderLimitsCacheEntry(
  usage: JsonRecord,
  source: string,
  // A fetcher that serves its last known quota (e.g. Claude during a 429 cooldown) flags it
  // `_stale` with the original read time — keep that time instead of stamping it as fresh.
  fetchedAt = usage._stale === true && typeof usage._staleSince === "string"
    ? usage._staleSince
    : new Date().toISOString()
): ProviderLimitsCacheEntry {
  const bankedResetCredits = Number(usage.bankedResetCredits);
  const openai =
    isRecord(usage.openai) &&
    usage.openai.version === 1 &&
    isRecord(usage.openai.rateLimits) &&
    Array.isArray(usage.openai.rateLimits.observations) &&
    isRecord(usage.openai.admin) &&
    isRecord(usage.openai.creditBalance)
      ? (usage.openai as unknown as OpenAIUsageReport)
      : undefined;
  return {
    quotas: isRecord(usage.quotas) ? usage.quotas : null,
    ...(isRecord(usage.modelQuotas) ? { modelQuotas: usage.modelQuotas } : {}),
    plan: usage.plan ?? null,
    message: typeof usage.message === "string" ? usage.message : null,
    fetchedAt,
    source,
    bankedResetCredits: Number.isFinite(bankedResetCredits) ? bankedResetCredits : undefined,
    paidCredits: parseCodexPaidCredits(usage.paidCredits),
    billing: sanitizeProviderBillingStatus(usage.billing),
    ...(openai ? { openai } : {}),
    quotaGroups: Array.isArray(usage.quotaGroups)
      ? (usage.quotaGroups as Array<Record<string, unknown>>)
      : undefined,
  };
}

export function mergeProviderLimitsCacheEntry(
  provider: string,
  next: ProviderLimitsCacheEntry,
  previous: ProviderLimitsCacheEntry | null | undefined
): ProviderLimitsCacheEntry {
  if (!previous) return next;

  // After restart there may be no in-process response observation yet. Retain
  // only the previous passive snapshot, explicitly stale; Admin data belongs
  // to the newly selected credential/scope/period and must never cross over.
  if (
    provider === "openai" &&
    next.openai &&
    next.openai.rateLimits.observations.length === 0 &&
    previous.openai?.rateLimits.observations.length
  ) {
    return {
      ...next,
      openai: {
        ...next.openai,
        rateLimits: ageOpenAIRateLimitObservations(previous.openai.rateLimits, {
          forceStale: true,
        }),
      },
    };
  }

  if (!next.quotas && next.message && hasUsableCachedData(previous)) {
    return previous;
  }

  // A GLM quota refresh omits `bankedResetCredits` when the auxiliary reset-card
  // list request failed (fetchGlmResetCardCount → null). That "unknown" must not
  // erase a previously known count; an explicit number (including an
  // authoritative 0) always wins.
  if (
    GLM_RESET_CARD_PROVIDERS.has(provider) &&
    next.bankedResetCredits === undefined &&
    previous.bankedResetCredits !== undefined
  ) {
    return { ...next, bankedResetCredits: previous.bankedResetCredits };
  }

  if (provider !== GROK_CLI_PROVIDER) return next;

  const nextBilling = next.billing;
  const previousBilling = previous.billing;
  if (
    !nextBilling ||
    nextBilling.additionalCreditsUrl !== GROK_BUILD_ADDITIONAL_CREDITS_URL ||
    nextBilling.autoTopUp.available ||
    !previousBilling ||
    previousBilling.additionalCreditsUrl !== GROK_BUILD_ADDITIONAL_CREDITS_URL
  )
    return next;

  return {
    ...next,
    billing: {
      ...nextBilling,
      autoTopUp: previousBilling.autoTopUp,
    },
  };
}
