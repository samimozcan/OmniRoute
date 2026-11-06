/**
 * db/jsonMigration/connectionsImport.ts — restores provider connections from a settings
 * JSON backup.
 *
 * Restore rule (same as API keys): a new connection gets every provider_connections
 * column the backup carries (schema defaults for the rest); an existing connection has
 * ONLY the carried columns updated, so columns an older backup lacks (`max_concurrent`,
 * `"group"`, `proxy_enabled`, per-key proxy, quota thresholds, …) keep their value.
 * A null/absent `rateLimitOverrides` also keeps the operator's current overrides.
 *
 * Credentials go through encryptConnectionFields() exactly like createProviderConnection /
 * updateProviderConnection, so with STORAGE_ENCRYPTION_KEY set they are stored as
 * `enc:v1:…` (already-encrypted values are left as they are).
 */

import type { SqliteAdapter } from "../adapters/types";
import { encryptConnectionFields, looksEncrypted } from "../encryption";
import {
  omitOpenAIAdminCredential,
  preserveLocalOpenAIReportingMetadata,
} from "../providers/providerSpecificDataSecrets";
import { mapBackupRecordToColumns, selectExistingRow, upsertColumns } from "./columnUpsert";

type JsonRecord = Record<string, unknown>;

function metadataRecord(value: unknown): JsonRecord {
  if (typeof value === "string") {
    try {
      return metadataRecord(JSON.parse(value) as unknown);
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as JsonRecord) }
    : {};
}

export function importProviderConnectionRecord(
  db: SqliteAdapter,
  columns: string[],
  conn: JsonRecord
) {
  const existing = selectExistingRow(db, "provider_connections", conn.id);
  const local = omitOpenAIAdminCredential(conn);
  if (local.providerSpecificData !== undefined || local.provider_specific_data !== undefined) {
    const current = metadataRecord(existing?.provider_specific_data);
    if (!looksEncrypted(current.openaiAdminApiKey)) delete current.openaiAdminApiKey;
    const metadata = preserveLocalOpenAIReportingMetadata(
      metadataRecord(local.providerSpecificData ?? local.provider_specific_data),
      current
    );
    // Normalize both backup representations before encryption. Admin credentials are
    // never imported; an existing local encrypted credential survives metadata restore.
    local.providerSpecificData = metadata;
    delete local.provider_specific_data;
  }
  const record = encryptConnectionFields(local);
  if (record.rateLimitOverrides == null) delete record.rateLimitOverrides;

  const values = mapBackupRecordToColumns(record, columns);
  if (!existing) {
    const now = new Date().toISOString();
    if (values.auth_type == null) values.auth_type = "oauth";
    if (values.created_at == null) values.created_at = now;
    if (values.updated_at == null) values.updated_at = now;
  }
  upsertColumns(db, "provider_connections", values, existing !== undefined);
}
