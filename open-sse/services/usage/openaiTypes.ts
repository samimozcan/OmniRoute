/** Native OpenAI reporting is descriptive and never a routing quota. */
export type OpenAIReportingPeriod = "month" | "7d" | "30d";

export type OpenAIReportStatus =
  "ready" | "not_configured" | "unavailable" | "unauthorized" | "partial" | "error";

export interface OpenAIReportSection<T> {
  status: OpenAIReportStatus;
  data: T | null;
  fetchedAt: string | null;
  stale?: boolean;
  message?: string;
}

export interface OpenAIRateLimitWindow {
  limit: number | null;
  remaining: number | null;
  resetAt: string | null;
  observedAt: string;
  stale: boolean;
}

export interface OpenAIRateLimitObservation {
  model: string | null;
  organizationId: string | null;
  projectId: string | null;
  observedAt: string;
  requests: OpenAIRateLimitWindow | null;
  tokens: OpenAIRateLimitWindow | null;
  projectTokens: OpenAIRateLimitWindow | null;
}

export interface OpenAIRateLimitSection {
  status: "observed" | "not_observed";
  observations: OpenAIRateLimitObservation[];
  lastObservedAt: string | null;
}

export interface OpenAIReportingScope {
  kind: "organization" | "project" | "api_key";
  projectId: string | null;
  apiKeyId: string | null;
}

export interface OpenAIReportingRange {
  preset: OpenAIReportingPeriod;
  startTime: number;
  endTime: number;
  bucketWidth: "1d";
}

export interface OpenAIUsageTotals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number | null;
}

export interface OpenAIUsageSummary extends OpenAIUsageTotals {
  models: Array<OpenAIUsageTotals & { model: string | null }>;
}

export interface OpenAIMoney {
  value: number;
  currency: string;
}

export interface OpenAICostSummary {
  amounts: OpenAIMoney[];
  items: Array<
    OpenAIMoney & { lineItem: string | null; projectId: string | null; apiKeyId: string | null }
  >;
}

export interface OpenAISpendLimit extends OpenAIMoney {
  interval: string;
  enforcement: string;
}

export interface OpenAISpendAlert extends OpenAIMoney {
  id: string;
  interval: string;
}

export interface OpenAIProjectRateLimit {
  id: string;
  model: string;
  requestsPerMinute: number | null;
  tokensPerMinute: number | null;
  requestsPerDay: number | null;
  imagesPerMinute: number | null;
  audioMegabytesPerMinute: number | null;
  batchInputTokensPerDay: number | null;
}

export interface OpenAIReportingProject {
  id: string;
  name: string;
}

export interface OpenAIReportingApiKey {
  id: string;
  name: string;
  createdAt: number | null;
  lastUsedAt: number | null;
  expiresAt: number | null;
  ownerProjectAccess: string | null;
}

export interface OpenAIAdminReport {
  configured: boolean;
  scope: OpenAIReportingScope;
  period: OpenAIReportingRange;
  usage: OpenAIReportSection<OpenAIUsageSummary>;
  costs: OpenAIReportSection<OpenAICostSummary>;
  organizationSpendLimit: OpenAIReportSection<OpenAISpendLimit>;
  projectSpendLimit: OpenAIReportSection<OpenAISpendLimit>;
  projectRateLimits: OpenAIReportSection<OpenAIProjectRateLimit[]>;
  organizationAlerts: OpenAIReportSection<OpenAISpendAlert[]>;
  projectAlerts: OpenAIReportSection<OpenAISpendAlert[]>;
  projects: OpenAIReportSection<OpenAIReportingProject[]>;
  apiKeys: OpenAIReportSection<OpenAIReportingApiKey[]>;
}

export interface OpenAIUsageReport {
  version: 1;
  rateLimits: OpenAIRateLimitSection;
  admin: OpenAIAdminReport;
  creditBalance: {
    status: "unavailable";
    billingUrl: string;
  };
}

export interface OpenAIReportingSettings {
  encryptionReady: boolean;
  adminKeyConfigured: boolean;
  projectId: string | null;
  apiKeyId: string | null;
  period: OpenAIReportingPeriod;
}

export interface OpenAIUsageConnection {
  id?: string;
  provider?: string;
  apiKey?: string;
  providerSpecificData?: Record<string, unknown>;
}
