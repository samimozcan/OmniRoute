import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import {
  handleProviderResourceRequest,
  type ProviderResourceContext,
  type ProviderResourceOperation,
} from "../../open-sse/handlers/providerResources.ts";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const openai: ProviderResourceContext = {
  provider: "openai",
  apiKey: "selected-openai-primary",
  connectionId: "connection-openai-2",
  providerSpecificData: {
    baseUrl: "https://untrusted.example/v1",
    extraApiKeys: ["must-not-rotate-to-this-key"],
    customHeaders: {
      "openai-project": "proj-selected",
      "OpenAI-Organization": "org-selected",
      Authorization: "Bearer must-not-use-custom-auth",
      "X-OmniRoute-Key-Index": "9",
    },
  },
};
const gemini: ProviderResourceContext = {
  provider: "gemini",
  apiKey: "selected-google-primary",
  connectionId: "connection-gemini-1",
  providerSpecificData: {},
};
const nativeFile = {
  id: "file-native123",
  object: "file",
  bytes: 5,
  created_at: 1794614400,
  filename: "example.txt",
  purpose: "user_data",
};
const googleFile = {
  file: {
    name: "files/native-123",
    displayName: "Example document",
    mimeType: "text/plain",
    sizeBytes: "5",
    createTime: "2026-11-14T00:00:00Z",
    expirationTime: "2026-11-16T00:00:00Z",
    state: "PROCESSING",
    uri: "https://generativelanguage.googleapis.com/v1beta/files/native-123",
  },
};

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function mockFetch(
  respond: (request: Request, index: number) => Response | Promise<Response>
): Request[] {
  const calls: Request[] = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    calls.push(request);
    return respond(request, calls.length - 1);
  };
  return calls;
}

function request(method = "GET", query = "", body?: BodyInit, headers?: HeadersInit): Request {
  return new Request(`http://localhost/v1/files${query}`, {
    method,
    body,
    headers: {
      authorization: "Bearer client-router-secret",
      "x-omniroute-provider": "google",
      "x-omniroute-key-index": "2",
      "x-omniroute-connection": "connection-gemini-1",
      ...Object.fromEntries(new Headers(headers)),
    },
  });
}

function upload(fields: Record<string, string> = {}): FormData {
  const form = new FormData();
  form.set("file", new File(["hello"], "example.txt", { type: "text/plain" }));
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  return form;
}

test("OpenAI uploads native multipart with primary credentials and configured project scope", async () => {
  const calls = mockFetch(() =>
    json(nativeFile, 201, { "x-request-id": "req-native", "set-cookie": "upstream-session=secret" })
  );
  const response = await handleProviderResourceRequest(
    request(
      "POST",
      "",
      upload({
        purpose: "user_data",
        "expires_after[anchor]": "created_at",
        "expires_after[seconds]": "3600",
      })
    ),
    openai,
    { kind: "file" }
  );
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), nativeFile);
  assert.equal(response.headers.get("x-request-id"), "req-native");
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(calls.length, 1);
  const sent = calls[0];
  assert.equal(sent.url, "https://api.openai.com/v1/files");
  assert.equal(sent.redirect, "manual");
  assert.equal(sent.headers.get("authorization"), "Bearer selected-openai-primary");
  assert.equal(sent.headers.get("openai-project"), "proj-selected");
  assert.equal(sent.headers.get("openai-organization"), "org-selected");
  assert.equal(sent.headers.get("x-omniroute-key-index"), null);
  assert.equal(sent.headers.get("x-omniroute-provider"), null);
  const body = await sent.formData();
  assert.equal(body.get("purpose"), "user_data");
  assert.equal(body.get("expires_after[seconds]"), "3600");
  const file = body.get("file");
  assert.ok(file instanceof File);
  assert.equal(file.name, "example.txt");
  assert.equal(file.type, "text/plain");
  assert.equal(await file.text(), "hello");
});

