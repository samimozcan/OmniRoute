import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHmac } from "node:crypto";
import { MockAgent, setGlobalDispatcher } from "undici";
import { makeManagementSessionRequest } from "../helpers/managementSession.ts";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openai-reporting-boundaries-"));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = "openai-reporting-boundaries-jwt";
process.env.STORAGE_ENCRYPTION_KEY = "openai-reporting-boundaries-storage";
process.env.APP_LOG_TO_FILE = "false";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.CLOUD_URL = "https://cloud.example.test";
process.env.OMNIROUTE_CLOUD_SYNC_SECRETS = "true";
process.env.OMNIROUTE_CLOUD_SYNC_SECRET = "openai-reporting-signed-sync-test";
const network = new MockAgent();
network.disableNetConnect();
setGlobalDispatcher(network);
globalThis.fetch = async () => Response.json({ data: [] });

const core = await import("../../src/lib/db/core.ts");
const providers = await import("../../src/lib/db/providers.ts");
const settings = await import("../../src/lib/db/settings.ts");
const providerRoute = await import("../../src/app/api/providers/route.ts");
const connectionRoute = await import("../../src/app/api/providers/[id]/route.ts");
const bulkRoute = await import("../../src/app/api/providers/bulk/route.ts");
const exportRoute = await import("../../src/app/api/settings/export-json/route.ts");
const sync = await import("../../src/lib/sync/bundle.ts");
const cloud = await import("../../src/lib/cloudSync.ts");
const { importProviderConnectionRecord } =
  await import("../../src/lib/db/jsonMigration/connectionsImport.ts");
const { getTableColumns } = await import("../../src/lib/db/jsonMigration/columnUpsert.ts");
const { invalidateDbCache } = await import("../../src/lib/db/readCache.ts");
const secret = "sk-admin-must-stay-local-18837";

test.before(async () => {
  await settings.updateSettings({ requireLogin: false, cloudEnabled: false });
});
test.after(async () => {
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  core.resetDbInstance();
  await network.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
function request(url: string, method: string, body: unknown) {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json", "x-skip-model-sync": "true" },
    body: JSON.stringify(body),
  });
}
async function savedConnection(name: string, adminKey = secret) {
  const connection = await providers.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name,
    apiKey: `sk-inference-${name}`,
    providerSpecificData: { openaiAdminApiKey: adminKey, openaiReportingProjectId: "proj_a" },
  });
  assert.ok(connection?.id);
  return String(connection.id);
}

test("JSON export and configuration sync never serialize the server-only Admin key", async () => {
  const id = await savedConnection("export-boundary");
  const exported = await exportRoute.GET(
    await makeManagementSessionRequest("http://localhost/api/settings/export-json")
  );
  assert.equal(exported.status, 200);
  assert.doesNotMatch(await exported.text(), /sk-admin-must-stay-local/);
  const bundle = await sync.buildConfigSyncBundle();
  assert.doesNotMatch(JSON.stringify(bundle), /sk-admin-must-stay-local/);
  assert.doesNotMatch(
    JSON.stringify(sync.toLegacyCloudSyncPayload(bundle)),
    /sk-admin-must-stay-local/
  );
  assert.equal(
    (await providers.getProviderConnectionById(id))?.providerSpecificData?.openaiAdminApiKey,
    secret
  );
});

test("generic provider creation cannot bypass reporting authentication when dashboard login is disabled", async () => {
  const response = await providerRoute.POST(
    request("/api/providers", "POST", {
      provider: "openai",
      name: "anonymous-report-create",
      apiKey: "sk-inference-anonymous-create",
      providerSpecificData: { openaiAdminApiKey: "sk-admin-anonymous-create" },
    })
  );
  assert.equal(response.status, 401);
});

test("generic provider edits protect replacement, explicit clearing and reporting scope independently of open-mode", async () => {
  const id = await savedConnection("anonymous-edit");
  for (const providerSpecificData of [
    { openaiAdminApiKey: "sk-admin-unauthorized-replacement" },
    { openaiAdminApiKey: null },
    { openaiReportingProjectId: "proj_other" },
    { openaiReportingApiKeyId: "key_other" },
    { openaiReportingPeriod: "7d" },
  ]) {
    const response = await connectionRoute.PUT(
      request(`/api/providers/${id}`, "PUT", { providerSpecificData }),
      { params: Promise.resolve({ id }) }
    );
    assert.equal(response.status, 401);
  }
  const ordinary = await connectionRoute.PUT(
    request(`/api/providers/${id}`, "PUT", { name: "ordinary-edit-still-works" }),
    { params: Promise.resolve({ id }) }
  );
  assert.equal(ordinary.status, 200);
  assert.equal(
    (await providers.getProviderConnectionById(id))?.providerSpecificData?.openaiAdminApiKey,
    secret
  );
});

