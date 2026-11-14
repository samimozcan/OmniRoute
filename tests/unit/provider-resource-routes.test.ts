import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-resources-routes-"));
process.env.DATA_DIR = dataDir;
process.env.API_KEY_SECRET = "resource-routes-fixture";
process.env.JWT_SECRET = "resource-routes-fixture-jwt";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
const { resetDbInstance } = await import("../../src/lib/db/core.ts");
const { createApiKey, updateApiKeyPermissions } = await import("../../src/lib/db/apiKeys.ts");
const { createProviderConnection } = await import("../../src/lib/db/providers.ts");
const files = await import("../../src/app/api/v1/files/route.ts");
const fileItem = await import("../../src/app/api/v1/files/[id]/route.ts");
const fileContent = await import("../../src/app/api/v1/files/[id]/content/route.ts");

const owner = await createApiKey("resource-owner", "fixture-owner");
const stranger = await createApiKey("resource-stranger", "fixture-stranger");
const first = await createProviderConnection({
  provider: "openai",
  authType: "apikey",
  apiKey: "fixture-primary-zero",
  priority: 1,
});
const second = await createProviderConnection({
  provider: "openai",
  authType: "apikey",
  apiKey: "fixture-primary-one",
  priority: 2,
});
await createProviderConnection({
  provider: "gemini",
  authType: "apikey",
  apiKey: "fixture-gemini-zero",
  priority: 1,
});

type RequestBody = Record<string, unknown>;
const requests: Array<{
  url: string;
  method: string;
  authorization: string | null;
  body: unknown;
}> = [];
let nextId = 0;
let upstreamStatus = 200;
let upstreamBody: Record<string, unknown> | null = null;
let upstreamPages: Record<string, unknown>[] = [];
const originalFetch = globalThis.fetch;

test.beforeEach(() => {
  requests.length = 0;
  upstreamStatus = 200;
  upstreamBody = null;
  upstreamPages = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const h = new Headers(init?.headers);
    const method = init?.method || "GET";
    requests.push({
      url,
      method,
      authorization: h.get("authorization") || h.get("x-goog-api-key"),
      body: init?.body,
    });
    if (upstreamStatus !== 200)
      return Response.json(
        { error: { message: "fixture upstream failure" } },
        { status: upstreamStatus }
      );
    if (upstreamPages.length) return Response.json(upstreamPages.shift());
    if (upstreamBody) return Response.json(upstreamBody);
    if (url.endsWith("/content"))
      return new Response("%PDF", { headers: { "Content-Type": "application/pdf" } });
    if (method === "POST" && url.endsWith("/v1/files")) {
      return Response.json({
        id: `file-routed-${++nextId}`,
        object: "file",
        filename: "sample.pdf",
        purpose: "user_data",
        bytes: 4,
      });
    }
    if (url.includes("cachedContents")) {
      if (method === "POST")
        return Response.json({
          name: `cachedContents/cache-${++nextId}`,
          model: "models/gemini-2.5-flash",
          expireTime: "2026-11-15T12:00:00Z",
        });
      return Response.json({ name: url.split("/v1beta/")[1], model: "models/gemini-2.5-flash" });
    }
    const id = url.split("/").at(-1);
    if (method === "DELETE") return Response.json({ id, object: "file", deleted: true });
    return Response.json({ id, object: "file", filename: "sample.pdf" });
  }) as typeof fetch;
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});
test.after(() => {
  resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function auth(key = owner.key, selectors: Record<string, string> = {}) {
  return { Authorization: `Bearer ${key}`, ...selectors };
}
function upload(selectors: Record<string, string> = {}, key = owner.key) {
  const body = new FormData();
  body.append("file", new File(["%PDF"], "sample.pdf", { type: "application/pdf" }));
  body.append("purpose", "user_data");
  return new Request("http://localhost/v1/files", {
    method: "POST",
    headers: auth(key, selectors),
    body,
  });
}
async function body(response: Response): Promise<RequestBody> {
  return response.json() as Promise<RequestBody>;
}

test("selected upload returns the upstream id and default-zero identity, legacy remains local", async () => {
  const response = await files.POST(upload({ "x-omniroute-provider": "openai" }));
  assert.equal(response.status, 200);
  assert.match(String((await body(response)).id), /^file-routed-/);
  assert.equal(response.headers.get("x-omniroute-selected-connection-id"), first.id);
  assert.equal(response.headers.get("x-omniroute-key-index"), "0");
  assert.equal(requests[0].authorization, "Bearer fixture-primary-zero");
  const nativeForm = requests[0].body as FormData;
  assert.equal(nativeForm.get("purpose"), "user_data");
  requests.length = 0;
  const local = await files.POST(upload());
  assert.equal(local.status, 200);
  assert.doesNotMatch(String((await body(local)).id), /^file-routed-/);
  assert.equal(requests.length, 0);
});

test("explicit index one uses only that primary key and preserves upstream failure", async () => {
  const response = await files.POST(
    upload({ "x-omniroute-provider": "openai", "x-omniroute-key-index": "1" })
  );
  assert.equal(response.headers.get("x-omniroute-selected-connection-id"), second.id);
  assert.equal(requests[0].authorization, "Bearer fixture-primary-one");
  requests.length = 0;
  upstreamStatus = 429;
  const limited = await files.POST(
    upload({ "x-omniroute-provider": "openai", "x-omniroute-key-index": "1" })
  );
  assert.equal(limited.status, 429);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].authorization, "Bearer fixture-primary-one");
});