test("OpenAI file reads lists deletes and content use only official native paths", async () => {
  const cases: Array<{
    method: string;
    query?: string;
    operation: ProviderResourceOperation;
    url: string;
    body: unknown;
  }> = [
    {
      method: "GET",
      query: "?limit=10&after=file-prev&order=asc&purpose=user_data",
      operation: { kind: "file" },
      url: "https://api.openai.com/v1/files?limit=10&after=file-prev&order=asc&purpose=user_data",
      body: { object: "list", data: [nativeFile], has_more: false },
    },
    {
      method: "GET",
      operation: { kind: "file", id: "file-native123" },
      url: "https://api.openai.com/v1/files/file-native123",
      body: nativeFile,
    },
    {
      method: "DELETE",
      operation: { kind: "file", id: "file-native123" },
      url: "https://api.openai.com/v1/files/file-native123",
      body: { id: "file-native123", object: "file", deleted: true },
    },
  ];
  for (const fixture of cases) {
    const calls = mockFetch(() => json(fixture.body));
    const response = await handleProviderResourceRequest(
      request(fixture.method, fixture.query),
      openai,
      fixture.operation
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), fixture.body);
    assert.equal(calls[0].url, fixture.url);
    assert.equal(calls[0].method, fixture.method);
    assert.equal(calls[0].headers.get("authorization"), "Bearer selected-openai-primary");
  }
  const calls = mockFetch(
    () =>
      new Response("original file bytes", {
        headers: {
          "content-type": "text/plain",
          "content-disposition": 'attachment; filename="example.txt"',
          "content-encoding": "gzip",
          "content-length": "999",
        },
      })
  );
  const response = await handleProviderResourceRequest(request(), openai, {
    kind: "file",
    id: "file-native123",
    content: true,
  });
  assert.equal(calls[0].url, "https://api.openai.com/v1/files/file-native123/content");
  assert.equal(await response.text(), "original file bytes");
  assert.equal(response.headers.get("content-type"), "text/plain");
  assert.equal(response.headers.get("content-encoding"), null);
  assert.equal(response.headers.get("content-length"), null);
});

test("Gemini starts then finalizes a resumable upload and preserves the native file envelope", async () => {
  const calls = mockFetch((_request, index) =>
    index === 0
      ? new Response(null, {
          headers: {
            "x-goog-upload-url":
              "https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=session-123&upload_protocol=resumable",
          },
        })
      : json(googleFile)
  );
  const response = await handleProviderResourceRequest(
    request("POST", "", upload({ display_name: "Example document" })),
    gemini,
    { kind: "file" }
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), googleFile);
  assert.equal(calls.length, 2);
  const [start, finalize] = calls;
  assert.equal(start.url, "https://generativelanguage.googleapis.com/upload/v1beta/files");
  assert.equal(start.method, "POST");
  assert.equal(start.headers.get("x-goog-api-key"), "selected-google-primary");
  assert.equal(start.headers.get("x-goog-upload-protocol"), "resumable");
  assert.equal(start.headers.get("x-goog-upload-command"), "start");
  assert.equal(start.headers.get("x-goog-upload-header-content-length"), "5");
  assert.equal(start.headers.get("x-goog-upload-header-content-type"), "text/plain");
  assert.deepEqual(await start.json(), { file: { displayName: "Example document" } });
  assert.equal(finalize.method, "POST");
  assert.equal(finalize.headers.get("x-goog-upload-command"), "upload, finalize");
  assert.equal(finalize.headers.get("x-goog-upload-offset"), "0");
  assert.equal(finalize.headers.get("content-length"), "5");
  assert.equal(await finalize.text(), "hello");
  for (const sent of calls) {
    assert.equal(sent.redirect, "manual");
    assert.equal(sent.headers.get("x-omniroute-provider"), null);
    assert.equal(sent.headers.get("authorization"), null);
  }
});

