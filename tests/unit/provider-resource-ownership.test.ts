import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SignJWT } from "jose";
import type { ResolvedProviderRouting } from "../../src/sse/services/providerResourceRouting.ts";

const dataDir = mkdtempSync(join(tmpdir(), "omni-provider-resource-ownership-"));
process.env.DATA_DIR = dataDir;
process.env.API_KEY_SECRET = "provider-resource-ownership-test-secret";
process.env.JWT_SECRET = "provider-resource-ownership-session-test-secret";
process.env.REQUIRE_API_KEY = "false";

const { resetDbInstance } = await import("../../src/lib/db/core.ts");

after(() => {
  resetDbInstance();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("native resource bindings survive a database restart with canonical metadata", async () => {
  const { saveProviderResourceBinding, getProviderResourceBinding } =
    await import("../../src/lib/db/providerResources.ts");
  const binding = saveProviderResourceBinding({
    provider: "gemini",
    connectionId: "persist-connection",
    kind: "file",
    resourceId: "https://generativelanguage.googleapis.com/v1beta/files/persisted-file",
    apiKeyId: "persist-owner",
    metadata: {
      name: "files/persisted-file",
      uri: "https://generativelanguage.googleapis.com/v1beta/files/persisted-file",
      mimeType: "application/pdf",
      state: "ACTIVE",
    },
  });
  assert.equal(binding.resourceId, "files/persisted-file");
  assert.equal(binding.apiKeyId, "persist-owner");
  assert.ok(Number.isSafeInteger(binding.createdAt));
  resetDbInstance();
  assert.deepEqual(
    getProviderResourceBinding("gemini", "persist-connection", "file", "persisted-file"),
    binding
  );
});

test("bindings remain isolated by provider, connection and resource kind", async () => {
  const { saveProviderResourceBinding, getProviderResourceBinding, listProviderResourceBindings } =
    await import("../../src/lib/db/providerResources.ts");
  const fixtures = [
    { provider: "openai", connectionId: "isolation-a", kind: "file", resourceId: "file-shared" },
    { provider: "openai", connectionId: "isolation-b", kind: "file", resourceId: "file-shared" },
    { provider: "gemini", connectionId: "isolation-a", kind: "file", resourceId: "files/shared" },
    {
      provider: "gemini",
      connectionId: "isolation-a",
      kind: "cache",
      resourceId: "cachedContents/shared",
    },
  ] as const;
  for (const [index, fixture] of fixtures.entries()) {
    saveProviderResourceBinding({ ...fixture, apiKeyId: `isolation-owner-${index}`, metadata: {} });
  }
  assert.equal(
    getProviderResourceBinding("openai", "isolation-a", "file", "file-shared")?.apiKeyId,
    "isolation-owner-0"
  );
  assert.equal(
    getProviderResourceBinding("openai", "isolation-b", "file", "file-shared")?.apiKeyId,
    "isolation-owner-1"
  );
  assert.deepEqual(
    listProviderResourceBindings("gemini", "isolation-a", "file").map(
      (binding) => binding.resourceId
    ),
    ["files/shared"]
  );
  assert.deepEqual(
    listProviderResourceBindings("gemini", "isolation-a", "cache").map(
      (binding) => binding.resourceId
    ),
    ["cachedContents/shared"]
  );
  assert.equal(getProviderResourceBinding("gemini", "unregistered", "file", "shared"), null);
});

test("a foreign caller cannot overwrite an existing resource owner or metadata", async () => {
  const { saveProviderResourceBinding, getProviderResourceBinding } =
    await import("../../src/lib/db/providerResources.ts");
  const source = {
    provider: "openai" as const,
    connectionId: "collision-connection",
    kind: "file" as const,
    resourceId: "file-collision",
    apiKeyId: "original-owner",
    metadata: { filename: "original.pdf" },
  };
  const original = saveProviderResourceBinding(source);
  for (const apiKeyId of ["foreign-owner", null]) {
    assert.throws(() =>
      saveProviderResourceBinding({ ...source, apiKeyId, metadata: { filename: "replaced.pdf" } })
    );
    assert.deepEqual(
      getProviderResourceBinding("openai", "collision-connection", "file", "file-collision"),
      original
    );
  }
  const updated = saveProviderResourceBinding({ ...source, metadata: { filename: "updated.pdf" } });
  assert.equal(updated.createdAt, original.createdAt);
  assert.equal(updated.apiKeyId, "original-owner");
  assert.deepEqual(updated.metadata, { filename: "updated.pdf" });
});

test("a null owner cannot be claimed by a later API-key caller", async () => {
  const { saveProviderResourceBinding, getProviderResourceBinding } =
    await import("../../src/lib/db/providerResources.ts");
  const source = {
    provider: "gemini" as const,
    connectionId: "session-connection",
    kind: "cache" as const,
    resourceId: "cachedContents/session-cache",
    apiKeyId: null,
    metadata: { expireTime: "2026-11-14T18:00:00Z" },
  };
  saveProviderResourceBinding(source);
  assert.throws(() => saveProviderResourceBinding({ ...source, apiKeyId: "claiming-owner" }));
  assert.equal(
    getProviderResourceBinding("gemini", "session-connection", "cache", "session-cache")?.apiKeyId,
    null
  );
});

test("the registry stores metadata without caching document contents or credentials", async () => {
  const { saveProviderResourceBinding, getProviderResourceBinding } =
    await import("../../src/lib/db/providerResources.ts");
  saveProviderResourceBinding({
    provider: "gemini",
    connectionId: "metadata-connection",
    kind: "cache",
    resourceId: "cachedContents/metadata-cache",
    apiKeyId: "metadata-owner",
    metadata: {
      name: "cachedContents/metadata-cache",
      model: "models/gemini-fixture",
      expireTime: "2026-11-14T18:00:00Z",
      usageMetadata: { totalTokenCount: 1200 },
      contents: [{ parts: [{ text: "private document contents" }] }],
      systemInstruction: { parts: [{ text: "private prompt" }] },
      apiKey: "fixture-upstream-credential",
      authorization: "Bearer fixture-client-credential",
      content: Buffer.from("private bytes"),
    },
  });
  resetDbInstance();
  assert.deepEqual(
    getProviderResourceBinding("gemini", "metadata-connection", "cache", "metadata-cache")
      ?.metadata,
    {
      name: "cachedContents/metadata-cache",
      model: "models/gemini-fixture",
      expireTime: "2026-11-14T18:00:00Z",
      usageMetadata: { totalTokenCount: 1200 },
    }
  );
});

test("deleting a binding removes only the exact native resource and persists the removal", async () => {
  const { saveProviderResourceBinding, getProviderResourceBinding, deleteProviderResourceBinding } =
    await import("../../src/lib/db/providerResources.ts");
  for (const connectionId of ["delete-a", "delete-b"]) {
    saveProviderResourceBinding({
      provider: "openai",
      connectionId,
      kind: "file",
      resourceId: "file-delete",
      apiKeyId: "delete-owner",
      metadata: {},
    });
  }
  assert.equal(deleteProviderResourceBinding("openai", "delete-a", "file", "file-delete"), true);
  assert.equal(deleteProviderResourceBinding("openai", "delete-a", "file", "file-delete"), false);
  resetDbInstance();
  assert.equal(getProviderResourceBinding("openai", "delete-a", "file", "file-delete"), null);
  assert.equal(
    getProviderResourceBinding("openai", "delete-b", "file", "file-delete")?.apiKeyId,
    "delete-owner"
  );
});

function routing(
  provider: "openai" | "gemini" = "openai",
  connectionId = "inference-connection"
): ResolvedProviderRouting {
  return {
    provider,
    connectionId,
    keyIndex: 0,
    apiKey: "fixture-upstream-key",
    providerSpecificData: {},
  };
}

const request = (headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/v1/responses", { method: "POST", headers });

async function newKey(name: string, scopes: string[] = []) {
  const { createApiKey } = await import("../../src/lib/db/apiKeys.ts");
  return createApiKey(name, "provider-resource-fixture-device", scopes);
}

async function bindFile(resourceId: string, apiKeyId: string | null, route = routing()) {
  const { saveProviderResourceBinding } = await import("../../src/lib/db/providerResources.ts");
  return saveProviderResourceBinding({
    provider: route.provider,
    connectionId: route.connectionId,
    kind: "file",
    resourceId,
    apiKeyId,
    metadata: {},
  });
}

const fileBody = (fileId: string) => ({
  input: [{ role: "user", content: [{ type: "input_file", file_id: fileId }] }],
});

async function sessionCookie() {
  const token = await new SignJWT({ authenticated: true, sub: "admin" })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  return `auth_token=${token}`;
}

function hasStatus(status: number) {
  return (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as Error & { status: number }).status, status);
    assert.doesNotMatch(error.message, /fixture-upstream|private document|Bearer|at \/workspace/);
    return true;
  };
}

test("collects native ids from supported file and cache fields without interpreting prompt text", async () => {
  const { collectProviderResourceReferences } =
    await import("../../src/sse/services/providerResourceOwnership.ts");
  assert.deepEqual(
    collectProviderResourceReferences({
      cachedContent: "cachedContents/cache-one",
      cached_content: "cachedContents/cache-two",
      extra_body: { google: { cached_content: "cachedContents/cache-three" } },
      input: [{ type: "input_file", file_id: "file-one" }, { input_file: { file_id: "file-two" } }],
      messages: [{ role: "user", content: [{ type: "file", file: { file_id: "file-three" } }] }],
      contents: [
        {
          parts: [
            {
              fileData: {
                fileUri: "https://generativelanguage.googleapis.com/v1beta/files/native-one",
              },
            },
            { file_data: { file_uri: "files/native-two" } },
          ],
        },
      ],
    }),
    [
      { provider: "gemini", kind: "cache", resourceId: "cachedContents/cache-one" },
      { provider: "gemini", kind: "cache", resourceId: "cachedContents/cache-two" },
      { provider: "gemini", kind: "cache", resourceId: "cachedContents/cache-three" },
      { provider: "openai", kind: "file", resourceId: "file-one" },
      { provider: "openai", kind: "file", resourceId: "file-two" },
      { provider: "openai", kind: "file", resourceId: "file-three" },
      { provider: "gemini", kind: "file", resourceId: "files/native-one" },
      { provider: "gemini", kind: "file", resourceId: "files/native-two" },
    ]
  );
  assert.deepEqual(
    collectProviderResourceReferences({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Read file-one and cachedContents/cache-one." },
            { type: "image_url", image_url: { url: "https://example.test/photo.png" } },
            { type: "file", file: { file_data: "data:application/pdf;base64,ZmlsZS1vbmU=" } },
          ],
        },
      ],
      contents: [
        { parts: [{ inlineData: { mimeType: "application/pdf", data: "ZmlsZS1vbmU=" } }] },
      ],
    }),
    []
  );
});

