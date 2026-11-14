# Provider resource routing design

## Intent and baseline

Add opt-in native provider file and explicit cache operations to the existing custom v3.8.53 fork. The user requested the initial PR before implementation, frequent committed checkpoints, a verified image, then a Relayhub integration PR. PR #4 is open; its base is `ce57802a69b8f2669f7ce946847c5bb406b7d79e` from PR #3. Preserve that branch's existing custom fixes.

## Decisions

The implementation uses headers so the same selector works with multipart upload, JSON, resource reads/deletes and model requests:

- `X-OmniRoute-Provider`: `openai` or `gemini`; accept `google` as a documented alias for `gemini`.
- `X-OmniRoute-Key-Index`: optional nonnegative integer, defaults to `0` when provider is supplied.
- Existing `X-OmniRoute-Connection`: optional stable connection identity returned by an earlier request. With provider and no explicit index it selects that identity. With an explicit index both must resolve to the same connection.
- Existing `X-OmniRoute-Selected-Connection-Id`: returned stable identity. Also return canonical provider and selected index in response headers.

Index is the position among the provider's API-key connection rows, ordered by ascending priority, then creation time, then id. Include inactive rows in this ordering and reject selection of one; silently removing a disabled row must not move index zero to another account. Extra keys nested in a connection are not indexed: the selected connection's primary API key is used. No round robin, sibling retry, combo fallback, extra-key rotation or session-affinity override may replace explicit selection. API key connection/quota/model/endpoint restrictions still apply; resolving an index happens before checking permission so a restricted caller cannot reinterpret the same index as a different account.

No selector preserves the existing local file behavior and inference routing. An index without a provider is invalid. Existing connection-only inference behavior remains unchanged. Unsupported providers/capabilities fail explicitly. This is a builder decision within the user's delegated API design scope.

## Approaches considered

1. Headers plus existing resource paths (selected): works for every HTTP method and keeps provider payloads unchanged; requires CORS and strict account affinity checks.
2. Router fields inside request bodies: convenient for JSON, but requires a second contract for multipart/GET/DELETE and risks fields reaching providers.
3. A provider-specific generic URL proxy: simpler passthrough but creates a much wider API/security surface and does not preserve existing policy semantics.

## Endpoints and provider capabilities

- `/v1/files`: without provider, existing local storage. With provider, native upload/list. OpenAI uses multipart and returns its native file object. Gemini accepts multipart `file` plus optional `display_name`, performs the documented resumable upload, and returns the native `{file: ...}` envelope with name, URI, processing state and expiration.
- `/v1/files/{id}`: selected native read/delete; Gemini accepts the short id or percent-encoded `files/{id}`. `/content` is supported only for OpenAI. Query parameters are allowlisted per provider.
- `/v1/cachedContents` and `/v1/cachedContents/{id}`: Gemini native create/list/get/expiry-patch/delete with the same selector. Provider is required. OpenAI returns a clear unsupported-capability response; it has no equivalent independently addressable cache resource.
- Existing `/v1/chat/completions` and `/v1/responses`: selected provider/index resolve to a strict existing connection pin, with fixed primary credentials. Native OpenAI file-id requests require true Responses passthrough rather than Chat conversion. Gemini chat requests preserve `cachedContent` and file URI parts; native Gemini generation conversion must preserve those fields if used.
- OpenAI prompt-cache controls remain request-level controls. No synthetic cache id or promise of a cache hit is introduced. Cache model/version support and minimum token checks are ultimately upstream decisions.

## Ownership, authentication and transport

Run existing client authentication, endpoint policy, connection/quota restrictions and resource ownership checks before outbound work. A new metadata-only SQLite binding records provider, connection id, resource kind/id and owning OmniRoute API key. Resource ids remain native; no raw file bytes or credential is stored in this table. Reads/deletes and lists enforce the existing per-key/session management ownership rules. Resource references in selected inference must belong to the caller and selected connection. Resource creation cannot expose an unrecorded id as successful if binding persistence fails.

Native HTTP goes through the existing configured network proxy path for the chosen connection. Only official OpenAI/Gemini origins are supported; never accept a client-supplied upstream URL. Validate the Gemini resumable URL before sending credentials or file bytes, reject redirects, propagate abort/timeout and sanitize error messages. Preserve relevant upstream HTTP status and success identifiers. No paid live generation is needed for regression tests.

## Continuation and Relayhub

Relayhub currently uses Vertex service accounts/GCS for its Google runtime; its Omni runtime sends inline files to Chat and already uses explicit OpenAI prompt-cache controls for supported continuation. These are separate mechanisms. A new Omni resource mode must retain provider, stable connection id, native file/cache identifiers, expiry and cleanup across passes. Resource reuse keys must include the provider/account; no cache may be reused after routing to another account. Keep existing modes available. The Relayhub implementation PR begins only after the Omni backend is implemented and verified, from the then-current `test/v1` head.

## Verification and release

Tests cover selector validation/default/index ordering, inactive/forbidden credentials, conflicting stable pin, actual serialized HTTP upload/cache payloads, ownership, failures, account affinity and legacy behavior. Preserve and run the existing Terra/Cmd+K focused tests. Run applicable types/lint/docs gates and record any inherited failure separately. A fresh reviewer checks the complete change. Publish a separate feature image channel plus immutable SHA tag for amd64/arm64, gate aliases on tests/startup/volume reuse, and record the manifest digest. Existing image channels are not silently advanced. No production deployment or PR merge is requested.

## Primary research sources

- https://developers.openai.com/api/reference/resources/files/methods/create
- https://developers.openai.com/api/docs/guides/file-inputs
- https://developers.openai.com/api/docs/guides/prompt-caching
- https://developers.openai.com/api/docs/guides/conversation-state
- https://aistudio.google.com/docs/files
- https://aistudio.google.com/api-reference/files
- https://aistudio.google.com/api-reference/caching
- https://aistudio.google.com/api-reference/generate-content/generate-content

Research was checked on 2026-11-14. Native file/cache resources are project/account scoped; prompt caching, response continuation and explicit cachedContents are distinct contracts. Provider-side limits and support can change.