test("Gemini file operations preserve native names and allow only pagination parameters", async () => {
  for (const fixture of [
    {
      method: "GET",
      query: "?pageSize=10&pageToken=next-token",
      operation: { kind: "file" } as ProviderResourceOperation,
      path: "files?pageSize=10&pageToken=next-token",
      body: { files: [googleFile.file], nextPageToken: "next-2" },
    },
    {
      method: "GET",
      operation: { kind: "file", id: "files%2Fnative-123" } as ProviderResourceOperation,
      path: "files/native-123",
      body: googleFile.file,
    },
    {
      method: "DELETE",
      operation: { kind: "file", id: "native-123" } as ProviderResourceOperation,
      path: "files/native-123",
      body: {},
    },
  ]) {
    const calls = mockFetch(() => json(fixture.body));
    const response = await handleProviderResourceRequest(
      request(fixture.method, fixture.query),
      gemini,
      fixture.operation
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), fixture.body);
    assert.equal(calls[0].url, `https://generativelanguage.googleapis.com/v1beta/${fixture.path}`);
    assert.equal(calls[0].headers.get("x-goog-api-key"), "selected-google-primary");
  }
});

test("Gemini cache create preserves content tools instructions model and provider IDs", async () => {
  const body = {
    model: "models/gemini-2.5-flash",
    displayName: "Reusable document",
    contents: [
      {
        role: "user",
        parts: [{ fileData: { mimeType: "text/plain", fileUri: googleFile.file.uri } }],
      },
    ],
    systemInstruction: { parts: [{ text: "Use the reference." }] },
    tools: [{ functionDeclarations: [{ name: "lookup", parameters: { type: "OBJECT" } }] }],
    toolConfig: { functionCallingConfig: { mode: "AUTO" } },
    ttl: "3600s",
  };
  const native = {
    name: "cachedContents/cache-123",
    model: body.model,
    displayName: body.displayName,
    expireTime: "2026-11-14T01:00:00Z",
    usageMetadata: { totalTokenCount: 4096 },
  };
  const calls = mockFetch(() => json(native, 201));
  const response = await handleProviderResourceRequest(
    request("POST", "", JSON.stringify(body), { "content-type": "application/json" }),
    gemini,
    { kind: "cache" }
  );
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), native);
  assert.equal(calls[0].url, "https://generativelanguage.googleapis.com/v1beta/cachedContents");
  assert.deepEqual(await calls[0].json(), body);
});

test("Gemini cache list get expiry update and delete preserve native responses", async () => {
  const fixtures: Array<{
    method: string;
    query?: string;
    operation: ProviderResourceOperation;
    body?: unknown;
    path: string;
  }> = [
    {
      method: "GET",
      query: "?pageSize=2&pageToken=next",
      operation: { kind: "cache" },
      path: "cachedContents?pageSize=2&pageToken=next",
    },
    {
      method: "GET",
      operation: { kind: "cache", id: "cachedContents%2Fcache-123" },
      path: "cachedContents/cache-123",
    },
    {
      method: "PATCH",
      query: "?updateMask=ttl",
      operation: { kind: "cache", id: "cache-123" },
      path: "cachedContents/cache-123?updateMask=ttl",
      body: { ttl: "600s" },
    },
    {
      method: "PATCH",
      operation: { kind: "cache", id: "cache-123" },
      path: "cachedContents/cache-123",
      body: { expireTime: "2026-11-14T01:00:00Z" },
    },
    {
      method: "DELETE",
      operation: { kind: "cache", id: "cache-123" },
      path: "cachedContents/cache-123",
    },
  ];
  for (const fixture of fixtures) {
    const calls = mockFetch(() =>
      fixture.method === "DELETE"
        ? new Response(null, { status: 204 })
        : json({ name: "cachedContents/cache-123" })
    );
    const response = await handleProviderResourceRequest(
      request(
        fixture.method,
        fixture.query,
        fixture.body ? JSON.stringify(fixture.body) : undefined,
        fixture.body ? { "content-type": "application/json" } : undefined
      ),
      gemini,
      fixture.operation
    );
    assert.equal(response.status, fixture.method === "DELETE" ? 204 : 200);
    await response.text();
    assert.equal(calls[0].url, `https://generativelanguage.googleapis.com/v1beta/${fixture.path}`);
    assert.equal(calls[0].method, fixture.method);
    if (fixture.body) assert.deepEqual(await calls[0].json(), fixture.body);
  }
});

