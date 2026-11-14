import { z } from "zod";
import { buildErrorBody, sanitizeErrorMessage } from "../utils/error.ts";

export type ProviderResourceContext = {
  provider: "openai" | "gemini";
  apiKey: string;
  connectionId: string;
  providerSpecificData: Record<string, unknown>;
};

export type ProviderResourceOperation = {
  kind: "file" | "cache";
  id?: string;
  content?: boolean;
};

const OPENAI_ORIGIN = "https://api.openai.com";
const GEMINI_ORIGIN = "https://generativelanguage.googleapis.com";
const GEMINI_UPLOAD_PATH = "/upload/v1beta/files";
const MAX_FILE_BYTES = 512 * 1024 * 1024;
const MAX_MULTIPART_BYTES = MAX_FILE_BYTES + 64 * 1024;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 120_000;

const contextSchema = z.object({
  provider: z.enum(["openai", "gemini"]),
  apiKey: z
    .string()
    .min(1)
    .max(8192)
    .regex(/^[\x21-\x7e]+$/),
  connectionId: z.string().min(1),
  providerSpecificData: z.record(z.string(), z.unknown()),
});
const operationSchema = z
  .object({
    kind: z.enum(["file", "cache"]),
    id: z.string().min(1).max(256).optional(),
    content: z.boolean().optional(),
  })
  .strict();
const purposeSchema = z.enum(["assistants", "batch", "fine-tune", "vision", "user_data", "evals"]);
const positiveInteger = z
  .string()
  .regex(/^[1-9]\d{0,4}$/)
  .refine((v) => Number(v) <= 10000);
const tokenSchema = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[\x20-\x7e]+$/);
const openaiListSchema = z
  .object({
    after: z
      .string()
      .regex(/^file-[A-Za-z0-9_-]{1,200}$/)
      .optional(),
    limit: positiveInteger.optional(),
    order: z.enum(["asc", "desc"]).optional(),
    purpose: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z_-]+$/)
      .optional(),
  })
  .strict();
const googleListSchema = z
  .object({
    pageSize: positiveInteger.optional(),
    pageToken: tokenSchema.optional(),
  })
  .strict();
const patchQuerySchema = z
  .object({ updateMask: z.enum(["ttl", "expireTime", "expire_time"]).optional() })
  .strict();
const emptyQuerySchema = z.object({}).strict();
const expiryFields = {
  ttl: z
    .string()
    .regex(/^\d{1,12}(?:\.\d{1,9})?s$/)
    .optional(),
  expireTime: z.string().datetime({ offset: true }).optional(),
};
const nativeObjectSchema = z.record(z.string(), z.unknown());
const cacheCreateSchema = z
  .object({
    model: z
      .string()
      .min(1)
      .max(256)
      .regex(/^(?:models\/)?[A-Za-z0-9_.:-]+$/),
    displayName: z.string().max(128).optional(),
    contents: z.array(nativeObjectSchema).optional(),
    systemInstruction: nativeObjectSchema.optional(),
    tools: z.array(nativeObjectSchema).optional(),
    toolConfig: nativeObjectSchema.optional(),
    ...expiryFields,
  })
  .strict()
  .refine((value) => !(value.ttl !== undefined && value.expireTime !== undefined));
const cachePatchSchema = z
  .object(expiryFields)
  .strict()
  .refine((value) => (value.ttl !== undefined) !== (value.expireTime !== undefined));

export class ResourceTransportError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

function failure(status: number, message: string, headers?: Headers): Response {
  const safeHeaders = new Headers(headers);
  safeHeaders.set("content-type", "application/json");
  return new Response(JSON.stringify(buildErrorBody(status, message)), {
    status,
    headers: safeHeaders,
  });
}

function parse<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ResourceTransportError(400, message);
  return result.data;
}

