import test from "node:test";
import assert from "node:assert/strict";
import { mapProviderSpecificDataSecrets } from "../../src/lib/db/providers/providerSpecificDataSecrets.ts";
import {
  createLazyConnectionView,
  createLazyRowProxy,
} from "../../src/lib/db/providers/lazyConnectionView.ts";
import { decryptConnectionFields, encryptConnectionFields } from "../../src/lib/db/encryption.ts";

// Synthetic legacy envelope: retirement must discard it without trying to decrypt it.
const LEGACY_ADMIN = "enc:v1:retired-admin-iv:retired-admin-ciphertext:retired-admin-tag";
const RETIRED_METADATA = {
  openaiAdminApiKey: LEGACY_ADMIN,
  openaiReportingProjectId: "proj-retired",
  openaiReportingApiKeyId: "key-retired",
  openaiReportingPeriod: "30d",
};
const ACTIVE_METADATA = {
  baseUrl: "https://api.example.test/v1",
  projectId: "proj-inference",
  openaiStoreEnabled: false,
  requestDefaults: { reasoningEffort: "high" },
  tags: ["inference"],
  customProviderData: { count: 2 },
};

test("metadata materialization discards retired reporting fields without mutating the row", () => {
  const metadata = Object.freeze({ ...RETIRED_METADATA, ...ACTIVE_METADATA });
  const stored = Object.freeze({
    id: "legacy-openai",
    provider: "openai",
    apiKey: "sk-synthetic-inference",
    providerSpecificData: metadata,
  });

  for (const view of [createLazyRowProxy(stored), createLazyConnectionView(stored)]) {
    assert.deepEqual(view.providerSpecificData, ACTIVE_METADATA);
    const exportable = JSON.parse(JSON.stringify(view)) as Record<string, unknown>;
    assert.deepEqual(exportable.providerSpecificData, ACTIVE_METADATA);
    assert.equal(exportable.apiKey, "sk-synthetic-inference");
    assert.ok(!JSON.stringify(exportable).includes("retired"));
  }
  assert.equal(stored.providerSpecificData, metadata);
  assert.equal(metadata.openaiAdminApiKey, LEGACY_ADMIN);
});

test("the shared mapper retires only reporting fields while retaining normal secret transforms", () => {
  const input = Object.freeze({
    ...RETIRED_METADATA,
    ...ACTIVE_METADATA,
    consoleApiKey: "console-synthetic",
    extraApiKeys: ["sk-extra-synthetic"],
  });
  const result = mapProviderSpecificDataSecrets(input, (secret) => `mapped:${secret}`);
  assert.deepEqual(result, {
    ...ACTIVE_METADATA,
    consoleApiKey: "mapped:console-synthetic",
    extraApiKeys: ["mapped:sk-extra-synthetic"],
  });
  assert.equal(input.openaiAdminApiKey, LEGACY_ADMIN);
  assert.equal(input.consoleApiKey, "console-synthetic");
  assert.deepEqual(input.extraApiKeys, ["sk-extra-synthetic"]);
});

test("legacy JSON metadata retains its string representation after reporting fields are retired", () => {
  const input = JSON.stringify({ ...RETIRED_METADATA, ...ACTIVE_METADATA });
  const result = mapProviderSpecificDataSecrets(input, (secret) => secret);
  assert.equal(typeof result, "string");
  assert.deepEqual(JSON.parse(result as string), ACTIVE_METADATA);
  assert.equal(JSON.parse(input).openaiAdminApiKey, LEGACY_ADMIN);

  const onlyRetired = mapProviderSpecificDataSecrets(JSON.stringify(RETIRED_METADATA), (s) => s);
  assert.equal(onlyRetired, "{}");
});

test("unrelated metadata and malformed legacy values keep their existing mapper behavior", () => {
  const metadata = Object.freeze({ ...ACTIVE_METADATA });
  assert.equal(
    mapProviderSpecificDataSecrets(metadata, (s) => s),
    metadata
  );
  for (const input of [null, undefined, 3, "invalid-json", "[]", "null", "42"]) {
    assert.equal(
      mapProviderSpecificDataSecrets(input, (s) => s),
      input
    );
  }
  const array = Object.freeze([RETIRED_METADATA]);
  assert.equal(
    mapProviderSpecificDataSecrets(array, (s) => s),
    array
  );
});

for (const encryptionEnabled of [false, true]) {
  test(`connection read/write boundaries retire legacy fields with encryption ${encryptionEnabled ? "enabled" : "disabled"}`, () => {
    const previousKey = process.env.STORAGE_ENCRYPTION_KEY;
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    if (encryptionEnabled) {
      process.env.STORAGE_ENCRYPTION_KEY = "reporting-retirement-synthetic-key";
    } else {
      delete process.env.STORAGE_ENCRYPTION_KEY;
    }

    try {
      for (const field of ["providerSpecificData", "provider_specific_data"]) {
        for (const serialized of [false, true]) {
          const metadata = Object.freeze({ ...RETIRED_METADATA, ...ACTIVE_METADATA });
          const input = serialized ? JSON.stringify(metadata) : metadata;
          const written = encryptConnectionFields({
            apiKey: "sk-synthetic-inference",
            [field]: input,
          });
          const writtenMetadata = written[field];
          assert.deepEqual(
            serialized ? JSON.parse(writtenMetadata as string) : writtenMetadata,
            ACTIVE_METADATA
          );

          const read = decryptConnectionFields({
            apiKey: "sk-synthetic-inference",
            [field]: input,
          });
          const readMetadata = read[field];
          assert.deepEqual(
            serialized ? JSON.parse(readMetadata as string) : readMetadata,
            ACTIVE_METADATA
          );
          assert.equal(read.apiKey, "sk-synthetic-inference");
          assert.equal(metadata.openaiAdminApiKey, LEGACY_ADMIN);
        }
      }
      const persisted = encryptConnectionFields({
        apiKey: "sk-synthetic-inference",
        providerSpecificData: {
          ...RETIRED_METADATA,
          ...ACTIVE_METADATA,
          consoleApiKey: "console-synthetic",
        },
      });
      const restored = decryptConnectionFields(persisted);
      assert.equal(restored.apiKey, "sk-synthetic-inference");
      assert.deepEqual(restored.providerSpecificData, {
        ...ACTIVE_METADATA,
        consoleApiKey: "console-synthetic",
      });
    } finally {
      if (previousKey === undefined) delete process.env.STORAGE_ENCRYPTION_KEY;
      else process.env.STORAGE_ENCRYPTION_KEY = previousKey;
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
  });
}