test("unsupported cache and download capabilities do not dispatch upstream", async () => {
  const calls = mockFetch(() => json({}));
  const cache = await handleProviderResourceRequest(request(), openai, { kind: "cache" });
  const download = await handleProviderResourceRequest(request(), gemini, {
    kind: "file",
    id: "native-123",
    content: true,
  });
  assert.equal(cache.status, 400);
  assert.match((await cache.json()).error.message, /not supported/i);
  const existingCache = await handleProviderResourceRequest(request(), openai, {
    kind: "cache",
    id: "cachedContents/cache-123",
  });
  assert.match((await existingCache.json()).error.message, /not supported/i);
  assert.equal(download.status, 400);
  assert.match((await download.json()).error.message, /not supported/i);
  assert.equal(calls.length, 0);
});

test("invalid resource paths cannot reach a different endpoint", async () => {
  const calls = mockFetch(() => json({}));
  for (const id of [
    "../models",
    "files/../models",
    "files%2F..%2Fmodels",
    "files%252Fnative-123",
    "files/native-123/content",
    "https://attacker.example",
    "native-123?key=override",
    "native-123#fragment",
    "%",
    "native\\123",
  ]) {
    const response = await handleProviderResourceRequest(request(), gemini, { kind: "file", id });
    assert.equal(response.status, 400, id);
  }
  const response = await handleProviderResourceRequest(request(), openai, {
    kind: "file",
    id: "file-native123/content",
  });
  assert.equal(response.status, 400);
  assert.equal(calls.length, 0);
});

test("unknown duplicate and malformed query parameters are rejected before dispatch", async () => {
  const calls = mockFetch(() => json({}));
  for (const query of [
    "?key=override",
    "?provider=openai",
    "?apiKeyIndex=2",
    "?pageSize=0",
    "?pageSize=1.5",
    "?pageSize=2&pageSize=3",
    "?alt=media",
  ]) {
    const response = await handleProviderResourceRequest(request("GET", query), gemini, {
      kind: "file",
    });
    assert.equal(response.status, 400, query);
  }
  assert.equal(
    (await handleProviderResourceRequest(request("GET", "?limit=2x"), openai, { kind: "file" }))
      .status,
    400
  );
  assert.equal(
    (
      await handleProviderResourceRequest(request("GET", "?order=sideways"), openai, {
        kind: "file",
      })
    ).status,
    400
  );
  assert.equal(
    (
      await handleProviderResourceRequest(request("GET", "?pageToken=x"), gemini, {
        kind: "file",
        id: "native-123",
      })
    ).status,
    400
  );
  assert.equal(calls.length, 0);
});

test("uploads reject missing file purpose unsupported fields and oversized framing", async () => {
  const calls = mockFetch(() => json({}));
  assert.equal(
    (await handleProviderResourceRequest(request("POST", "", upload()), openai, { kind: "file" }))
      .status,
    400
  );
  assert.equal(
    (
      await handleProviderResourceRequest(
        request("POST", "", upload({ purpose: "user_data", provider: "gemini" })),
        openai,
        { kind: "file" }
      )
    ).status,
    400
  );
  const missing = new FormData();
  missing.set("purpose", "user_data");
  assert.equal(
    (await handleProviderResourceRequest(request("POST", "", missing), openai, { kind: "file" }))
      .status,
    400
  );
  assert.equal(
    (
      await handleProviderResourceRequest(
        request("POST", "", upload({ purpose: "user_data" }), {
          "content-length": String(513 * 1024 * 1024),
        }),
        openai,
        { kind: "file" }
      )
    ).status,
    413
  );
  assert.equal(calls.length, 0);
});