test("uploaded resource survives DB reopening and denies a foreign key before upstream", async () => {
  const uploaded = await files.POST(upload({ "x-omniroute-provider": "openai" }));
  const id = String((await body(uploaded)).id);
  resetDbInstance();
  requests.length = 0;
  const selectors = { "x-omniroute-provider": "openai", "x-omniroute-connection": first.id };
  const foreign = await fileItem.GET(
    new Request(`http://localhost/v1/files/${id}`, { headers: auth(stranger.key, selectors) }),
    { params: Promise.resolve({ id }) }
  );
  assert.equal(foreign.status, 404);
  assert.equal(requests.length, 0);
  const own = await fileItem.GET(
    new Request(`http://localhost/v1/files/${id}`, { headers: auth(owner.key, selectors) }),
    { params: Promise.resolve({ id }) }
  );
  assert.equal(own.status, 200);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].authorization, "Bearer fixture-primary-zero");
});

test("invalid index or invalid credentials never upload", async () => {
  for (const value of ["-1", "no", "99"]) {
    assert.equal(
      (
        await files.POST(
          upload({ "x-omniroute-provider": "openai", "x-omniroute-key-index": value })
        )
      ).status,
      400
    );
  }
  assert.equal(
    (await files.POST(upload({ "x-omniroute-provider": "openai" }, "invalid-fixture-key"))).status,
    401
  );
  assert.equal(requests.length, 0);
});

test("Gemini cache requires provider and rejects OpenAI standalone cache", async () => {
  const cache = await import("../../src/app/api/v1/cachedContents/route.ts");
  const request = (provider?: string) =>
    new Request("http://localhost/v1/cachedContents", {
      method: "POST",
      headers: {
        ...auth(owner.key, provider ? { "x-omniroute-provider": provider } : {}),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "models/gemini-2.5-flash",
        contents: [
          { role: "user", parts: [{ text: "A sufficiently long reusable document fixture" }] },
        ],
        ttl: "3600s",
      }),
    });
  assert.equal((await cache.POST(request())).status, 400);
  const unsupported = await cache.POST(request("openai"));
  assert.equal(unsupported.status, 400);
  assert.equal(requests.length, 0);
  const result = await cache.POST(request("gemini"));
  assert.equal(result.status, 200);
  assert.match(String((await body(result)).name), /^cachedContents\//);
  assert.equal(requests[0].authorization, "fixture-gemini-zero");
});

