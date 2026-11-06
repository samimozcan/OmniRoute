import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-openai-reporting-security-"));
const previous = {
  DATA_DIR: process.env.DATA_DIR,
  STORAGE_ENCRYPTION_KEY: process.env.STORAGE_ENCRYPTION_KEY,
};
process.env.DATA_DIR = dataDir;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.APP_LOG_TO_FILE = "false";
delete process.env.STORAGE_ENCRYPTION_KEY;

const core = await import("../../src/lib/db/core.ts");
const providers = await import("../../src/lib/db/providers.ts");
const { sanitizeProviderSpecificDataForResponse } =
  await import("../../src/lib/providers/requestDefaults.ts");
const { summarizeProviderConnectionForAudit } =
  await import("../../src/lib/compliance/providerAudit.ts");
const { resolveExecutionCredentials } =
  await import("../../open-sse/handlers/chatCore/executionCredentials.ts");
const { encrypt, decryptConnectionFields } = await import("../../src/lib/db/encryption.ts");
const { updateProviderConnectionSchema } =
  await import("../../src/shared/validation/schemas/provider.ts");

const adminKey = "sk-admin-boundary-secret-18837";

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("OpenAI Admin keys cannot enter SQLite through create or update without encryption", async () => {
  delete process.env.STORAGE_ENCRYPTION_KEY;
  await assert.rejects(
    providers.createProviderConnection({
      provider: "openai",
      apiKey: "sk-inference-plaintext-create",
      authType: "apikey",
      providerSpecificData: { openaiAdminApiKey: adminKey },
    }),
    /STORAGE_ENCRYPTION_KEY/
  );
  const connection = await providers.createProviderConnection({
    provider: "openai",
    apiKey: "sk-inference-plaintext-update",
    authType: "apikey",
  });
  assert.ok(connection?.id);
  await assert.rejects(
    providers.mergeConnectionProviderSpecificData(String(connection.id), {
      openaiAdminApiKey: adminKey,
    }),
    /STORAGE_ENCRYPTION_KEY/
  );
  await assert.rejects(
    providers.updateProviderConnection(String(connection.id), {
      providerSpecificData: { openaiAdminApiKey: adminKey },
    }),
    /STORAGE_ENCRYPTION_KEY/
  );
  const stored = core.getDbInstance().prepare("SELECT * FROM provider_connections").all();
  assert.ok(!JSON.stringify(stored).includes(adminKey));
  const renamed = await providers.updateProviderConnection(String(connection.id), {
    name: "Inference still editable",
    providerSpecificData: { openaiAdminApiKey: null },
  });
  assert.equal(renamed?.name, "Inference still editable");
});

test("OpenAI Admin keys are encrypted on disk and preserved by unrelated updates", async () => {
  process.env.STORAGE_ENCRYPTION_KEY = "openai-reporting-security-test-encryption-key";
  const connection = await providers.createProviderConnection({
    provider: "openai",
    apiKey: "sk-inference-encrypted",
    authType: "apikey",
    providerSpecificData: { openaiAdminApiKey: adminKey, openaiReportingProjectId: "proj_1" },
  });
  assert.ok(connection?.id);
  const row = core
    .getDbInstance()
    .prepare("SELECT provider_specific_data FROM provider_connections WHERE id = ?")
    .get(connection.id) as { provider_specific_data: string };
  assert.ok(!row.provider_specific_data.includes(adminKey));
  assert.match(JSON.parse(row.provider_specific_data).openaiAdminApiKey, /^enc:v1:/);
  const loaded = await providers.getProviderConnectionById(String(connection.id));
  assert.equal(loaded?.providerSpecificData?.openaiAdminApiKey, adminKey);
  const updated = await providers.updateProviderConnection(String(connection.id), {
    name: "Renamed",
  });
  assert.equal(updated?.providerSpecificData?.openaiAdminApiKey, adminKey);
});

test("OpenAI Admin keys are never exposed by response reveal mode or provider audit summaries", () => {
  const providerSpecificData = { openaiAdminApiKey: adminKey, openaiReportingProjectId: "proj_1" };
  for (const revealKeys of [false, true]) {
    const result = sanitizeProviderSpecificDataForResponse(providerSpecificData, { revealKeys });
    assert.equal(result?.openaiAdminApiKey, undefined);
    assert.equal(result?.openaiReportingProjectId, "proj_1");
  }
  const audit = summarizeProviderConnectionForAudit({
    provider: "openai",
    providerSpecificData,
  });
  assert.ok(!JSON.stringify(audit).includes(adminKey));
});

test("inference credentials exclude the Admin key even with a custom upstream URL", () => {
  const credentials = {
    apiKey: "sk-inference-only",
    providerSpecificData: {
      baseUrl: "https://custom.example.test/v1",
      openaiAdminApiKey: adminKey,
      openaiReportingProjectId: "proj_1",
    },
  };
  const resolved = resolveExecutionCredentials({
    credentials,
    nativeCodexPassthrough: false,
    endpointPath: "/v1/chat/completions",
    targetFormat: "openai",
    provider: "openai",
    ccSessionId: null,
  });
  assert.equal(resolved.apiKey, "sk-inference-only");
  assert.equal(resolved.providerSpecificData.baseUrl, "https://custom.example.test/v1");
  assert.equal(resolved.providerSpecificData.openaiAdminApiKey, undefined);
  assert.equal(credentials.providerSpecificData.openaiAdminApiKey, adminKey);
});

test("an unreadable reporting Admin credential does not invalidate the inference credential", () => {
  process.env.STORAGE_ENCRYPTION_KEY = "openai-reporting-security-test-encryption-key";
  const result = decryptConnectionFields({
    id: "openai-admin-unreadable",
    provider: "openai",
    apiKey: encrypt("sk-inference-valid"),
    providerSpecificData: { openaiAdminApiKey: "enc:v1:invalid-admin-envelope" },
  });
  assert.equal(result.apiKey, "sk-inference-valid");
  assert.equal(result.providerSpecificData.openaiAdminApiKey, null);
  assert.notEqual((result as Record<string, unknown>).credentialDecryptFailed, true);
});

test("generic provider updates validate OpenAI reporting fields before persistence", () => {
  for (const providerSpecificData of [
    { openaiAdminApiKey: [adminKey] },
    { openaiAdminApiKey: "enc:v1:opaque" },
    { openaiReportingProjectId: 123 },
    { openaiReportingApiKeyId: { id: "key_1" } },
    { openaiReportingPeriod: "year" },
    { openaiReportingProjectId: "proj/invalid" },
    { openaiReportingApiKeyId: "x".repeat(201) },
    { openaiAdminApiKey: "sk-admin\r\ninvalid" },
    { openaiAdminApiKey: "x".repeat(4097) },
  ]) {
    assert.equal(updateProviderConnectionSchema.safeParse({ providerSpecificData }).success, false);
  }
});

test("direct persistence rejects a newly supplied Admin credential disguised as ciphertext", async () => {
  process.env.STORAGE_ENCRYPTION_KEY = "openai-reporting-security-test-encryption-key";
  await assert.rejects(
    providers.createProviderConnection({
      provider: "openai",
      authType: "apikey",
      apiKey: "sk-new-admin-envelope",
      providerSpecificData: { openaiAdminApiKey: "enc:v1:fake-plaintext-envelope" },
    }),
    /plaintext OpenAI Admin API key/
  );
});
