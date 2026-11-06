import { isEncryptionEnabled } from "@/lib/db/encryption";
import type { OpenAIReportingSettings } from "@omniroute/open-sse/services/usage/openaiTypes";

export function getOpenAIReportingSettings(providerSpecificData: unknown): OpenAIReportingSettings {
  const data =
    providerSpecificData && typeof providerSpecificData === "object"
      ? (providerSpecificData as Record<string, unknown>)
      : {};
  return {
    encryptionReady: isEncryptionEnabled(),
    adminKeyConfigured:
      typeof data.openaiAdminApiKey === "string" && data.openaiAdminApiKey.trim().length > 0,
    projectId:
      typeof data.openaiReportingProjectId === "string" ? data.openaiReportingProjectId : null,
    apiKeyId:
      typeof data.openaiReportingApiKeyId === "string" ? data.openaiReportingApiKeyId : null,
    period:
      data.openaiReportingPeriod === "7d" || data.openaiReportingPeriod === "30d"
        ? data.openaiReportingPeriod
        : "month",
  };
}