test("authorizes an owned OpenAI reference only on the selected connection", async () => {
  const { assertProviderResourceOwnership } =
    await import("../../src/sse/services/providerResourceOwnership.ts");
  const owner = await newKey("inference-owner");
  await bindFile("file-owned", owner.id);
  const caller = request({ authorization: `Bearer ${owner.key}` });
  await assertProviderResourceOwnership(caller, fileBody("file-owned"), routing(), {
    id: owner.id,
  });
  await assert.rejects(
    assertProviderResourceOwnership(
      caller,
      fileBody("file-owned"),
      routing("openai", "other-connection"),
      { id: owner.id }
    ),
    hasStatus(404)
  );
});

test("foreign and unknown references produce the same safe not-found failure", async () => {
  const { assertProviderResourceOwnership } =
    await import("../../src/sse/services/providerResourceOwnership.ts");
  const owner = await newKey("foreign-reference-owner");
  const foreign = await newKey("foreign-reference-caller");
  await bindFile("file-foreign", owner.id);
  const caller = request({ authorization: `Bearer ${foreign.key}` });
  const errors: string[] = [];
  for (const id of ["file-foreign", "file-unknown"]) {
    await assert.rejects(
      assertProviderResourceOwnership(caller, fileBody(id), routing(), { id: foreign.id }),
      (error: unknown) => {
        hasStatus(404)(error);
        errors.push((error as Error).message);
        assert.ok(!(error as Error).message.includes(id));
        return true;
      }
    );
  }
  assert.equal(errors[0], errors[1]);
});

