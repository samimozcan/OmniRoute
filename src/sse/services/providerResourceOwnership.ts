import {
  canAccessOwnedRecord,
  getApiKeyRequestScope,
  resolveEffectiveApiKeyId,
} from "@/app/api/v1/_helpers/apiKeyScope";
import {
  canonicalProviderResourceId,
  getProviderResourceBinding,
  type ProviderResourceKind,
  type ProviderResourceProvider,
} from "@/lib/db/providerResources";
import { ProviderRoutingError, type ResolvedProviderRouting } from "./providerResourceRouting";

export interface ProviderResourceReference {
  provider: ProviderResourceProvider;
  kind: ProviderResourceKind;
  resourceId: string;
}

const MAX_RESOURCE_REFERENCE_NODES = 20_000;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function normalizeProviderResourceId(
  provider: ProviderResourceProvider,
  kind: ProviderResourceKind,
  resourceId: string
): string {
  try {
    return canonicalProviderResourceId(provider, kind, resourceId);
  } catch {
    throw new ProviderRoutingError(400, "Invalid provider resource identifier.");
  }
}

/**
 * Inspect direct native file/cache attachments. Replayed output citations and
 * search-result metadata, plus other provider resource namespaces, are outside
 * this registry. Text, image URLs and inline bytes are not resource ids.
 */
export function collectProviderResourceReferences(
  body: Record<string, unknown>
): ProviderResourceReference[] {
  const references = new Map<string, ProviderResourceReference>();
  const add = (provider: ProviderResourceProvider, kind: ProviderResourceKind, value: unknown) => {
    if (value === undefined || value === null) return;
    if (typeof value !== "string") {
      throw new ProviderRoutingError(400, "Invalid provider resource identifier.");
    }
    const resourceId = normalizeProviderResourceId(provider, kind, value);
    references.set(`${provider}:${kind}:${resourceId}`, { provider, kind, resourceId });
  };
  const addOpenAiFileIds = (value: unknown) => {
    if (value === undefined) return;
    if (!Array.isArray(value)) {
      throw new ProviderRoutingError(400, "Invalid provider resource identifier.");
    }
    if (value.length > MAX_RESOURCE_REFERENCE_NODES) {
      throw new ProviderRoutingError(400, "Provider resource request structure is too large.");
    }
    for (const fileId of value) {
      if (typeof fileId !== "string") {
        throw new ProviderRoutingError(400, "Invalid provider resource identifier.");
      }
      add("openai", "file", fileId);
    }
  };

  add("gemini", "cache", body.cachedContent);
  add("gemini", "cache", body.cached_content);
  const google = record(record(body.extra_body)?.google);
  add("gemini", "cache", google?.cached_content);

  const pending: unknown[] = [body];
  const visited = new Set<object>();
  let traversedNodes = 1;
  const enqueueChildren = (values: unknown[]) => {
    traversedNodes += values.length;
    if (traversedNodes > MAX_RESOURCE_REFERENCE_NODES) {
      throw new ProviderRoutingError(400, "Provider resource request structure is too large.");
    }
    for (let index = values.length - 1; index >= 0; index--) {
      if (values[index] !== null && typeof values[index] === "object") pending.push(values[index]);
    }
  };
  while (pending.length > 0) {
    const value = pending.pop();
    if (value === null || typeof value !== "object" || visited.has(value)) continue;
    visited.add(value);
    if (Array.isArray(value)) {
      enqueueChildren(value);
      continue;
    }
    const object = value as Record<string, unknown>;
    // Responses also accepts uploaded Files as images, screenshots, masks and
    // tool-container inputs. Typed carriers keep ordinary metadata and output
    // citation fields from being interpreted as new file inputs.
    if (
      object.type === "input_file" ||
      object.type === "input_image" ||
      object.type === "computer_screenshot"
    ) {
      add("openai", "file", object.file_id);
    }
    if (object.type === "image_generation") {
      add("openai", "file", record(object.input_image_mask)?.file_id);
    }
    if (object.type === "code_interpreter") {
      addOpenAiFileIds(record(object.container)?.file_ids);
    }
    if (object.type === "shell") {
      addOpenAiFileIds(record(object.environment)?.file_ids);
    }
    add("openai", "file", record(object.input_file)?.file_id);
    const chatFileId = record(object.file)?.file_id;
    const chatFileProvider =
      typeof chatFileId === "string" &&
      (chatFileId.startsWith("files/") ||
        chatFileId.startsWith("https://generativelanguage.googleapis.com/"))
        ? "gemini"
        : "openai";
    add(chatFileProvider, "file", chatFileId);
    for (const key of ["fileData", "file_data"]) {
      const fileData = record(object[key]);
      for (const uri of [fileData?.fileUri, fileData?.file_uri]) {
        if (typeof uri === "string" && uri.startsWith("data:")) continue;
        add("gemini", "file", uri);
      }
    }
    enqueueChildren(Object.values(object));
  }
  return [...references.values()];
}

/** Called only after the existing request authentication and API-key policy gates. */
export async function assertProviderResourceOwnership(
  request: Request,
  body: Record<string, unknown>,
  route: ResolvedProviderRouting,
  apiKeyInfo: { id: string; scopes?: string[] } | null
): Promise<void> {
  const references = collectProviderResourceReferences(body);
  if (references.length === 0) return;
  if (references.some((reference) => reference.provider !== route.provider)) {
    throw new ProviderRoutingError(400, "Resource provider does not match the selected provider.");
  }

  const scope = await getApiKeyRequestScope(request);
  if (scope.rejection) {
    throw new ProviderRoutingError(scope.rejection.status, "Request is not authorized.");
  }
  // Keep the raw credential lifecycle gate ahead of policy metadata fallback.
  // A revoked bearer must never recover privileges from a session or stale info.
  if (scope.apiKey && !scope.apiKeyId) {
    throw new ProviderRoutingError(401, "Invalid API key.");
  }
  const ownershipScope = {
    ...scope,
    apiKeyId: resolveEffectiveApiKeyId(scope, apiKeyInfo),
    // The ownership helper reads only scopes from metadata. Policy already
    // validated alternate key transports that the legacy extractor cannot see.
    apiKeyMetadata: (scope.apiKeyMetadata ?? apiKeyInfo) as typeof scope.apiKeyMetadata,
  };
  for (const reference of references) {
    const binding = getProviderResourceBinding(
      route.provider,
      route.connectionId,
      reference.kind,
      reference.resourceId
    );
    if (!binding || !canAccessOwnedRecord(ownershipScope, binding.apiKeyId)) {
      throw new ProviderRoutingError(404, "Provider resource not found.");
    }
  }
}