test("invalid cache payloads cannot forward routing fields or mutate cached content", async () => {
  const calls = mockFetch(() => json({}));
  for (const body of [
    { model: "models/gemini-2.5-flash", provider: "openai" },
    { model: "models/gemini-2.5-flash", apiKeyIndex: 1 },
    { model: "models/gemini-2.5-flash", ttl: "600s", expireTime: "2026-11-14T01:00:00Z" },
    { model: "models/gemini-2.5-flash", ttl: "forever" },
    { contents: [] },
  ]) {
    assert.equal(
      (
        await handleProviderResourceRequest(
          request("POST", "", JSON.stringify(body), { "content-type": "application/json" }),
          gemini,
          { kind: "cache" }
        )
      ).status,
      400
    );
  }
  for (const body of [
    { contents: [] },
    {},
    { ttl: "600s", expireTime: "2026-11-14T01:00:00Z" },
    { expireTime: "invalid" },
  ]) {
    assert.equal(
      (
        await handleProviderResourceRequest(
          request("PATCH", "", JSON.stringify(body), { "content-type": "application/json" }),
          gemini,
          { kind: "cache", id: "cache-123" }
        )
      ).status,
      400
    );
  }
  assert.equal(calls.length, 0);
});

test("Gemini upload refuses untrusted resumable URLs before transmitting file bytes", async () => {
  for (const location of [
    "https://attacker.example/upload/v1beta/files",
    "http://generativelanguage.googleapis.com/upload/v1beta/files",
    "https://generativelanguage.googleapis.com:444/upload/v1beta/files",
    "https://user:pass@generativelanguage.googleapis.com/upload/v1beta/files",
    "https://generativelanguage.googleapis.com/v1beta/models",
    "https://generativelanguage.googleapis.com/upload/v1beta/filesevil",
    "https://generativelanguage.googleapis.com/upload/v1beta/files/../models",
    "https://generativelanguage.googleapis.com/upload/v1beta/files/%2e%2e%2fmodels",
    "//generativelanguage.googleapis.com/upload/v1beta/files",
    "https://generativelanguage.googleapis.com/upload/v1beta/files#fragment",
  ]) {
    const calls = mockFetch(
      () => new Response(null, { headers: { "x-goog-upload-url": location } })
    );
    const response = await handleProviderResourceRequest(request("POST", "", upload()), gemini, {
      kind: "file",
    });
    assert.equal(response.status, 502, location);
    assert.equal(calls.length, 1, location);
    assert.doesNotMatch(await response.text(), /user:pass|attacker\.example/);
  }
});

test("all upstream redirects are terminal and never reveal their body or target", async () => {
  const calls = mockFetch(
    () =>
      new Response("selected-openai-primary private redirect", {
        status: 307,
        headers: { location: "https://attacker.example/private" },
      })
  );
  const response = await handleProviderResourceRequest(request(), openai, { kind: "file" });
  assert.equal(response.status, 502);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].redirect, "manual");
  assert.equal(response.headers.get("location"), null);
  assert.doesNotMatch(await response.text(), /selected-openai-primary|attacker|private redirect/);
});

test("upstream errors keep status and safe retry information but redact credentials and paths", async () => {
  const calls = mockFetch(() =>
    json(
      {
        error: {
          message:
            "Quota for selected-google-primary at /srv/private/credentials.json\n    at handler (/srv/app.ts:1:2)",
          code: 429,
          status: "RESOURCE_EXHAUSTED",
        },
      },
      429,
      { "retry-after": "30", "x-request-id": "req-quota", "set-cookie": "secret=1" }
    )
  );
  const response = await handleProviderResourceRequest(request(), gemini, { kind: "file" });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "30");
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(calls.length, 1);
  const body = await response.text();
  assert.match(body, /Quota/);
  assert.doesNotMatch(body, /selected-google-primary|\/srv\/|handler \(/);
});