test("an owned first file cannot hide a foreign reference in a later nested message", async () => {
  const { assertProviderResourceOwnership } =
    await import("../../src/sse/services/providerResourceOwnership.ts");
  const owner = await newKey("mixed-reference-owner");
  const foreign = await newKey("mixed-reference-foreign");
  await bindFile("file-mixed-own", owner.id);
  await bindFile("file-mixed-foreign", foreign.id);
  await assert.rejects(
    assertProviderResourceOwnership(
      request({ authorization: `Bearer ${owner.key}` }),
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "file", file: { file_id: "file-mixed-own" } },
              { type: "file", file: { file_id: "file-mixed-foreign" } },
            ],
          },
        ],
      },
      routing(),
      { id: owner.id }
    ),
    hasStatus(404)
  );
});

test("authorizes Gemini native file URIs and each supported cached-content alias", async () => {
  const { assertProviderResourceOwnership } =
    await import("../../src/sse/services/providerResourceOwnership.ts");
  const { saveProviderResourceBinding } = await import("../../src/lib/db/providerResources.ts");
  const owner = await newKey("gemini-reference-owner");
  const route = routing("gemini");
  await bindFile("files/gemini-owned", owner.id, route);
  saveProviderResourceBinding({
    provider: "gemini",
    connectionId: route.connectionId,
    kind: "cache",
    resourceId: "cachedContents/gemini-owned",
    apiKeyId: owner.id,
    metadata: {},
  });
  const bodies = [
    { cachedContent: "cachedContents/gemini-owned" },
    { cached_content: "cachedContents/gemini-owned" },
    { extra_body: { google: { cached_content: "cachedContents/gemini-owned" } } },
    {
      contents: [
        {
          parts: [
            {
              fileData: {
                fileUri: "https://generativelanguage.googleapis.com/v1beta/files/gemini-owned",
              },
            },
          ],
        },
      ],
    },
    { contents: [{ parts: [{ file_data: { file_uri: "files/gemini-owned" } }] }] },
  ];
  for (const body of bodies) {
    await assertProviderResourceOwnership(
      request({ authorization: `Bearer ${owner.key}` }),
      body,
      route,
      { id: owner.id }
    );
  }
});