test("list results contain only the caller's registered upstream resources", async () => {
  const selectors = { "x-omniroute-provider": "openai" };
  const ownId = (await body(await files.POST(upload(selectors)))).id;
  const foreignId = (await body(await files.POST(upload(selectors, stranger.key)))).id;
  upstreamBody = {
    object: "list",
    data: [
      { id: ownId, filename: "own.pdf" },
      { id: foreignId, filename: "private.pdf" },
      { id: "file-external", filename: "external.pdf" },
    ],
    total_count: 3,
    first_id: foreignId,
    last_id: "file-external",
    has_more: false,
  };
  const response = await files.GET(
    new Request("http://localhost/v1/files", { headers: auth(owner.key, selectors) })
  );
  assert.equal(response.status, 200);
  const payload = await body(response);
  assert.deepEqual(payload.data, [{ id: ownId, filename: "own.pdf" }]);
  assert.equal(payload.first_id, ownId);
  assert.equal(payload.last_id, ownId);
  assert.equal(payload.total_count, undefined);
});

test("content and deletion stay on the owned account; deleting removes the binding", async () => {
  const selectors = { "x-omniroute-provider": "openai", "x-omniroute-key-index": "1" };
  const id = String((await body(await files.POST(upload(selectors)))).id);
  const request = (key = owner.key) =>
    new Request(`http://localhost/v1/files/${id}`, { headers: auth(key, selectors) });
  requests.length = 0;
  const denied = await fileItem.DELETE(request(stranger.key), { params: Promise.resolve({ id }) });
  assert.equal(denied.status, 404);
  assert.equal(requests.length, 0);
  const downloaded = await fileContent.GET(
    new Request(`http://localhost/v1/files/${id}/content`, { headers: auth(owner.key, selectors) }),
    { params: Promise.resolve({ id }) }
  );
  assert.equal(downloaded.headers.get("content-type"), "application/pdf");
  assert.equal(await downloaded.text(), "%PDF");
  assert.equal(requests[0].authorization, "Bearer fixture-primary-one");
  const removed = await fileItem.DELETE(new Request(request(), { method: "DELETE" }), {
    params: Promise.resolve({ id }),
  });
  assert.equal(removed.status, 200);
  requests.length = 0;
  assert.equal((await fileItem.GET(request(), { params: Promise.resolve({ id }) })).status, 404);
  assert.equal(requests.length, 0);
});

test("alternate key transport retains ownership and endpoint restrictions cover caches", async () => {
  const source = upload({ "x-omniroute-provider": "openai" });
  const alternate = new Headers(source.headers);
  alternate.delete("authorization");
  alternate.set("x-api-key", owner.key);
  const result = await files.POST(new Request(source, { headers: alternate }));
  assert.equal(result.status, 200);
  const id = String((await body(result)).id);
  const own = await fileItem.GET(
    new Request(`http://localhost/v1/files/${id}`, {
      headers: auth(owner.key, { "x-omniroute-provider": "openai" }),
    }),
    { params: Promise.resolve({ id }) }
  );
  assert.equal(own.status, 200);
  const restricted = await createApiKey("chat-only", "fixture-chat-only");
  await updateApiKeyPermissions(restricted.id, { allowedEndpoints: ["chat"] });
  requests.length = 0;
  assert.equal(
    (await files.POST(upload({ "x-omniroute-provider": "openai" }, restricted.key))).status,
    403
  );
  const cache = await import("../../src/app/api/v1/cachedContents/route.ts");
  const denied = await cache.POST(
    new Request("http://localhost/v1/cachedContents", {
      method: "POST",
      headers: {
        ...auth(restricted.key, { "x-omniroute-provider": "gemini" }),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "models/gemini-2.5-flash",
        contents: [{ role: "user", parts: [{ text: "fixture" }] }],
      }),
    })
  );
  assert.equal(denied.status, 403);
  assert.equal(requests.length, 0);
});

