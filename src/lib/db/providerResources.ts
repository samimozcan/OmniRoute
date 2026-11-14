import { z } from "zod";
import { getDbInstance } from "./core";

export type ProviderResourceProvider = "openai" | "gemini";
export type ProviderResourceKind = "file" | "cache";

export interface ProviderResourceBinding {
  provider: ProviderResourceProvider;
  connectionId: string;
  kind: ProviderResourceKind;
  resourceId: string;
  apiKeyId: string | null;
  metadata: Record<string, unknown>;
  createdAt: number;
}

const identitySchema = z.object({
  provider: z.enum(["openai", "gemini"]),
  connectionId: z.string().min(1).max(256),
  kind: z.enum(["file", "cache"]),
});
const ownerSchema = z.string().min(1).max(256).nullable();
const optionalString = z.string().max(4096).optional();
const optionalCount = z.number().nonnegative().finite().optional();
const usageMetadataSchema = z.object({
  totalTokenCount: optionalCount,
  cachedContentTokenCount: optionalCount,
  textCount: optionalCount,
  imageCount: optionalCount,
  videoDurationSeconds: optionalCount,
  audioDurationSeconds: optionalCount,
});

// Explicitly project provider metadata. Cache responses may echo contents,
// tools and system instructions; they must not become a second document store.
const metadataSchema = z.object({
  id: optionalString,
  object: optionalString,
  filename: optionalString,
  purpose: optionalString,
  status: optionalString,
  name: optionalString,
  displayName: optionalString,
  display_name: optionalString,
  mimeType: optionalString,
  mime_type: optionalString,
  sizeBytes: z.union([z.string().max(32), z.number().nonnegative().finite()]).optional(),
  bytes: optionalCount,
  created_at: optionalCount,
  expires_at: optionalCount,
  createTime: optionalString,
  updateTime: optionalString,
  expirationTime: optionalString,
  expireTime: optionalString,
  ttl: optionalString,
  uri: optionalString,
  sha256Hash: optionalString,
  model: optionalString,
  state: optionalString,
  usageMetadata: usageMetadataSchema.optional(),
});

/** Accept route short ids, native names and the canonical Gemini file URI. */
export function canonicalProviderResourceId(
  provider: ProviderResourceProvider,
  kind: ProviderResourceKind,
  resourceId: string
): string {
  if (typeof resourceId !== "string") throw new Error("Invalid provider resource identifier.");
  if (provider === "openai") {
    if (kind === "file" && /^file-[A-Za-z0-9_-]{1,256}$/.test(resourceId)) return resourceId;
    throw new Error("Invalid provider resource identifier.");
  }
  if (provider !== "gemini") throw new Error("Invalid provider resource identifier.");
  const prefix = kind === "file" ? "files/" : "cachedContents/";
  const origin = "https://generativelanguage.googleapis.com/v1beta/";
  const isNativeUri = resourceId.startsWith(origin);
  const nativeName = isNativeUri ? resourceId.slice(origin.length) : resourceId;
  if (isNativeUri && !nativeName.startsWith(prefix)) {
    throw new Error("Invalid provider resource identifier.");
  }
  const id = nativeName.startsWith(prefix) ? nativeName.slice(prefix.length) : nativeName;
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(id)) {
    throw new Error("Invalid provider resource identifier.");
  }
  return `${prefix}${id}`;
}

type BindingRow = {
  provider: ProviderResourceProvider;
  connection_id: string;
  kind: ProviderResourceKind;
  resource_id: string;
  api_key_id: string | null;
  metadata: string;
  created_at: number;
};

function bindingFromRow(row: BindingRow): ProviderResourceBinding {
  return {
    provider: row.provider,
    connectionId: row.connection_id,
    kind: row.kind,
    resourceId: row.resource_id,
    apiKeyId: row.api_key_id,
    metadata: metadataSchema.parse(JSON.parse(row.metadata)),
    createdAt: row.created_at,
  };
}

export function saveProviderResourceBinding(
  args: Omit<ProviderResourceBinding, "createdAt">
): ProviderResourceBinding {
  const { provider, connectionId, kind } = identitySchema.parse(args);
  const apiKeyId = ownerSchema.parse(args.apiKeyId);
  const resourceId = canonicalProviderResourceId(provider, kind, args.resourceId);
  const metadata = metadataSchema.parse(args.metadata);
  const createdAt = Math.floor(Date.now() / 1000);
  const result = getDbInstance()
    .prepare(
      `INSERT INTO provider_resources
         (provider, connection_id, kind, resource_id, api_key_id, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (provider, connection_id, kind, resource_id) DO UPDATE
       SET metadata = excluded.metadata
       WHERE provider_resources.api_key_id IS excluded.api_key_id`
    )
    .run(provider, connectionId, kind, resourceId, apiKeyId, JSON.stringify(metadata), createdAt);

  // The conditional upsert makes the owner immutable even across connections
  // to the same SQLite file. A foreign owner cannot replace metadata either.
  if (result.changes !== 1) throw new Error("Provider resource ownership conflict.");
  const binding = getProviderResourceBinding(provider, connectionId, kind, resourceId);
  if (!binding) throw new Error("Provider resource binding could not be saved.");
  return binding;
}

export function getProviderResourceBinding(
  provider: ProviderResourceProvider,
  connectionId: string,
  kind: ProviderResourceKind,
  resourceId: string
): ProviderResourceBinding | null {
  identitySchema.parse({ provider, connectionId, kind });
  const id = canonicalProviderResourceId(provider, kind, resourceId);
  const row = getDbInstance()
    .prepare(
      `SELECT provider, connection_id, kind, resource_id, api_key_id, metadata, created_at
       FROM provider_resources WHERE provider = ? AND connection_id = ? AND kind = ? AND resource_id = ?`
    )
    .get(provider, connectionId, kind, id) as BindingRow | undefined;
  return row ? bindingFromRow(row) : null;
}

export function listProviderResourceBindings(
  provider: ProviderResourceProvider,
  connectionId: string,
  kind: ProviderResourceKind
): ProviderResourceBinding[] {
  identitySchema.parse({ provider, connectionId, kind });
  const rows = getDbInstance()
    .prepare(
      `SELECT provider, connection_id, kind, resource_id, api_key_id, metadata, created_at
       FROM provider_resources WHERE provider = ? AND connection_id = ? AND kind = ?
       ORDER BY created_at DESC, resource_id ASC`
    )
    .all(provider, connectionId, kind) as BindingRow[];
  return rows.map(bindingFromRow);
}

export function deleteProviderResourceBinding(
  provider: ProviderResourceProvider,
  connectionId: string,
  kind: ProviderResourceKind,
  resourceId: string
): boolean {
  identitySchema.parse({ provider, connectionId, kind });
  const id = canonicalProviderResourceId(provider, kind, resourceId);
  const result = getDbInstance()
    .prepare(
      `DELETE FROM provider_resources
       WHERE provider = ? AND connection_id = ? AND kind = ? AND resource_id = ?`
    )
    .run(provider, connectionId, kind, id);
  return result.changes === 1;
}