function resourceId(
  context: ProviderResourceContext,
  operation: ProviderResourceOperation
): string | undefined {
  if (operation.id === undefined) return undefined;
  let id: string;
  try {
    id = decodeURIComponent(operation.id);
  } catch {
    throw new ResourceTransportError(400, "Invalid provider resource id");
  }
  if (context.provider === "openai") {
    return parse(z.string().regex(/^file-[A-Za-z0-9_-]{1,200}$/), id, "Invalid OpenAI file id");
  }
  const prefix = operation.kind === "file" ? "files/" : "cachedContents/";
  if (id.startsWith(prefix)) id = id.slice(prefix.length);
  const schema =
    operation.kind === "file"
      ? z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/)
      : z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
  return parse(schema, id, "Invalid Gemini resource id");
}

function buildUrl(
  request: Request,
  context: ProviderResourceContext,
  operation: ProviderResourceOperation
): URL {
  if (operation.kind === "cache" && context.provider !== "gemini") {
    throw new ResourceTransportError(400, "Standalone cache resources are not supported by OpenAI");
  }
  if (operation.content && (context.provider !== "openai" || operation.kind !== "file")) {
    throw new ResourceTransportError(
      400,
      "File content download is not supported for this provider"
    );
  }
  const id = resourceId(context, operation);
  const allowedMethods = operation.content
    ? id
      ? ["GET"]
      : []
    : id
      ? operation.kind === "cache"
        ? ["GET", "PATCH", "DELETE"]
        : ["GET", "DELETE"]
      : ["GET", "POST"];
  if (!allowedMethods.includes(request.method)) {
    throw new ResourceTransportError(405, "Method is not supported for this provider resource");
  }
  const search = new URL(request.url).searchParams;
  const query: Record<string, string> = Object.create(null);
  for (const [key, value] of search) {
    if (Object.hasOwn(query, key))
      throw new ResourceTransportError(400, "Duplicate query parameter");
    query[key] = value;
  }
  const schema =
    request.method === "GET" && !id
      ? context.provider === "openai"
        ? openaiListSchema
        : googleListSchema
      : request.method === "PATCH" && operation.kind === "cache"
        ? patchQuerySchema
        : emptyQuerySchema;
  parse(schema, query, "Invalid provider resource query parameters");
  const origin = context.provider === "openai" ? OPENAI_ORIGIN : GEMINI_ORIGIN;
  const version = context.provider === "openai" ? "v1" : "v1beta";
  const collection = operation.kind === "file" ? "files" : "cachedContents";
  const url = new URL(
    `/${version}/${collection}${id ? `/${id}` : ""}${operation.content ? "/content" : ""}`,
    origin
  );
  url.search = search.toString();
  return url;
}

function authenticationHeaders(context: ProviderResourceContext): Headers {
  const headers = new Headers();
  if (context.provider === "gemini") {
    headers.set("x-goog-api-key", context.apiKey);
    return headers;
  }
  headers.set("authorization", `Bearer ${context.apiKey}`);
  // customHeaders is the existing connection configuration; no arbitrary custom
  // auth, host, base URL or caller routing header may override this transport.
  let customHeaders = context.providerSpecificData.customHeaders;
  if (typeof customHeaders === "string") {
    try {
      customHeaders = JSON.parse(customHeaders);
    } catch {
      throw new ResourceTransportError(500, "Invalid provider header configuration");
    }
  }
  if (customHeaders && typeof customHeaders === "object" && !Array.isArray(customHeaders)) {
    for (const [name, value] of Object.entries(customHeaders)) {
      const normalized = name.toLowerCase();
      if (normalized !== "openai-project" && normalized !== "openai-organization") continue;
      if (
        !z
          .string()
          .min(1)
          .max(256)
          .regex(/^[\x21-\x7e]+$/)
          .safeParse(value).success
      ) {
        throw new ResourceTransportError(
          500,
          "Invalid provider project or organization configuration"
        );
      }
      headers.set(normalized, value as string);
    }
  }
  return headers;
}

function deadline(requestSignal: AbortSignal) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(new DOMException("Request cancelled", "AbortError"));
  const timer = setTimeout(
    () => controller.abort(new DOMException("Provider request timed out", "TimeoutError")),
    REQUEST_TIMEOUT_MS
  );
  timer.unref?.();
  if (requestSignal.aborted) onAbort();
  else requestSignal.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      requestSignal.removeEventListener("abort", onAbort);
    },
  };
}

