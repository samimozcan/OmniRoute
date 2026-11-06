import { toPlainHeaders } from "../rateLimitManager/headers.ts";
import type {
  OpenAIRateLimitObservation,
  OpenAIRateLimitSection,
  OpenAIRateLimitWindow,
} from "./openaiTypes.ts";

// These are observations of shared upstream limits, never routing quotas. Keep
// old values visible as stale instead of guessing that a reset replenished them.
const MAX_CONNECTIONS = 256;
const MAX_OBSERVATIONS_PER_CONNECTION = 32;
const FRESHNESS_MS = 5 * 60_000;
const observations = new Map<string, Map<string, OpenAIRateLimitObservation>>();

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 256) : null;
}

function count(value: string | undefined): number | null {
  if (!value || !/^\d+(?:\.\d+)?$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function resetAt(value: string | undefined, observedAt: number): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  let timestamp: number;
  const duration = raw.match(
    /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?$/
  );
  if (duration) {
    const [, days, hours, minutes, seconds, milliseconds] = duration;
    timestamp =
      observedAt +
      Math.round(
        (Number(days || 0) * 86400 +
          Number(hours || 0) * 3600 +
          Number(minutes || 0) * 60 +
          Number(seconds || 0)) *
          1000 +
          Number(milliseconds || 0)
      );
  } else if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const numeric = Number(raw);
    timestamp =
      numeric >= 1e12 ? numeric : numeric >= 1e9 ? numeric * 1000 : observedAt + numeric * 1000;
  } else {
    timestamp = Date.parse(raw);
  }
  return Number.isFinite(timestamp) && Math.abs(timestamp) <= 8.64e15
    ? new Date(timestamp).toISOString()
    : null;
}

function windowFromHeaders(
  headers: Record<string, string>,
  kind: "requests" | "tokens" | "project-tokens",
  observedAt: number
): OpenAIRateLimitWindow | null {
  const limit = count(headers[`x-ratelimit-limit-${kind}`]);
  const remaining = count(headers[`x-ratelimit-remaining-${kind}`]);
  const reset = resetAt(headers[`x-ratelimit-reset-${kind}`], observedAt);
  if (limit === null && remaining === null && reset === null) return null;
  return {
    limit,
    remaining,
    resetAt: reset,
    observedAt: new Date(observedAt).toISOString(),
    stale: false,
  };
}

function ageWindow(
  window: OpenAIRateLimitWindow | null,
  now: number,
  forceStale: boolean
): OpenAIRateLimitWindow | null {
  if (!window) return null;
  const age = now - Date.parse(window.observedAt);
  const reset = window.resetAt ? Date.parse(window.resetAt) : null;
  return {
    ...window,
    stale:
      forceStale ||
      window.stale ||
      !Number.isFinite(age) ||
      age >= FRESHNESS_MS ||
      (reset !== null && reset <= now),
  };
}

/** Clone a cached section without making old observations look newly fetched. */
export function ageOpenAIRateLimitObservations(
  section: OpenAIRateLimitSection,
  { now = Date.now(), forceStale = false }: { now?: number; forceStale?: boolean } = {}
): OpenAIRateLimitSection {
  return {
    ...section,
    observations: section.observations.map((observation) => ({
      ...observation,
      requests: ageWindow(observation.requests, now, forceStale),
      tokens: ageWindow(observation.tokens, now, forceStale),
      projectTokens: ageWindow(observation.projectTokens, now, forceStale),
    })),
  };
}

/** Capture only allowlisted response headers; no fetch, credentials or DB work. */
export function observeOpenAIRateLimits({
  connectionId,
  model,
  headers,
  status,
  observedAt = Date.now(),
}: {
  connectionId: string;
  model: string | null;
  headers: Headers | Record<string, string>;
  status: number;
  observedAt?: number;
}): void {
  if (
    !connectionId ||
    !headers ||
    !Number.isFinite(observedAt) ||
    Math.abs(observedAt) > 8.64e15 ||
    status < 100 ||
    status > 599
  )
    return;
  const values = toPlainHeaders(headers);
  const requests = windowFromHeaders(values, "requests", observedAt);
  const tokens = windowFromHeaders(values, "tokens", observedAt);
  const projectTokens = windowFromHeaders(values, "project-tokens", observedAt);
  if (!requests && !tokens && !projectTokens) return;
  const observedModel = text(model);
  const organizationId = text(values["openai-organization"]);
  const projectId = text(values["openai-project"]);
  const key = JSON.stringify([observedModel, organizationId, projectId]);
  const current = observations.get(connectionId) ?? new Map<string, OpenAIRateLimitObservation>();
  const previous = current.get(key);
  if (previous && Date.parse(previous.observedAt) > observedAt) return;
  current.delete(key);
  current.set(key, {
    model: observedModel,
    organizationId,
    projectId,
    observedAt: new Date(observedAt).toISOString(),
    requests: requests ?? previous?.requests ?? null,
    tokens: tokens ?? previous?.tokens ?? null,
    projectTokens: projectTokens ?? previous?.projectTokens ?? null,
  });
  while (current.size > MAX_OBSERVATIONS_PER_CONNECTION)
    current.delete(current.keys().next().value!);
  observations.delete(connectionId);
  observations.set(connectionId, current);
  while (observations.size > MAX_CONNECTIONS)
    observations.delete(observations.keys().next().value!);
}

export function getOpenAIRateLimitObservations({
  connectionId,
  now = Date.now(),
}: {
  connectionId: string;
  now?: number;
}): OpenAIRateLimitSection {
  const current = [...(observations.get(connectionId)?.values() ?? [])].sort(
    (left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt)
  );
  return ageOpenAIRateLimitObservations(
    {
      status: current.length ? "observed" : "not_observed",
      observations: current,
      lastObservedAt: current[0]?.observedAt ?? null,
    },
    { now }
  );
}
