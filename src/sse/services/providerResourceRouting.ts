import { z } from "zod";
import { getProviderConnections } from "@/lib/db/providers";
import {
  resolveKeyConnectionScope,
  type KeyScopeApiKeyInfo,
} from "@/sse/services/keyConnectionScope";

export type ResourceProvider = "openai" | "gemini";

export class ProviderRoutingError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "ProviderRoutingError";
  }
}

export interface ProviderRoutingSelection {
  provider: ResourceProvider;
  keyIndex: number;
  explicitIndex: boolean;
  connectionId: string | null;
}

export interface ResolvedProviderRouting {
  provider: ResourceProvider;
  keyIndex: number;
  connectionId: string;
  apiKey: string;
  providerSpecificData: Record<string, unknown>;
}

export interface ProviderResourceConnection {
  id: string;
  provider?: unknown;
  authType?: unknown;
  priority?: unknown;
  createdAt?: unknown;
  isActive?: unknown;
  apiKey?: unknown;
  testStatus?: unknown;
  rateLimitedUntil?: unknown;
  providerSpecificData?: unknown;
}

const providerSchema = z.enum(["openai", "gemini"]);
const indexSchema = z
  .string()
  .regex(/^\d+$/)
  .transform(Number)
  .pipe(z.number().int().safe().min(0));
const connectionSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_.:-]+$/);

/** Connection-only headers retain their existing inference semantics. */
export function parseProviderRoutingHeaders(headers: Headers): ProviderRoutingSelection | null {
  const rawProvider = headers.get("x-omniroute-provider");
  const rawIndex = headers.get("x-omniroute-key-index");
  if (rawProvider === null) {
    if (rawIndex !== null) {
      throw new ProviderRoutingError(400, "X-OmniRoute-Key-Index requires X-OmniRoute-Provider");
    }
    return null;
  }
  const normalized = rawProvider.trim().toLowerCase();
  const provider = providerSchema.safeParse(normalized === "google" ? "gemini" : normalized);
  if (!provider.success) {
    throw new ProviderRoutingError(
      400,
      "Provider resource routing supports openai or gemini API keys"
    );
  }
  const index = indexSchema.safeParse(rawIndex ?? "0");
  if (!index.success) {
    throw new ProviderRoutingError(400, "X-OmniRoute-Key-Index must be a nonnegative safe integer");
  }
  const rawConnection = headers.get("x-omniroute-connection");
  const connection = rawConnection === null ? null : connectionSchema.safeParse(rawConnection);
  if (connection && !connection.success) {
    throw new ProviderRoutingError(400, "Invalid X-OmniRoute-Connection");
  }
  return {
    provider: provider.data,
    keyIndex: index.data,
    explicitIndex: rawIndex !== null,
    connectionId: connection?.success ? connection.data : null,
  };
}

function priority(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stableText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Never filter health or authorization before applying a configured position. */
export function selectProviderRoutingConnection(
  selection: ProviderRoutingSelection,
  connections: readonly ProviderResourceConnection[],
  allowedConnections: readonly string[] | null = null
): ResolvedProviderRouting {
  const pool = connections
    .filter((row) => row.provider === selection.provider && row.authType === "apikey")
    .sort(
      (a, b) =>
        priority(a.priority) - priority(b.priority) ||
        stableText(a.createdAt).localeCompare(stableText(b.createdAt)) ||
        a.id.localeCompare(b.id)
    );
  const index = selection.connectionId
    ? pool.findIndex((row) => row.id === selection.connectionId)
    : selection.keyIndex;
  const selected = pool[index];
  if (!selected) {
    throw new ProviderRoutingError(
      400,
      "The requested provider API key position or connection does not exist"
    );
  }
  if (selection.connectionId && selection.explicitIndex && selection.keyIndex !== index) {
    throw new ProviderRoutingError(
      400,
      "Provider key index and stable connection select different accounts"
    );
  }
  if (allowedConnections !== null && !allowedConnections.includes(selected.id)) {
    throw new ProviderRoutingError(
      403,
      "The selected provider connection is not allowed for this API key"
    );
  }
  if (
    selected.isActive === false ||
    selected.isActive === 0 ||
    ["banned", "expired", "credits_exhausted"].includes(
      stableText(selected.testStatus).toLowerCase()
    )
  ) {
    throw new ProviderRoutingError(
      503,
      "The selected provider connection is inactive or unavailable"
    );
  }
  if (typeof selected.apiKey !== "string" || !selected.apiKey.trim()) {
    throw new ProviderRoutingError(503, "The selected provider connection has no primary API key");
  }
  const cooldown = Date.parse(stableText(selected.rateLimitedUntil));
  if (Number.isFinite(cooldown) && cooldown > Date.now()) {
    throw new ProviderRoutingError(
      429,
      "The selected provider connection is cooling down; no account fallback is allowed"
    );
  }
  return {
    provider: selection.provider,
    keyIndex: index,
    connectionId: selected.id,
    apiKey: selected.apiKey,
    // Extra-key rotation is disabled only on these request-local credentials.
    providerSpecificData: { ...record(selected.providerSpecificData), extraApiKeys: [] },
  };
}

export async function resolveProviderRoutingSelection(
  selection: ProviderRoutingSelection,
  apiKeyInfo?: KeyScopeApiKeyInfo | null
): Promise<ResolvedProviderRouting> {
  const connections = await getProviderConnections({
    provider: selection.provider,
    authType: "apikey",
  });
  const scope = await resolveKeyConnectionScope(apiKeyInfo);
  if (scope.rejection) {
    throw new ProviderRoutingError(
      403,
      "No provider connections are allowed by this API key's connection or quota scope"
    );
  }
  return selectProviderRoutingConnection(selection, connections, scope.allowedConnections);
}

export function providerRoutingResponseHeaders(
  route: ResolvedProviderRouting
): Record<string, string> {
  return {
    "X-OmniRoute-Provider": route.provider,
    "X-OmniRoute-Key-Index": String(route.keyIndex),
    "X-OmniRoute-Selected-Connection-Id": route.connectionId,
  };
}
