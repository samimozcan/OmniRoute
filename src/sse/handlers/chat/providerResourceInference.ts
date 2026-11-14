import { z } from "zod";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import { getComboForModel, getCombinedModelAliases } from "@/sse/services/model";
import {
  parseProviderRoutingHeaders,
  resolveProviderRoutingSelection,
  providerRoutingResponseHeaders,
  ProviderRoutingError,
  type ProviderRoutingSelection,
  type ResolvedProviderRouting,
} from "@/sse/services/providerResourceRouting";
import { assertProviderResourceOwnership } from "@/sse/services/providerResourceOwnership";
import type { KeyScopeApiKeyInfo } from "@/sse/services/keyConnectionScope";
import { withSelectedConnectionHeader } from "./selectedConnectionHeader.ts";

const nativeModelSchema = z
  .string()
  .min(1)
  .max(300)
  .regex(/^[A-Za-z0-9_.-]+$/);

function routingError(error: unknown): Response {
  if (error instanceof ProviderRoutingError) return errorResponse(error.status, error.message);
  throw error;
}

export function parseProviderResourceInference(headers: Headers) {
  try {
    return parseProviderRoutingHeaders(headers);
  } catch (error) {
    return routingError(error);
  }
}

/** A provider selector names a native model, never a configured routing alias/combo. */
export async function providerResourceModel(
  selection: ProviderRoutingSelection,
  model: string
): Promise<string | Response> {
  const prefix = `${selection.provider}/`;
  const nativeModel = model.startsWith(prefix) ? model.slice(prefix.length) : model;
  if (!nativeModelSchema.safeParse(nativeModel).success || nativeModel === "auto") {
    return errorResponse(
      400,
      "Provider resource routing requires a native model of the selected provider"
    );
  }
  const aliases = await getCombinedModelAliases();
  if (
    (await getComboForModel(model)) ||
    Object.hasOwn(aliases, model) ||
    Object.hasOwn(aliases, nativeModel)
  ) {
    return errorResponse(400, "Provider resource routing does not support model aliases or combos");
  }
  return `${prefix}${nativeModel}`;
}

type InferenceKey = KeyScopeApiKeyInfo & { id: string; scopes?: string[] };

export async function resolveProviderResourceInference(
  request: Request,
  body: Record<string, unknown>,
  selection: ProviderRoutingSelection,
  apiKeyInfo: InferenceKey | null
): Promise<ResolvedProviderRouting | Response> {
  try {
    const route = await resolveProviderRoutingSelection(selection, apiKeyInfo);
    await assertProviderResourceOwnership(request, body, route, apiKeyInfo);
    return route;
  } catch (error) {
    return routingError(error);
  }
}

export async function validateProviderResourceInference(
  request: Request,
  body: Record<string, unknown>,
  route: ResolvedProviderRouting | null | undefined,
  apiKeyInfo: InferenceKey | null
): Promise<Response | null> {
  if (!route) return null;
  try {
    await assertProviderResourceOwnership(request, body, route, apiKeyInfo);
    return null;
  } catch (error) {
    return routingError(error);
  }
}

/** Keep provider resources on their original native primary key and official endpoint. */
export function providerResourceCredentials<
  T extends { connectionId?: string; providerSpecificData?: unknown },
>(credentials: T, route: ResolvedProviderRouting, sourceFormat: string): T {
  const providerSpecificData = { ...route.providerSpecificData };
  delete providerSpecificData.baseUrl;
  delete providerSpecificData.apiType;
  delete providerSpecificData.targetFormat;
  delete providerSpecificData.selectedKeyId;
  const configured = providerSpecificData.customHeaders;
  const parsed =
    typeof configured === "string"
      ? (() => {
          try {
            return JSON.parse(configured);
          } catch {
            return null;
          }
        })()
      : configured;
  providerSpecificData.customHeaders = Object.fromEntries(
    Object.entries(parsed && typeof parsed === "object" ? parsed : {}).filter(
      ([name, value]) =>
        route.provider === "openai" &&
        ["openai-project", "openai-organization"].includes(name.toLowerCase()) &&
        typeof value === "string" &&
        !/[\r\n]/.test(value)
    )
  );
  providerSpecificData.extraApiKeys = [];
  providerSpecificData._omnirouteProviderResourceRouting = true;
  providerSpecificData._omnirouteNativeResourceResponses =
    route.provider === "openai" && sourceFormat === "openai-responses";
  return {
    ...credentials,
    connectionId: route.connectionId,
    apiKey: route.apiKey,
    accessToken: undefined,
    refreshToken: undefined,
    authType: "apikey",
    providerSpecificData,
  };
}

export function withProviderResourceRoutingHeaders(
  response: Response,
  route: ResolvedProviderRouting | null
): Response {
  if (!route) return response;
  const result = withSelectedConnectionHeader(response, route.connectionId);
  for (const [name, value] of Object.entries(providerRoutingResponseHeaders(route))) {
    result.headers.set(name, value);
  }
  return result;
}
