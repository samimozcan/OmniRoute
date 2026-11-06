import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { makeManagementSessionRequest } from "../helpers/managementSession.ts";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-openai-reporting-route-"));
process.env.DATA_DIR = dataDir;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.APP_LOG_TO_FILE = "false";
process.env.JWT_SECRET = "openai-reporting-route-test-jwt";
process.env.INITIAL_PASSWORD = "openai-reporting-test-password";
delete process.env.STORAGE_ENCRYPTION_KEY;

const core = await import("../../src/lib/db/core.ts");
const providers = await import("../../src/lib/db/providers.ts");
const limits = await import("../../src/lib/db/providerLimits.ts");
const routePath = "../../src/app/api/providers/[id]/openai-reporting/route.ts";

async function route() {
  assert.ok(
    fs.existsSync(new URL(routePath, import.meta.url)),
    "OpenAI reporting settings route exists"
  );
  return import(routePath);
}

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function createConnection(provider = "openai") {
  const connection = await providers.createProviderConnection({
    provider,
    authType: "apikey",
    apiKey: `sk-inference-route-${provider}-${Math.random()}`,
  });
  assert.ok(connection?.id);
  return String(connection.id);
}

async function call(method: "GET" | "PUT", id: string, body?: Record<string, unknown>) {
  const request = await makeManagementSessionRequest(
    `http://localhost/api/providers/${id}/openai-reporting`,
    { method, ...(body ? { body } : {}) }
  );
  return (await route())[method](request, { params: Promise.resolve({ id }) });
}

test("reporting settings require management authentication and reject non-OpenAI connections", async () => {
  const id = await createConnection();
  const handlers = await route();
  for (const method of ["GET", "PUT"] as const) {
    const response = await handlers[method](
      new Request(`http://localhost/api/providers/${id}/openai-reporting`, { method }),
      { params: Promise.resolve({ id }) }
    );
    assert.equal(response.status, 401);
  }
  const other = await call("GET", await createConnection("anthropic"));
  assert.equal(other.status, 400);
  assert.equal((await call("GET", "missing")).status, 404);
});

test("reporting settings expose safe setup state and reject a new Admin key without encryption", async () => {
  delete process.env.STORAGE_ENCRYPTION_KEY;
  const id = await createConnection();
  const response = await call("GET", id);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    encryptionReady: false,
    adminKeyConfigured: false,
    projectId: null,
    apiKeyId: null,
    period: "month",
  });
  const saved = await call("PUT", id, { openaiAdminApiKey: "sk-admin-route-no-encryption" });
  assert.equal(saved.status, 400);
  assert.match(await saved.text(), /STORAGE_ENCRYPTION_KEY/);
});

test("reporting edits preserve an omitted secret, clear explicitly, and invalidate the report", async () => {
  process.env.STORAGE_ENCRYPTION_KEY = "openai-reporting-route-encryption-key";
  const id = await createConnection();
  const secret = "sk-admin-route-must-stay-server-only";
  const saved = await call("PUT", id, {
    openaiAdminApiKey: secret,
    openaiReportingProjectId: "proj_1",
    openaiReportingApiKeyId: "key_1",
    openaiReportingPeriod: "7d",
  });
  assert.equal(saved.status, 200);
  const body = await saved.json();
  assert.deepEqual(body, {
    encryptionReady: true,
    adminKeyConfigured: true,
    projectId: "proj_1",
    apiKeyId: "key_1",
    period: "7d",
  });
  assert.ok(!JSON.stringify(body).includes(secret));
  limits.setProviderLimitsCache(id, {
    quotas: {},
    plan: null,
    message: null,
    fetchedAt: new Date().toISOString(),
  });
  const changed = await call("PUT", id, { openaiReportingPeriod: "30d" });
  assert.equal(changed.status, 200);
  assert.equal(limits.getProviderLimitsCache(id), null);
  const loaded = await providers.getProviderConnectionById(id);
  assert.equal(loaded?.providerSpecificData?.openaiAdminApiKey, secret);
  assert.equal((await changed.json()).adminKeyConfigured, true);
  delete process.env.STORAGE_ENCRYPTION_KEY;
  const unencryptedEdit = await call("PUT", id, { openaiReportingPeriod: "month" });
  assert.equal(unencryptedEdit.status, 200, "an omitted stored secret does not block scope edits");
  const cleared = await call("PUT", id, { clearAdminKey: true });
  assert.equal(cleared.status, 200);
  assert.equal((await cleared.json()).adminKeyConfigured, false);
});

test("reporting settings reject malformed periods, credential envelopes, and ambiguous clearing", async () => {
  const id = await createConnection();
  for (const body of [
    { openaiReportingPeriod: "year" },
    { openaiAdminApiKey: "enc:v1:already-encrypted" },
    { openaiAdminApiKey: "sk-new", clearAdminKey: true },
    { openaiReportingProjectId: ["proj_1"] },
    { openaiReportingApiKeyId: "key_without_project" },
    { openaiAdminApiKey: "" },
  ]) {
    assert.equal((await call("PUT", id, body)).status, 400);
  }
});