test("fetch exceptions are safe errors and never rotate the selected connection", async () => {
  const calls = mockFetch(() => {
    throw new Error("selected-openai-primary /srv/secret.ts:4:5 client-router-secret");
  });
  const response = await handleProviderResourceRequest(request(), openai, { kind: "file" });
  assert.equal(response.status, 502);
  assert.equal(calls.length, 1);
  assert.doesNotMatch(await response.text(), /selected-openai-primary|client-router-secret|\/srv/);
});

test("client cancellation aborts the in-flight upstream request", async () => {
  const controller = new AbortController();
  let capturedSignal: AbortSignal | undefined;
  const calls = mockFetch(
    (sent) =>
      new Promise<Response>((_resolve, reject) => {
        capturedSignal = sent.signal;
        sent.signal.addEventListener("abort", () => reject(sent.signal.reason), { once: true });
        controller.abort(new Error("private cancellation reason"));
      })
  );
  const incoming = new Request("http://localhost/v1/files", { signal: controller.signal });
  const response = await handleProviderResourceRequest(incoming, gemini, { kind: "file" });
  assert.equal(response.status, 499);
  assert.equal(calls.length, 1);
  assert.equal(capturedSignal?.aborted, true);
  assert.doesNotMatch(await response.text(), /private cancellation/);
});

test("already aborted requests do no upstream work and timeout errors are distinguished", async () => {
  const calls = mockFetch(() => {
    throw new DOMException("private timeout detail", "TimeoutError");
  });
  const aborted = new Request("http://localhost/v1/files", { signal: AbortSignal.abort() });
  assert.equal(
    (await handleProviderResourceRequest(aborted, gemini, { kind: "file" })).status,
    499
  );
  assert.equal(calls.length, 0);
  const timedOut = await handleProviderResourceRequest(request(), gemini, { kind: "file" });
  assert.equal(timedOut.status, 504);
  assert.doesNotMatch(await timedOut.text(), /private timeout detail/);
});

test("cancellation at response arrival cannot turn into a successful resource response", async () => {
  const controller = new AbortController();
  mockFetch(() => {
    controller.abort();
    return json(nativeFile);
  });
  const response = await handleProviderResourceRequest(
    new Request("http://localhost/v1/files", { signal: controller.signal }),
    openai,
    { kind: "file", id: "file-native123" }
  );
  assert.equal(response.status, 499);
});

test("upstream error text and response headers cannot disclose an encoded selected key", async () => {
  const context = { ...openai, apiKey: "fixture+token/secret=" };
  mockFetch(() =>
    json({ error: { message: "Rejected fixture%2Btoken%2Fsecret%3D" } }, 403, {
      "x-request-id": "fixture%2btoken%2fsecret%3d",
    })
  );
  const response = await handleProviderResourceRequest(request(), context, { kind: "file" });
  assert.equal(response.status, 403);
  assert.doesNotMatch(await response.text(), /fixture|secret/);
  assert.doesNotMatch(response.headers.get("x-request-id") || "", /fixture|secret/);
});

test("rejected resumable initiation closes its response body without sending upload bytes", async () => {
  let cancelled = false;
  const calls = mockFetch(
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "x-goog-upload-url": "https://attacker.example/upload" } }
      )
  );
  const response = await handleProviderResourceRequest(request("POST", "", upload()), gemini, {
    kind: "file",
  });
  assert.equal(response.status, 502);
  assert.equal(calls.length, 1);
  assert.equal(cancelled, true);
});

test("cancelled download bodies close the upstream stream without exposing upstream exceptions", async () => {
  let cancelled = false;
  mockFetch(
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            cancelled = true;
          },
        })
      )
  );
  const response = await handleProviderResourceRequest(request(), openai, {
    kind: "file",
    id: "file-native123",
    content: true,
  });
  await response.body?.cancel();
  assert.equal(cancelled, true);

  mockFetch(
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new Error("selected-openai-primary /srv/private.ts"));
          },
        })
      )
  );
  const broken = await handleProviderResourceRequest(request(), openai, {
    kind: "file",
    id: "file-native123",
    content: true,
  });
  await assert.rejects(broken.text(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message, /selected-openai-primary|\/srv/);
    return true;
  });
});
