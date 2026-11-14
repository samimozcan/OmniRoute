# Native provider files, caches and continuation

This fork adds explicit account routing on top of the existing v3.8.53 behavior. The feature is opt-in per request. Its work log and release evidence are in `provider-file-cache-routing.md`; image publication is recorded there only after it succeeds.

## Select an account

| Header                         | Meaning                                                                                             |
| ------------------------------ | --------------------------------------------------------------------------------------------------- |
| `X-OmniRoute-Provider: openai` | Native OpenAI API-key connection                                                                    |
| `X-OmniRoute-Provider: gemini` | Native Gemini Developer API-key connection; `google` is an alias                                    |
| `X-OmniRoute-Key-Index: 1`     | Optional zero-based API-key connection position; omitted means `0`                                  |
| `X-OmniRoute-Connection: <id>` | Stable connection returned by an earlier request; use this for the rest of that resource's lifetime |

The response exposes `X-OmniRoute-Provider`, `X-OmniRoute-Key-Index` and `X-OmniRoute-Selected-Connection-Id`. These are connection metadata, never provider credentials. Authenticate with the usual **OmniRoute client key**; upstream keys stay in the router.

Positions sort native API-key connection rows by ascending priority, creation time and id. Disabled rows retain their position and fail if selected. OAuth accounts and nested extra API keys are not part of this index. A selected request uses the connection's primary key and cannot silently rotate to another connection or extra key. It uses the native provider executor and preserves the exact native model; background downgrades are skipped and conflicting aliases, payload rules or recovery model changes are rejected. Transport proxy settings still apply. Existing model, quota, endpoint and connection permissions still apply.

Once a resource exists, keep the provider and returned stable connection id; omit the index on follow-ups. If both an index and stable id are supplied, they must agree. Reordering a connection then cannot redirect an existing resource to another account. Deleting/replacing the actual credential can still invalidate upstream access.

## OpenAI file upload and Responses

Upload with multipart `file` and a valid native `purpose`:

```bash
curl -sS -D upload-headers.txt "$OMNI_BASE/v1/files" \
  -H "Authorization: Bearer $OMNI_KEY" \
  -H "X-OmniRoute-Provider: openai" \
  -F "purpose=user_data" \
  -F "file=@invoice.pdf;type=application/pdf"
```

The JSON response is OpenAI's native file object, including its `file-...` id. The primary connection at index zero is selected because no index was supplied. A gateway upload cap of 512 MiB applies; provider/model input limits may be lower.

Use that id with the same provider and selected connection on `/v1/responses`:

```json
{
  "model": "openai/gpt-6.1-terra",
  "input": [
    {
      "role": "user",
      "content": [
        { "type": "input_file", "file_id": "file-RETURNED_ID" },
        { "type": "input_text", "text": "Extract the invoice items." }
      ]
    }
  ]
}
```

Select a model actually enabled on your OpenAI account; the model above illustrates the fork's existing Terra naming. The selected `/responses` path keeps native Responses semantics and does not reroute to Codex. `previous_response_id` and prompt cache controls are separate from the uploaded file id. Supported prompt cache parameters stay on inference requests; they do not create a standalone cache resource through `/v1/cachedContents`.

Read metadata using `GET /v1/files/{id}`, download OpenAI bytes with `GET /v1/files/{id}/content`, and delete with `DELETE /v1/files/{id}`. Repeat the provider and stable connection headers. Without a provider header, `/v1/files` continues to address the existing local file store.

## Gemini files and explicit caches

Upload a Gemini file through the same multipart endpoint:

```bash
curl -sS -D upload-headers.txt "$OMNI_BASE/v1/files" \
  -H "Authorization: Bearer $OMNI_KEY" \
  -H "X-OmniRoute-Provider: gemini" \
  -H "X-OmniRoute-Key-Index: 0" \
  -F "file=@invoice.pdf;type=application/pdf" \
  -F "display_name=invoice.pdf"
```

