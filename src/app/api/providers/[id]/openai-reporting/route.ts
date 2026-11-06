import { NextResponse } from "next/server";
import { buildErrorBody } from "@omniroute/open-sse/utils/error";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getProviderConnectionById, mergeConnectionProviderSpecificData } from "@/lib/db/providers";
import { assertOpenAIAdminKeyStorageReady } from "@/lib/db/encryption";
import { deleteProviderLimitsCache } from "@/lib/db/providerLimits";
import { getAuditRequestContext, logAuditEvent } from "@/lib/compliance/index";
import { getOpenAIReportingSettings } from "@/lib/providers/openaiReportingSettings";
import { openaiReportingSettingsSchema } from "@/shared/validation/openaiReporting";
import { validatedJsonBody } from "@/shared/validation/helpers";

export const dynamic = "force-dynamic";
type RouteParams = { params: Promise<{ id: string }> };

function errorResponse(status: number, message: string): Response {
  return NextResponse.json(buildErrorBody(status, message), { status });
}

export async function GET(request: Request, { params }: RouteParams): Promise<Response> {
  const authError = await requireManagementAuth(request, { alwaysRequireAuth: true });
  if (authError) return authError;
  try {
    const { id } = await params;
    const connection = await getProviderConnectionById(id);
    if (!connection) return errorResponse(404, "Connection not found");
    if (connection.provider !== "openai") {
      return errorResponse(400, "Native OpenAI reporting is only available for OpenAI connections");
    }
    return NextResponse.json(getOpenAIReportingSettings(connection.providerSpecificData));
  } catch {
    return errorResponse(500, "Failed to load OpenAI reporting settings");
  }
}

export async function PUT(request: Request, { params }: RouteParams): Promise<Response> {
  const authError = await requireManagementAuth(request, { alwaysRequireAuth: true });
  if (authError) return authError;
  const parsed = await validatedJsonBody(request, openaiReportingSettingsSchema);
  if (!parsed.success) return parsed.response;
  try {
    assertOpenAIAdminKeyStorageReady(parsed.data);
  } catch {
    return errorResponse(400, "Set STORAGE_ENCRYPTION_KEY before storing an OpenAI Admin API key");
  }
  try {
    const { id } = await params;
    const connection = await getProviderConnectionById(id);
    if (!connection) return errorResponse(404, "Connection not found");
    if (connection.provider !== "openai") {
      return errorResponse(400, "Native OpenAI reporting is only available for OpenAI connections");
    }
    const existing =
      connection.providerSpecificData && typeof connection.providerSpecificData === "object"
        ? (connection.providerSpecificData as Record<string, unknown>)
        : {};
    const { clearAdminKey, ...fields } = parsed.data;
    const patch: Record<string, unknown> = { ...fields };
    if (clearAdminKey) patch.openaiAdminApiKey = null;
    // A key selection belongs to one explicit project. Changing project invalidates
    // the prior key selection unless the caller supplies a replacement explicitly.
    if (
      fields.openaiReportingProjectId !== undefined &&
      fields.openaiReportingProjectId !== existing.openaiReportingProjectId &&
      fields.openaiReportingApiKeyId === undefined
    ) {
      patch.openaiReportingApiKeyId = null;
    }
    const next = { ...existing, ...patch };
    if (next.openaiReportingApiKeyId && !next.openaiReportingProjectId) {
      return errorResponse(400, "Select a reporting project before selecting an API key ID");
    }
    await mergeConnectionProviderSpecificData(id, patch);
    const updated = await getProviderConnectionById(id);
    if (!updated) return errorResponse(404, "Connection not found");
    deleteProviderLimitsCache(id);
    const safe = getOpenAIReportingSettings(updated.providerSpecificData);
    const auditContext = getAuditRequestContext(request);
    logAuditEvent({
      action: "provider.openai_reporting.updated",
      target: id,
      metadata: {
        ...safe,
        adminKeyChanged: clearAdminKey === true || fields.openaiAdminApiKey !== undefined,
      },
      ipAddress: auditContext.ipAddress ?? undefined,
      requestId: auditContext.requestId,
    });
    return NextResponse.json(safe);
  } catch {
    return errorResponse(500, "Failed to save OpenAI reporting settings");
  }
}
