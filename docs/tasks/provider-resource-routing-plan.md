# Provider resource routing implementation plan

> **For agentic workers:** Use the executing-plans workflow for coordination and focused parallel implementation for independent modules. Steps use checkbox syntax for tracking; every checkpoint is committed and published to PR #4.

**Goal:** Route explicitly selected native files, caches and continuation to one deterministic provider API-key connection.

**Architecture:** A shared selector resolves a provider/index to a stable connection. App routes enforce existing authorization and metadata ownership, while an engine handler performs fixed-origin native HTTP. Inference consumes the same selector and strict account constraint.

**Tech Stack:** Existing Next.js/TypeScript, Zod, SQLite, Node native tests, existing Docker Actions workflow.

**Spec:** `docs/tasks/provider-resource-routing-design.md`

## Global constraints

- Base is custom v3.8.53 commit `ce57802a69b8`; preserve Terra/Cmd+K and reporting retirement.
- Provider opt-in defaults to zero; unchanged behavior without new selectors.
- Only native `openai` and `gemini` API-key connections; `google` aliases `gemini`.
- Use primary key only and retain strict connection identity through failures and retries.
- Never bypass existing auth, endpoint/model, connection/quota or ownership policy.
- No live provider credentials; tests replace outbound HTTP with fixtures.
- No merging or operator-server deployment. Publish only the separate feature channel after verification.

## Review focus

1. A disabled or unauthorized index zero must fail, not select the next key (Task 1).
2. Account order changes after upload must not redirect stable-id followups (Tasks 1, 3).
3. Existing auth/quota bypasses on alternate key-header transports must stay closed (Task 3).
4. Inference fast paths, session affinity and executor extra keys must not override the selected account (Task 4).
5. Native upload error/redirect bodies must not leak credentials or create an untracked successful resource (Tasks 2, 3).

## Task 1: Deterministic selector

**Files:** create `src/sse/services/providerResourceRouting.ts`; test `tests/unit/provider-resource-routing.test.ts`.

**Interfaces:** `parseProviderRoutingHeaders(headers: Headers): ProviderRoutingSelection | null`; `resolveProviderRoutingSelection(selection, apiKeyInfo): Promise<ResolvedProviderRouting>`; `ProviderRoutingError` carries status and safe message. Resolved value includes provider, keyIndex, connectionId, primary apiKey and providerSpecificData. Existing connection-only requests return null from the new parser.

- [ ] Add failing tests for no selector, default zero, explicit index, aliases, invalid/overflow indices, index without provider, disabled row, scope denial, tie ordering, stable-id selection and conflicts.
- [ ] Run the tests and record expected failures.
- [ ] Implement validation and deterministic ordering against provider DB domain APIs, then key/quota scope enforcement.
- [ ] Run focused tests, lint/type checks and commit the passing selector.

## Task 2: Native transport

**Files:** create `open-sse/handlers/providerResources.ts`; test `tests/unit/provider-resource-transport.test.ts`.

**Interfaces:** export `handleProviderResourceRequest(request, context, operation): Promise<Response>`. Context contains provider, primary apiKey, connectionId and providerSpecificData; operation identifies resource kind (`file`/`cache`), optional id and content mode. The app wrapper supplies configured network proxy context; this handler owns native serialization, not DB/auth.

- [ ] Add and observe failing serialized-request tests for OpenAI multipart, Gemini resumable upload, native file/cache CRUD, index-independent fixed credentials, invalid paths/queries, abort and sanitized errors.
- [ ] Implement official fixed-origin requests, 512 MiB gateway upload cap, validated resumable URL and no redirect following.
- [ ] Preserve upstream success metadata/status; reject OpenAI standalone cache and Gemini file content download.
- [ ] Verify fixtures and commit transport checkpoint.

## Task 3: Resource ownership and API routes

**Files:** create `src/lib/db/providerResources.ts`, migration `226_provider_resources.sql`, `src/app/api/v1/_helpers/providerResources.ts`, cache collection/item routes; modify existing three file routes, CORS helpers and endpoint category mappings; tests under `tests/unit/provider-resource-*.test.ts`.

**Interfaces:** metadata binding helpers record/lookup/remove by provider, connection, kind/id; app handler `tryHandleProviderResourceRequest(request, operation)` returns null only for unchanged legacy file requests. Shared inference reference authorization checks the same owner/connection binding.

- [ ] Add and observe failing tests for route dispatch, upload binding, restart persistence, same/foreign owner reads/deletes, scoped lists, cache metadata, rejected auth/policies and no-selector legacy storage.
- [ ] Implement metadata-only ownership and route wrapper with existing policy/scope helpers.
- [ ] Wire file opt-in and Gemini cachedContents routes; apply CORS allow/expose headers and endpoint categories.
- [ ] Test real handlers with disposable DB and fake HTTP; commit passing route checkpoint.

## Task 4: Strict inference continuation

**Files:** existing `src/sse/handlers/chat.ts`, Responses route preference helper and smallest native request/translation helpers identified by tests; tests `tests/unit/provider-resource-inference.test.ts` and related native-file/cache contracts.

**Interfaces:** consumes Task 1 selector and Task 3 resource authorization. Pass `forcedConnectionId` plus a singleton allowed-connection intersection; use fixed primary request-local credentials. Preserve native OpenAI Responses file ids and Gemini cachedContent/fileData.

- [ ] Add failing dispatch tests for upload-selected account reuse, missing index default, conflicting models, strict failures with another healthy key available, extra-key/session-affinity bypass, Responses file ids and Gemini cache URI.
- [ ] Implement shared selector integration after auth/policy and before provider/fast-path dispatch, retaining all existing restrictions.
- [ ] Verify no-selector controls and existing Terra request behavior; commit inference checkpoint.

## Task 5: Verification and image

**Files:** `docs/tasks/provider-file-cache-routing.md`, user API guide, `.github/workflows/docker-provider-resources.yml` derived from the existing custom-image workflow.

- [ ] Run focused native tests and existing custom regressions, applicable core types, scoped lint/format and docs gates; distinguish inherited failures.
- [ ] Request fresh whole-change review; fix material findings with reproducing tests and commit.
- [ ] Gate a separate provider-resources image channel on regressions, both native architectures, startup and disposable-volume restart checks.
- [ ] Commit/publish workflow, observe completion, verify immutable tag/manifest/source labels and record evidence in PR and work log.

## Task 6: Relayhub integration, after backend completion

**Files:** determined from the then-current `atezsoftware/relayhub` `test/v1` branch; start with its own committed task ledger and draft PR before implementation.

- [ ] Record the concrete Omni image/API contract in both PRs.
- [ ] Reuse existing App Settings and execution surfaces where possible; resource routing is opt-in.
- [ ] Add account-scoped file/cache resource lifecycle and continuation integration, with fixture tests proving cleanup and no cross-account reuse.
- [ ] Commit each research/test/code checkpoint and verify the appropriate types/tests.
- [ ] Cross-link final PRs, immutable image and remaining verification limits; retain resumable next steps.