test("bulk provider creation cannot bypass the reporting credential boundary", async () => {
  const response = await bulkRoute.POST(
    request("/api/providers/bulk", "POST", {
      provider: "openai",
      entries: [{ name: "anonymous-bulk", apiKey: "sk-inference-anonymous-bulk" }],
      validateKeys: false,
      providerSpecificData: { openaiAdminApiKey: "sk-admin-anonymous-bulk" },
    })
  );
  assert.equal(response.status, 401);
});

test("backup import cannot install Admin material through camel, snake, JSON-string or fake-ciphertext fields", () => {
  delete process.env.STORAGE_ENCRYPTION_KEY;
  const db = core.getDbInstance();
  const columns = getTableColumns(db, "provider_connections");
  const candidates = [
    { providerSpecificData: { openaiAdminApiKey: "sk-admin-import-plain" } },
    { providerSpecificData: { openaiAdminApiKey: "enc:v1:sk-admin-fake-envelope" } },
    { providerSpecificData: JSON.stringify({ openaiAdminApiKey: "sk-admin-import-string" }) },
    { provider_specific_data: JSON.stringify({ openaiAdminApiKey: "sk-admin-import-snake" }) },
  ];
  for (const [index, fields] of candidates.entries()) {
    const id = `import-reporting-${index}`;
    importProviderConnectionRecord(db, columns, {
      id,
      provider: "openai",
      authType: "apikey",
      ...fields,
    });
    const row = db
      .prepare("SELECT provider_specific_data FROM provider_connections WHERE id = ?")
      .get(id) as { provider_specific_data: string };
    assert.doesNotMatch(String(row.provider_specific_data), /openaiAdminApiKey|sk-admin-/);
  }
});

test("restoring other connection metadata preserves this server's encrypted Admin credential", async () => {
  process.env.STORAGE_ENCRYPTION_KEY = "openai-reporting-boundaries-storage";
  const id = await savedConnection("local-admin-survives-import");
  const db = core.getDbInstance();
  importProviderConnectionRecord(db, getTableColumns(db, "provider_connections"), {
    id,
    providerSpecificData: {
      region: "us",
      openaiAdminApiKey: "sk-admin-foreign-backup",
      openaiReportingProjectId: "proj_foreign",
      openaiReportingPeriod: "7d",
    },
  });
  invalidateDbCache();
  const loaded = await providers.getProviderConnectionById(id);
  assert.equal(loaded?.providerSpecificData?.openaiAdminApiKey, secret);
  assert.equal(loaded?.providerSpecificData?.region, "us");
  assert.equal(loaded?.providerSpecificData?.openaiReportingProjectId, "proj_a");
  assert.equal(loaded?.providerSpecificData?.openaiReportingPeriod, undefined);
});

test("opt-in inbound credential sync preserves all server-local OpenAI reporting settings", async () => {
  process.env.STORAGE_ENCRYPTION_KEY = "openai-reporting-boundaries-storage";
  const id = await savedConnection("cloud-local-admin");
  const original = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    assert.doesNotMatch(String(init?.body), /sk-admin-must-stay-local/);
    const body = JSON.stringify({
      data: {
        providers: {
          [id]: {
            updatedAt: "2028-01-01T00:00:00Z",
            providerSpecificData: {
              region: "eu",
              openaiAdminApiKey: "sk-admin-remote-replacement",
              openaiReportingProjectId: "proj_remote",
              openaiReportingPeriod: "30d",
            },
          },
        },
      },
    });
    return new Response(body, {
      headers: {
        "X-Cloud-Sig": createHmac("sha256", "openai-reporting-signed-sync-test")
          .update(body)
          .digest("hex"),
      },
    });
  };
  try {
    const result = await cloud.syncToCloud("local-fixture", null, { explicitEnable: true });
    assert.equal(result.success, true);
    const loaded = await providers.getProviderConnectionById(id);
    assert.equal(loaded?.providerSpecificData?.openaiAdminApiKey, secret);
    assert.equal(loaded?.providerSpecificData?.openaiReportingProjectId, "proj_a");
    assert.equal(loaded?.providerSpecificData?.openaiReportingPeriod, undefined);
    assert.equal(loaded?.providerSpecificData?.region, "eu");
  } finally {
    globalThis.fetch = original;
  }
});