test("Gemini Chat file carriers authorize the registered Gemini file instead of an OpenAI id", async () => {
  const { assertProviderResourceOwnership } =
    await import("../../src/sse/services/providerResourceOwnership.ts");
  const owner = await newKey("gemini-chat-carrier-owner");
  const route = routing("gemini");
  await bindFile("files/chat-carrier", owner.id, route);
  for (const fileId of [
    "files/chat-carrier",
    "https://generativelanguage.googleapis.com/v1beta/files/chat-carrier",
  ]) {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "file",
              file: {
                file_id: fileId,
                mime_type: "application/pdf",
              },
            },
          ],
        },
      ],
    };
    await assertProviderResourceOwnership(
      request({ authorization: `Bearer ${owner.key}` }),
      body,
      route,
      { id: owner.id }
    );
    await assert.rejects(
      assertProviderResourceOwnership(request(), body, routing("openai"), null),
      hasStatus(400)
    );
  }
});

test("resource scanning rejects excessive nesting or width before visiting an unbounded structure", async () => {
  const { collectProviderResourceReferences } =
    await import("../../src/sse/services/providerResourceOwnership.ts");
  const nested: Record<string, unknown> = {};
  let current = nested;
  for (let index = 0; index < 20_001; index++) {
    const next: Record<string, unknown> = {};
    current.next = next;
    current = next;
  }
  assert.throws(() => collectProviderResourceReferences(nested), hasStatus(400));
  assert.throws(
    () => collectProviderResourceReferences({ input: Array.from({ length: 20_001 }, () => ({})) }),
    hasStatus(400)
  );
});

test("rejects native provider mismatches before a resource lookup", async () => {
  const { assertProviderResourceOwnership } =
    await import("../../src/sse/services/providerResourceOwnership.ts");
  for (const [route, body] of [
    [routing("gemini"), fileBody("file-openai")],
    [routing("openai"), { cachedContent: "cachedContents/gemini-cache" }],
    [
      routing("openai"),
      { contents: [{ parts: [{ fileData: { fileUri: "files/gemini-file" } }] }] },
    ],
  ] as const) {
    await assert.rejects(
      assertProviderResourceOwnership(request(), body, route, null),
      hasStatus(400)
    );
  }
});

test("rejects malformed or off-origin native identifiers without requesting external content", async () => {
  const { collectProviderResourceReferences, normalizeProviderResourceId } =
    await import("../../src/sse/services/providerResourceOwnership.ts");
  assert.equal(normalizeProviderResourceId("gemini", "file", "short-id"), "files/short-id");
  assert.equal(
    normalizeProviderResourceId("gemini", "cache", "short-cache"),
    "cachedContents/short-cache"
  );
  const invalidUris = [
    "https://generativelanguage.googleapis.com.evil.test/v1beta/files/private",
    "https://generativelanguage.googleapis.com/v1beta/files/private?key=fixture-upstream-key",
    "https://generativelanguage.googleapis.com/v1beta/../v1beta/files/private",
    "https://generativelanguage.googleapis.com/v1beta/private",
    "https://user:password@generativelanguage.googleapis.com/v1beta/files/private",
    "files/../private",
    "files/private%2Fsecond",
    "file-unsupported/name",
    "",
  ];
  for (const fileUri of invalidUris) {
    assert.throws(
      () =>
        collectProviderResourceReferences({ contents: [{ parts: [{ fileData: { fileUri } }] }] }),
      hasStatus(400)
    );
  }
  assert.throws(
    () => collectProviderResourceReferences(fileBody("file-one/../../other")),
    hasStatus(400)
  );
});