/** Bound incoming reads and retain cancellation/deadline until outgoing bodies finish. */
function guardedStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  limit: number,
  cleanup = () => {}
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let ended = false;
  let bytes = 0;
  let output: ReadableStreamDefaultController<Uint8Array>;
  const finish = () => {
    ended = true;
    signal.removeEventListener("abort", onAbort);
    cleanup();
  };
  const cancelReader = () => {
    void reader.cancel().catch(() => {});
  };
  const onAbort = () => {
    if (ended) return;
    finish();
    cancelReader();
    output.error(new DOMException("Provider request cancelled", "AbortError"));
  };
  return new ReadableStream({
    start(controller) {
      output = controller;
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    },
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (ended) return;
        if (chunk.done) {
          finish();
          controller.close();
          return;
        }
        bytes += chunk.value.byteLength;
        if (bytes > limit)
          throw new ResourceTransportError(413, "Provider resource body exceeds the allowed size");
        controller.enqueue(chunk.value);
      } catch (error) {
        if (ended) return;
        finish();
        cancelReader();
        controller.error(
          error instanceof ResourceTransportError
            ? error
            : new ResourceTransportError(502, "Provider resource body could not be read")
        );
      }
    },
    async cancel() {
      finish();
      await reader.cancel();
    },
  });
}

function requestBody(request: Request, signal: AbortSignal, limit: number): Response {
  const length = request.headers.get("content-length");
  if (length !== null) {
    const parsed = parse(z.string().regex(/^\d{1,16}$/), length, "Invalid Content-Length header");
    if (Number(parsed) > limit)
      throw new ResourceTransportError(413, "Provider resource body exceeds the allowed size");
  }
  return new Response(request.body ? guardedStream(request.body, signal, limit) : null, {
    headers: { "content-type": request.headers.get("content-type") || "" },
  });
}

async function parseUpload(
  request: Request,
  context: ProviderResourceContext,
  signal: AbortSignal
): Promise<{ file: File; form: FormData; displayName: string }> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data;")) {
    throw new ResourceTransportError(415, "File upload requires multipart/form-data");
  }
  const bounded = requestBody(request, signal, MAX_MULTIPART_BYTES);
  let form: FormData;
  try {
    form = await bounded.formData();
  } catch (error) {
    if (error instanceof ResourceTransportError || signal.aborted) throw error;
    throw new ResourceTransportError(400, "Invalid multipart file upload");
  }
  const fields: Record<string, FormDataEntryValue> = Object.create(null);
  for (const [name, value] of form) {
    if (Object.hasOwn(fields, name))
      throw new ResourceTransportError(400, "Duplicate file upload field");
    fields[name] = value;
  }
  const fileSchema = z.instanceof(File);
  const schema =
    context.provider === "openai"
      ? z
          .object({
            file: fileSchema,
            purpose: purposeSchema,
            "expires_after[anchor]": z.literal("created_at").optional(),
            "expires_after[seconds]": z
              .string()
              .regex(/^\d{1,8}$/)
              .refine((v) => Number(v) >= 3600 && Number(v) <= 2592000)
              .optional(),
          })
          .strict()
          .refine(
            (v) =>
              (v["expires_after[anchor]"] !== undefined) ===
              (v["expires_after[seconds]"] !== undefined)
          )
      : z.object({ file: fileSchema, display_name: z.string().max(512).optional() }).strict();
  if (!schema.safeParse(fields).success)
    throw new ResourceTransportError(400, "Invalid provider file upload fields");
  const file = fields.file as File;
  if (file.size > MAX_FILE_BYTES)
    throw new ResourceTransportError(413, "File exceeds maximum allowed size of 512 MiB");
  return {
    file,
    form,
    displayName: typeof fields.display_name === "string" ? fields.display_name : file.name,
  };
}

