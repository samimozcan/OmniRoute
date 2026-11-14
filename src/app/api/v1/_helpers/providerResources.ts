import { z } from "zod";
import {
  handleProviderResourceRequest,
  readProviderResourceCacheBody,
  ResourceTransportError,
  type ProviderResourceOperation,
} from "@omniroute/open-sse/handlers/providerResources";
import { buildErrorBody } from "@omniroute/open-sse/utils/error";
import { runWithProxyContext } from "@omniroute/open-sse/utils/proxyFetch";
import {
  canonicalProviderResourceId,
  saveProviderResourceBinding,
  getProviderResourceBinding,
  deleteProviderResourceBinding,
  type ProviderResourceBinding,
} from "@/lib/db/providerResources";
import { resolveProxyForConnection } from "@/lib/db/settings";
import { hasBlockingProxyAssignment } from "@/lib/db/proxies";
import { getApiKeyMetadata, isModelAllowedForKey } from "@/lib/db/apiKeys";
import { enforceClientApiRouteAuth } from "@/shared/utils/clientApiRouteAuth";
import { enforceApiKeyPolicy } from "@/shared/utils/apiKeyPolicy";
import { CORS_HEADERS, credentialRejectionHeaders } from "@/shared/utils/cors";
import {
  parseProviderRoutingHeaders,
  resolveProviderRoutingSelection,
  providerRoutingResponseHeaders,
  ProviderRoutingError,
  type ResolvedProviderRouting,
} from "@/sse/services/providerResourceRouting";
import { assertProviderResourceOwnership } from "@/sse/services/providerResourceOwnership";
import {
  getApiKeyRequestScope,
  canAccessOwnedRecord,
  resolveEffectiveApiKeyId,
  resolveListScope,
  type ApiKeyRequestScope,
} from "./apiKeyScope";

const objectSchema = z.record(z.string(), z.unknown());
const modelSchema = z
  .string()
  .regex(/^models\/[A-Za-z0-9_.-]+$/)
  .max(200);

function fail(status: number, message: string, route?: ResolvedProviderRouting): Response {
  return Response.json(buildErrorBody(status, message), {
    status,
    headers: { ...CORS_HEADERS, ...(route ? providerRoutingResponseHeaders(route) : {}) },
  });
}