test("validated alternate API-key transports retain their own resource ownership", async () => {
  const { assertProviderResourceOwnership } =
    await import("../../src/sse/services/providerResourceOwnership.ts");
  const owner = await newKey("alternate-owner");
  await bindFile("file-alternate", owner.id);
  for (const header of ["x-api-key", "x-goog-api-key"]) {
    await assertProviderResourceOwnership(
      request({ [header]: owner.key }),
      fileBody("file-alternate"),
      routing(),
      { id: owner.id, scopes: [] }
    );
  }
});

test("manage-scoped keys keep instance access across bearer and alternate transports", async () => {
  const { assertProviderResourceOwnership } =
    await import("../../src/sse/services/providerResourceOwnership.ts");
  const managed = await newKey("managed-reference-caller", ["manage"]);
  await bindFile("file-managed-target", "unrelated-owner");
  for (const headers of [
    { authorization: `Bearer ${managed.key}` },
    { "x-api-key": managed.key },
  ]) {
    await assertProviderResourceOwnership(
      request(headers),
      fileBody("file-managed-target"),
      routing(),
      { id: managed.id, scopes: ["manage"] }
    );
  }
});

test("dashboard sessions may access resources but an ordinary key override remains tenant scoped", async () => {
  const { assertProviderResourceOwnership } =
    await import("../../src/sse/services/providerResourceOwnership.ts");
  const cookie = await sessionCookie();
  const foreign = await newKey("session-override-key");
  await bindFile("file-session-target", null);
  await assertProviderResourceOwnership(
    request({ cookie }),
    fileBody("file-session-target"),
    routing(),
    null
  );
  await assert.rejects(
    assertProviderResourceOwnership(
      request({ cookie, authorization: `Bearer ${foreign.key}` }),
      fileBody("file-session-target"),
      routing(),
      { id: foreign.id }
    ),
    hasStatus(404)
  );
  await assert.rejects(
    assertProviderResourceOwnership(
      request({ cookie, "x-api-key": foreign.key }),
      fileBody("file-session-target"),
      routing(),
      { id: foreign.id }
    ),
    hasStatus(404)
  );
});

test("revoked bearer credentials cannot reuse stale policy metadata or a dashboard session", async () => {
  const { assertProviderResourceOwnership } =
    await import("../../src/sse/services/providerResourceOwnership.ts");
  const { revokeApiKey } = await import("../../src/lib/db/apiKeys.ts");
  const owner = await newKey("revoked-reference-owner", ["manage"]);
  await bindFile("file-revoked-target", owner.id);
  await revokeApiKey(owner.id);
  await assert.rejects(
    assertProviderResourceOwnership(
      request({ authorization: `Bearer ${owner.key}`, cookie: await sessionCookie() }),
      fileBody("file-revoked-target"),
      routing(),
      { id: owner.id, scopes: ["manage"] }
    ),
    hasStatus(401)
  );
});

test("anonymous ownership is shared only through the existing anonymous sentinel", async () => {
  const { assertProviderResourceOwnership } =
    await import("../../src/sse/services/providerResourceOwnership.ts");
  const { ANONYMOUS_OWNER_ID } = await import("../../src/shared/constants/anonymousOwner.ts");
  await bindFile("file-anonymous", ANONYMOUS_OWNER_ID);
  await bindFile("file-null-owner", null);
  await assertProviderResourceOwnership(request(), fileBody("file-anonymous"), routing(), null);
  await assert.rejects(
    assertProviderResourceOwnership(request(), fileBody("file-null-owner"), routing(), null),
    hasStatus(404)
  );
  const owner = await newKey("anonymous-foreign-caller");
  await assert.rejects(
    assertProviderResourceOwnership(
      request({ authorization: `Bearer ${owner.key}` }),
      fileBody("file-anonymous"),
      routing(),
      { id: owner.id }
    ),
    hasStatus(404)
  );
});