test("connection scope rejects index zero instead of renumbering and preflight exposes selectors", async () => {
  const restricted = await createApiKey("second-only", "fixture-second-only", [], {
    allowedConnections: [second.id],
  });
  assert.equal(
    (await files.POST(upload({ "x-omniroute-provider": "openai" }, restricted.key))).status,
    403
  );
  assert.equal(requests.length, 0);
  const permitted = await files.POST(
    upload({ "x-omniroute-provider": "openai", "x-omniroute-key-index": "1" }, restricted.key)
  );
  assert.equal(permitted.status, 200);
  assert.equal(requests[0].authorization, "Bearer fixture-primary-one");
  const cors = await files.OPTIONS();
  assert.match(cors.headers.get("access-control-allow-headers") ?? "", /x-omniroute-provider/);
  assert.match(cors.headers.get("access-control-allow-headers") ?? "", /x-omniroute-key-index/);
  assert.match(
    cors.headers.get("access-control-expose-headers") ?? "",
    /X-OmniRoute-Selected-Connection-Id/
  );
});

test("cache creation rejects oversized declared and streamed JSON before dispatch", async () => {
  const cache = await import("../../src/app/api/v1/cachedContents/route.ts");
  for (const declared of [true, false]) {
    let cancelled = false;
    const oversized = new Uint8Array(16 * 1024 * 1024 + 1);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(oversized);
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request("http://localhost/v1/cachedContents", {
      method: "POST",
      headers: {
        ...auth(owner.key, { "x-omniroute-provider": "gemini" }),
        "content-type": "application/json",
        ...(declared ? { "content-length": String(oversized.byteLength) } : {}),
      },
      body: stream,
      duplex: "half",
    } as RequestInit);
    // A declared limit must be checked without consuming this open stream.
    // The streamed variant must cancel immediately upon crossing the limit.
    const response = await cache.POST(request);
    assert.equal(response.status, 413);
    if (!declared) assert.equal(cancelled, true);
    await stream.cancel().catch(() => {});
  }
  assert.equal(requests.length, 0);
});

test("cache input parsing cancels a stalled stream before upstream dispatch", async () => {
  const cache = await import("../../src/app/api/v1/cachedContents/route.ts");
  const controller = new AbortController();
  let cancelled = false;
  const request = new Request("http://localhost/v1/cachedContents", {
    method: "POST",
    headers: {
      ...auth(owner.key, { "x-omniroute-provider": "gemini" }),
      "content-type": "application/json",
    },
    signal: controller.signal,
    body: new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    }),
    duplex: "half",
  } as RequestInit);
  const pending = cache.POST(request);
  setTimeout(() => controller.abort(), 10);
  const response = await pending;
  assert.equal(response.status, 499);
  assert.equal(cancelled, true);
  assert.equal(requests.length, 0);
});

test("OpenAI listing crosses hidden pages without exposing their cursors", async () => {
  const selectors = { "x-omniroute-provider": "openai" };
  const id = String((await body(await files.POST(upload(selectors)))).id);
  requests.length = 0;
  upstreamPages = [
    { data: [{ id: "file-outside-first" }], last_id: "file-outside-first", has_more: true },
    { data: [{ id: "file-outside-second" }], last_id: "file-outside-second", has_more: true },
    { data: [{ id, filename: "own.pdf" }], last_id: id, has_more: false },
  ];
  const response = await files.GET(
    new Request("http://localhost/v1/files?limit=1", {
      headers: auth(owner.key, selectors),
    })
  );
  assert.equal(response.status, 200);
  const payload = await body(response);
  assert.deepEqual(payload.data, [{ id, filename: "own.pdf" }]);
  assert.equal(payload.first_id, id);
  assert.equal(payload.last_id, id);
  assert.equal(payload.has_more, false);
  assert.equal(requests.length, 3);
  assert.equal(new URL(requests[1].url).searchParams.get("after"), "file-outside-first");
  assert.equal(new URL(requests[2].url).searchParams.get("after"), "file-outside-second");
  assert.doesNotMatch(JSON.stringify(payload), /file-outside/);
});