async function parseCacheValue(
  request: Request,
  signal: AbortSignal
): Promise<Record<string, unknown>> {
  if (
    request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json"
  ) {
    throw new ResourceTransportError(415, "Cache operations require application/json");
  }
  const bounded = requestBody(request, signal, MAX_JSON_BYTES);
  let body: unknown;
  try {
    body = await bounded.json();
  } catch (error) {
    if (error instanceof ResourceTransportError || signal.aborted) throw error;
    throw new ResourceTransportError(400, "Invalid cache JSON body");
  }
  const value = parse(
    request.method === "PATCH" ? cachePatchSchema : cacheCreateSchema,
    body,
    "Invalid cache payload; only cache expiration can be updated"
  );
  const mask = new URL(request.url).searchParams.get("updateMask");
  if (mask && (mask === "ttl") !== (value.ttl !== undefined)) {
    throw new ResourceTransportError(400, "Cache updateMask does not match the expiration field");
  }
  return value;
}

/** Read once, with the same size/schema/cancellation guards used by transport. */
export async function readProviderResourceCacheBody(
  request: Request
): Promise<Record<string, unknown>> {
  const lifetime = deadline(request.signal);
  try {
    lifetime.signal.throwIfAborted();
    return await parseCacheValue(request, lifetime.signal);
  } catch (error) {
    if (lifetime.signal.reason?.name === "TimeoutError")
      throw new ResourceTransportError(504, "Provider resource request timed out");
    if (request.signal.aborted)
      throw new ResourceTransportError(499, "Provider resource request cancelled");
    throw error;
  } finally {
    lifetime.cleanup();
  }
}

function uploadUrl(value: string | null): URL {
  let url: URL;
  try {
    url = new URL(value || "");
  } catch {
    throw new ResourceTransportError(502, "Provider returned an invalid upload URL");
  }
  if (
    url.origin !== GEMINI_ORIGIN ||
    url.username ||
    url.password ||
    url.hash ||
    url.pathname.length > 2048 ||
    !/^\/upload\/v1beta\/files(?:\/[A-Za-z0-9_-]{1,256}){0,8}$/.test(url.pathname)
  ) {
    throw new ResourceTransportError(502, "Provider returned an invalid upload URL");
  }
  return url;
}

async function send(
  url: URL,
  method: string,
  headers: Headers,
  body: BodyInit | undefined,
  signal: AbortSignal
): Promise<Response> {
  signal.throwIfAborted();
  // global fetch is the existing proxy-aware transport; the app wrapper supplies
  // its connection-specific network context. This handler never selects a key.
  const response = await fetch(url, { method, headers, body, signal, redirect: "manual" });
  if (signal.aborted) {
    await response.body?.cancel();
    signal.throwIfAborted();
  }
  if (response.redirected || (response.status >= 300 && response.status < 400)) {
    await response.body?.cancel();
    throw new ResourceTransportError(502, "Provider redirects are not supported");
  }
  return response;
}

function redactCredential(value: string, context: ProviderResourceContext): string {
  const encoded = encodeURIComponent(context.apiKey);
  const encodedLowerHex = encoded.replace(/%[A-F0-9]{2}/g, (part) => part.toLowerCase());
  let redacted = value;
  for (const credential of new Set([context.apiKey, encoded, encodedLowerHex])) {
    redacted = redacted.replaceAll(credential, "[REDACTED]");
  }
  return redacted;
}

function responseHeaders(response: Response, context: ProviderResourceContext): Headers {
  const headers = new Headers();
  for (const name of [
    "content-type",
    "content-disposition",
    "x-request-id",
    "x-goog-request-id",
    "retry-after",
  ]) {
    const value = response.headers.get(name);
    if (value !== null) headers.set(name, redactCredential(value, context));
  }
  return headers;
}