The router performs the native resumable upload. The response preserves Google's `{ "file": ... }` envelope: keep `file.name`, `file.uri`, `file.mimeType`, `file.state` and expiration metadata. If the state is `PROCESSING`, poll `GET /v1/files/{short-id}` on the same connection until `ACTIVE`; stop on `FAILED`. Gemini does not support downloading uploaded file bytes through this API.

Create a cache with `POST /v1/cachedContents`, JSON content type, provider `gemini` and the stable connection header:

```json
{
  "model": "models/gemini-2.5-flash",
  "contents": [
    {
      "role": "user",
      "parts": [
        {
          "fileData": {
            "fileUri": "https://generativelanguage.googleapis.com/v1beta/files/RETURNED_ID",
            "mimeType": "application/pdf"
          }
        }
      ]
    }
  ],
  "systemInstruction": { "parts": [{ "text": "Extract invoice data accurately." }] },
  "ttl": "3600s"
}
```

Use the model for which the cache was created. Upstream model support, token thresholds and TTL limits remain authoritative; short documents or unsupported models can be rejected. The response's `name`, such as `cachedContents/...`, is the native cache identity.

For the existing Chat endpoint, carry the cache name as `cachedContent` and send only the new turn/history outside the cached prefix:

```json
{
  "model": "gemini/gemini-2.5-flash",
  "cachedContent": "cachedContents/RETURNED_ID",
  "messages": [{ "role": "user", "content": "Return the next invoice items." }]
}
```

For an uncached uploaded file in Chat content, use the native file URI and explicit MIME:

```json
{
  "type": "file",
  "file": {
    "file_id": "https://generativelanguage.googleapis.com/v1beta/files/RETURNED_ID",
    "mime_type": "application/pdf"
  }
}
```

Both forms require the same provider and stable connection as upload/cache creation. Do not resend a system instruction already embedded in the explicit cache. Native Gemini generation also retains fileData and cachedContent through its request conversion; ordinary conversation history is still the client's responsibility.

Use `GET /v1/cachedContents/{short-id}` for metadata, `PATCH` with exactly one of `ttl` or `expireTime` for expiry, and `DELETE` for cleanup. Cache contents are immutable. Delete cache first, then file, when the client no longer needs them. File/cache expiry is upstream-owned and must not be treated as permanent storage.

## Ownership and failure behavior

The gateway stores native ids and safe metadata with the creating OmniRoute key and provider connection. It does not store a second copy of uploaded bytes or cached prompt contents. A resource created outside these routed endpoints is not automatically registered. This registry authorizes direct file/cache attachments, including native OpenAI image, screenshot, image mask, Code Interpreter and shell file inputs. It does not establish ownership for separate response, conversation, container or vector-store ids, or for replayed output-only citation/search-result metadata. Lists expose only registered resources accessible to the caller. OpenAI listing crosses pages containing only hidden resources internally; repeated cursors or more than 25 hidden pages produce a safe error instead of exposing another caller's id. A listing scan has one 120-second deadline. Management/session access follows the existing gateway ownership rules.

Invalid selector/index, conflicting stable id or unsupported capability returns a client error. Forbidden connection/model/endpoint returns a policy rejection; missing, foreign or wrong-account resources return 404. A disabled/missing primary key fails instead of selecting a sibling. Upstream failures retain an appropriate status with sanitized errors. Assigned-proxy failures never silently opt into a different account.

Cache JSON input and provider JSON responses are capped at 16 MiB. Input parsing and each resource transport have a 120-second deadline and honor cancellation. File uploads/downloads are capped at 512 MiB.

Resource creation is not an idempotency guarantee. Repeating a POST after an ambiguous transport failure may create a second upstream object. Clients should coordinate one create per logical resource, retain returned ids and expiry, and clean up known resources. A metadata persistence failure never returns a successful unregistered id.

## Relayhub integration boundary

Relayhub's existing Vertex/GCS cache and Omni Chat prefix caching remain separate from this new resource lifecycle. The follow-up integration must persist provider/connection/file/cache identity, scope reuse keys to the account/model, retain expiry/cleanup through queue retries and keep actual provider usage accounting. The OmniRoute PR links that work only after the backend verification gate is complete.