function record(value: unknown): Record<string, unknown> {
  const parsed = objectSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

function normalizeId(
  route: ResolvedProviderRouting,
  operation: ProviderResourceOperation
): string | undefined {
  if (operation.id === undefined) return undefined;
  try {
    return canonicalProviderResourceId(route.provider, operation.kind, operation.id);
  } catch {
    throw new ProviderRoutingError(400, "Invalid provider resource identifier");
  }
}

function withRouteHeaders(response: Response, route: ResolvedProviderRouting): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries({
    ...CORS_HEADERS,
    ...providerRoutingResponseHeaders(route),
  })) {
    headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function resourceMetadata(
  payload: unknown,
  route: ResolvedProviderRouting,
  kind: "file" | "cache"
) {
  const outer = record(payload);
  return kind === "file" && route.provider === "gemini" ? record(outer.file ?? outer) : outer;
}

function owned(
  scope: ApiKeyRequestScope,
  binding: ProviderResourceBinding | null
): binding is ProviderResourceBinding {
  return Boolean(binding && canAccessOwnedRecord(scope, binding.apiKeyId));
}

async function filteredList(
  response: Response,
  route: ResolvedProviderRouting,
  operation: ProviderResourceOperation,
  scope: ApiKeyRequestScope,
  request: Request,
  loadPage: (request: Request) => Promise<Response>
): Promise<Response> {
  let payload = record(await response.json());
  const field =
    operation.kind === "cache" ? "cachedContents" : route.provider === "gemini" ? "files" : "data";
  const visibleValues = (page: Record<string, unknown>) => {
    const values = Array.isArray(page[field]) ? page[field] : [];
    return values.filter((value) => {
      const metadata = record(value);
      const resourceId = route.provider === "openai" ? metadata.id : metadata.name;
      if (typeof resourceId !== "string") return false;
      try {
        return owned(
          scope,
          getProviderResourceBinding(route.provider, route.connectionId, operation.kind, resourceId)
        );
      } catch {
        return false;
      }
    });
  };
  let visible = visibleValues(payload);
  const cursors = new Set<string>();
  // OpenAI only exposes item IDs as cursors. Cross hidden pages internally so
  // callers never receive a foreign ID or an empty page with no usable cursor.
  while (route.provider === "openai" && visible.length === 0 && payload.has_more === true) {
    const cursor = payload.last_id;
    if (typeof cursor !== "string" || cursors.has(cursor) || cursors.size >= 25)
      throw new ProviderRoutingError(502, "Provider file listing could not advance safely");
    cursors.add(cursor);
    const url = new URL(request.url);
    url.searchParams.set("after", cursor);
    response = await loadPage(
      new Request(url, { headers: request.headers, signal: request.signal })
    );
    if (!response.ok) return response;
    payload = record(await response.json());
    visible = visibleValues(payload);
  }
  // Upstream lists can include resources created outside this gateway or by
  // another caller. Never return those objects or upstream aggregate counts.
  const result =
    route.provider === "openai"
      ? {
          object: "list",
          data: visible,
          first_id: record(visible[0]).id ?? null,
          last_id: record(visible.at(-1)).id ?? null,
          has_more: payload.has_more === true,
        }
      : {
          [field]: visible,
          ...(typeof payload.nextPageToken === "string"
            ? { nextPageToken: payload.nextPageToken }
            : {}),
        };
  return Response.json(result, { status: response.status, headers: response.headers });
}

/** Null means a file request without new selectors; its original route continues. */
export async function tryHandleProviderResourceRequest(
  request: Request,
  operation: ProviderResourceOperation
): Promise<Response | null> {
  let route: ResolvedProviderRouting | undefined;
  try {
    const selection = parseProviderRoutingHeaders(request.headers);
    if (!selection) {
      return operation.kind === "file"
        ? null
        : fail(400, "X-OmniRoute-Provider is required for cachedContents");
    }
    const authentication = await enforceClientApiRouteAuth(request);
    if (authentication) return authentication;
    const scope = await getApiKeyRequestScope(request);
    if (scope.rejection) return scope.rejection;
    if (scope.apiKey && !scope.apiKeyId) {
      return Response.json(buildErrorBody(401, "Invalid API key"), {
        status: 401,
        headers: credentialRejectionHeaders(request),
      });
    }
    let json: Record<string, unknown> | undefined;
    let upstreamRequest = request;
    let model: string | null = null;
    if (operation.kind === "cache" && ["POST", "PATCH"].includes(request.method)) {
      json = await readProviderResourceCacheBody(request);
      const headers = new Headers(request.headers);
      headers.delete("content-length");
      upstreamRequest = new Request(request.url, {
        method: request.method,
        headers,
        signal: request.signal,
        body: JSON.stringify(json),
      });
    }
    if (json && request.method === "POST") {
      const parsedModel = modelSchema.safeParse(json.model);
      if (!parsedModel.success) return fail(400, "Cache model must use models/<model> format");
      model = `${selection.provider}/${parsedModel.data.slice("models/".length)}`;
    }
    const policy = await enforceApiKeyPolicy(request, model);
    if (policy.rejection) return policy.rejection;
    // Preserve alternate x-api-key/x-goog-api-key ownership and management scope.
    const effectiveScope: ApiKeyRequestScope = {
      ...scope,
      apiKeyId: resolveEffectiveApiKeyId(scope, policy.apiKeyInfo),
      apiKeyMetadata:
        scope.apiKeyMetadata ?? (policy.apiKey ? await getApiKeyMetadata(policy.apiKey) : null),
    };
    route = await resolveProviderRoutingSelection(selection, policy.apiKeyInfo);
    if (operation.kind === "cache" && route.provider !== "gemini") {
      return fail(
        400,
        "OpenAI prompt caching uses inference requests; standalone cachedContents is supported only for Gemini",
        route
      );
    }
    const id = normalizeId(route, operation);
    const normalizedOperation = { ...operation, ...(id ? { id } : {}) };
    let binding: ProviderResourceBinding | null = null;
    if (id) {
      binding = getProviderResourceBinding(route.provider, route.connectionId, operation.kind, id);
      if (!owned(effectiveScope, binding)) return fail(404, "Provider resource not found", route);
      if (
        operation.kind === "cache" &&
        typeof binding.metadata.model === "string" &&
        policy.apiKey
      ) {
        const boundModel = `${route.provider}/${binding.metadata.model.replace(/^models\//, "")}`;
        if (!(await isModelAllowedForKey(policy.apiKey, boundModel))) {
          return fail(403, "Cache model is not allowed for this API key", route);
        }
      }
    } else if (request.method === "GET") {
      const listScope = resolveListScope(scope, policy, request);
      if (listScope.mode === "rejected") return listScope.response;
    }
    if (json) await assertProviderResourceOwnership(request, json, route, policy.apiKeyInfo);

    const proxyInfo = await resolveProxyForConnection(
      route.connectionId,
      policy.apiKeyInfo?.id,
      route.provider
    );
    if (!proxyInfo?.proxy && hasBlockingProxyAssignment(route.connectionId, route.provider)) {
      return fail(503, "The selected provider connection's assigned proxy is unavailable", route);
    }
    if (request.method === "GET" && !id) {
      // One total deadline covers a hidden-page scan, not a new timeout per page.
      upstreamRequest = new Request(upstreamRequest, {
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(120_000)]),
      });
    }
    const sendRequest = (outgoing: Request) =>
      runWithProxyContext(proxyInfo?.proxy ?? null, () =>
        handleProviderResourceRequest(outgoing, route!, normalizedOperation)
      ) as Promise<Response>;
    let response = await sendRequest(upstreamRequest);
    if (!response.ok) return withRouteHeaders(response, route);

    if (request.method === "GET" && !id) {
      response = await filteredList(
        response,
        route,
        operation,
        effectiveScope,
        upstreamRequest,
        sendRequest
      );
    } else if (request.method === "DELETE" && id) {
      deleteProviderResourceBinding(route.provider, route.connectionId, operation.kind, id);
    } else if (!operation.content && request.method !== "DELETE") {
      const metadata = resourceMetadata(await response.clone().json(), route, operation.kind);
      const nativeId = route.provider === "openai" ? metadata.id : metadata.name;
      if (typeof nativeId !== "string")
        return fail(502, "Provider returned no resource identifier", route);
      const resourceId = canonicalProviderResourceId(route.provider, operation.kind, nativeId);
      if (id && id !== resourceId)
        return fail(502, "Provider returned a different resource identifier", route);
      saveProviderResourceBinding({
        provider: route.provider,
        connectionId: route.connectionId,
        kind: operation.kind,
        resourceId,
        apiKeyId: binding ? binding.apiKeyId : effectiveScope.apiKeyId,
        metadata,
      });
    }
    return withRouteHeaders(response, route);
  } catch (error) {
    if (error instanceof ProviderRoutingError || error instanceof ResourceTransportError)
      return fail(error.status, error.message, route);
    // A failed persistence/transport boundary must not claim a successful upload
    // or echo provider credentials, proxy URLs, file bytes or raw exceptions.
    return fail(502, "Provider resource request could not be completed", route);
  }
}