async function upstreamError(
  response: Response,
  context: ProviderResourceContext,
  signal: AbortSignal
): Promise<Response> {
  let text = "";
  try {
    if (response.body)
      text = await new Response(guardedStream(response.body, signal, MAX_ERROR_BYTES)).text();
  } catch {
    signal.throwIfAborted();
  }
  let message = text;
  try {
    const body = JSON.parse(text);
    message =
      typeof body?.error?.message === "string"
        ? body.error.message
        : typeof body?.message === "string"
          ? body.message
          : "Provider resource request failed";
  } catch {
    // Plain-text upstream errors still pass the same public sanitization boundary.
  }
  return failure(
    response.status,
    sanitizeErrorMessage(redactCredential(message, context)) || "Provider resource request failed",
    responseHeaders(response, context)
  );
}

export async function handleProviderResourceRequest(
  request: Request,
  context: ProviderResourceContext,
  operation: ProviderResourceOperation
): Promise<Response> {
  const lifetime = deadline(request.signal);
  let streaming = false;
  try {
    lifetime.signal.throwIfAborted();
    if (!contextSchema.safeParse(context).success)
      throw new ResourceTransportError(500, "Invalid provider resource connection configuration");
    parse(operationSchema, operation, "Invalid provider resource operation");
    const url = buildUrl(request, context, operation);
    const headers = authenticationHeaders(context);
    let body: BodyInit | undefined;
    let upstream: Response;
    if (request.method === "POST" && operation.kind === "file") {
      const uploaded = await parseUpload(request, context, lifetime.signal);
      if (context.provider === "gemini") {
        headers.set("content-type", "application/json");
        headers.set("x-goog-upload-protocol", "resumable");
        headers.set("x-goog-upload-command", "start");
        headers.set("x-goog-upload-header-content-length", String(uploaded.file.size));
        headers.set(
          "x-goog-upload-header-content-type",
          uploaded.file.type || "application/octet-stream"
        );
        const start = await send(
          new URL(GEMINI_UPLOAD_PATH, GEMINI_ORIGIN),
          "POST",
          headers,
          JSON.stringify({ file: { displayName: uploaded.displayName } }),
          lifetime.signal
        );
        if (!start.ok) return await upstreamError(start, context, lifetime.signal);
        const location = start.headers.get("x-goog-upload-url");
        await start.body?.cancel();
        const destination = uploadUrl(location);
        const finalizeHeaders = authenticationHeaders(context);
        finalizeHeaders.set("content-type", uploaded.file.type || "application/octet-stream");
        finalizeHeaders.set("content-length", String(uploaded.file.size));
        finalizeHeaders.set("x-goog-upload-offset", "0");
        finalizeHeaders.set("x-goog-upload-command", "upload, finalize");
        upstream = await send(destination, "POST", finalizeHeaders, uploaded.file, lifetime.signal);
      } else {
        upstream = await send(url, request.method, headers, uploaded.form, lifetime.signal);
      }
    } else {
      if (operation.kind === "cache" && (request.method === "POST" || request.method === "PATCH")) {
        body = JSON.stringify(await parseCacheValue(request, lifetime.signal));
        headers.set("content-type", "application/json");
      }
      upstream = await send(url, request.method, headers, body, lifetime.signal);
    }
    if (!upstream.ok) return await upstreamError(upstream, context, lifetime.signal);
    const response = new Response(
      upstream.body
        ? guardedStream(
            upstream.body,
            lifetime.signal,
            operation.content ? MAX_FILE_BYTES : MAX_JSON_BYTES,
            lifetime.cleanup
          )
        : null,
      {
        status: upstream.status,
        headers: responseHeaders(upstream, context),
      }
    );
    streaming = upstream.body !== null;
    return response;
  } catch (error) {
    if (
      request.signal.reason?.name === "TimeoutError" ||
      lifetime.signal.reason?.name === "TimeoutError" ||
      (error instanceof Error && error.name === "TimeoutError")
    )
      return failure(504, "Provider resource request timed out");
    if (request.signal.aborted) return failure(499, "Provider resource request cancelled");
    if (error instanceof ResourceTransportError) return failure(error.status, error.message);
    return failure(502, "Provider resource request failed");
  } finally {
    if (!streaming) lifetime.cleanup();
  }
}
