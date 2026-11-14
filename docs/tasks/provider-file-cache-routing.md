# Provider-selected files and cache routing — work log

## Current status — 2026-11-14

OmniRoute implementation and source review are complete. The published immutable image passed native amd64/arm64 startup, manifest/source identity, endpoint and resource-binding/volume-reuse checks in [verification run 43644599870](https://github.com/samimozcan/OmniRoute/actions/runs/43644599870). The image source is `3ef1bf674c9f3426fdf726a183d7ad4c4c973faf`; later commits contain verification and documentation only.

The requested RelayHub follow-up has started in [draft PR #318](https://github.com/atezsoftware/relayhub/pull/318). Its first commit contains the durable contract and step-by-step implementation/test plan. RelayHub runtime integration is not yet implemented or enabled. Continue that implementation from its PR ledger; no live provider usage, production deployment or merge is claimed here.

## Request and sequencing

The owner requested this work on 2026-11-14: first open an OmniRoute fork PR, record research and all implementation checkpoints as commits, build a new Docker image, then start a separate Relayhub integration PR after the backend is complete. Keep both PRs linked so another session can resume without chat history.

## Confirmed baseline

- Repository: samimozcan/OmniRoute.
- Base branch: feat/v3.8.53-terra-cmdk.
- Base commit: ce57802a69b8f2669f7ce946847c5bb406b7d79e.
- Existing PR: https://github.com/samimozcan/OmniRoute/pull/3.
- Verified previous image reference in PR #3: ghcr.io/samimozcan/omniroute:3.8.53-terra-cmdk-ce57802a69b8.
- Preserve the Terra reasoning normalization, optional Cmd+K ranking/search behavior, and removal of the retired Admin reporting customization.
- Use a dedicated branch and isolated worktree. Do not merge or deploy to the operator's server as part of this task.
- Relayhub repository: atezsoftware/relayhub; resolve the current test base before its implementation.
- The shared chat URL did not return content to the web reader. Prior context was recovered and checked against GitHub.
- Upstream base-red issue #19329 concerns release/v3.8.54, not the selected custom v3.8.53 base.

## Required behavior

- Explicit provider selection enables upstream file/cache routing.
- An omitted API key position defaults to zero when a provider is selected.
- Positions are zero-based, validated, deterministic, and scoped to the provider's API key connections.
- Return the provider's resource identifier without inventing a local replacement.
- File/cache continuation must use the same account/project as resource creation. Avoid silent rotation or cross-account fallback for pinned requests.
- Requests without this opt-in retain existing behavior.
- Unsupported providers or API capabilities produce clear errors. Do not pretend request-level OpenAI prompt caching is a standalone Google cachedContents resource.
- Do not expose provider secrets in responses, logs, documents, tests, or PRs.

## Ordered task ledger

- [x] Confirm the fork, custom baseline and existing image channel.
- [x] Create the dedicated branch and this initial checkpoint before implementation.
- [x] Open the draft PR with the complete initial task ledger: https://github.com/samimozcan/OmniRoute/pull/4.
- [x] Research current official OpenAI Files/Responses/prompt cache and Gemini Files/cachedContents contracts.
- [x] Read current resource routes, connection ordering, auth/policy, inference routing and fork publication workflow.
- [x] Commit a concrete design and implementation plan with exact files, contracts, index semantics and tests.
- [x] Add failing tests for opt-in selection, default index zero, explicit index, invalid index/provider, disabled credentials, auth and legacy behavior.
- [x] Implement deterministic account selection and stable connection identity for follow-up operations.
- [x] Implement supported upstream file lifecycle operations and return native identifiers.
- [x] Implement supported explicit cache lifecycle and continuation routing.
- [x] Verify inference account affinity, unsupported capabilities and error redaction.
- [x] Run focused regressions, existing fork tests, formatting/lint, relevant type checks and documentation gates; record baseline issues separately.
- [x] Independently review the change and resolve concrete findings.
- [x] Add/adapt the fork-only image workflow, build both supported architectures, and verify startup/volume-reuse and published manifests.
- [x] Record the immutable image tag, digest, source commit, successful workflow and rollback reference.
- [x] Only after the OmniRoute backend is complete: create the Relayhub PR from its current test base with its own initial task ledger.
- [ ] Continue implementation/testing of the narrow Relayhub integration in PR #318; its requested initial PR/contract checkpoint is complete.
- [x] Link Relayhub back here and record final status, outstanding limits and exact resume instructions.

## Design decisions to resolve in research

A shared HTTP-header selector is the initial implementation proposal because it works for multipart upload, JSON cache calls, GET/DELETE and inference without injecting router fields into provider payloads. The implemented names and supported endpoint mapping are specified in the committed design and API guide. Determine index ordering from the existing UI/database contract and return a stable connection identifier for reuse if account ordering changes.

OpenAI and Gemini have different cache APIs. Document their actual capabilities independently. Validate native file inputs through the intended inference endpoint; uploading alone does not establish continuation support.

## Validation and release boundaries

Use synthetic fixtures and mocked provider HTTP for deterministic tests. No production credentials or operator data have been accessed. This environment has no local Docker binary; use the existing authorized fork publication mechanism after checking its configuration. A successful source test is not evidence of a published image; a published image is not evidence that the operator's server was upgraded.

## Resume procedure

1. Read this log, the PR description, and the committed design/plan.
2. Check the remote head and working-tree status before editing; never touch another session's branch.
3. Start at the first unchecked task. Record the command and observed result for each validation.
4. Commit and publish each meaningful checkpoint. Keep PR status consistent with observed evidence.
5. Do not open the Relayhub implementation PR until the OmniRoute backend gate above has passed.

## Checkpoints

- 2026-11-14: Baseline and initial task ledger recorded. Implementation, tests and image publication have not started.

- 2026-11-14: Research and API contract recorded in `provider-resource-routing-design.md`; implementation steps in `provider-resource-routing-plan.md`. Ruling: these documents live in tracked `docs/tasks/` because the repository ignores `docs/superpowers/` and the owner requires resumable committed history. Initial plan was created through the authenticated GitHub connector; subsequent implementation checkpoints run local hooks before connector publication.

- 2026-11-14: Baseline focused file-scope and connection-pin tests passed (25/25). Selector tests first failed because the new module was absent, then passed 8/8 after implementation. Covered default zero, explicit/stable selection, deterministic ordering, invalid selectors, health/scope failures and request-local extra-key removal. Commands: `node --import tsx/esm --import ./open-sse/utils/setupPolyfill.ts --import ./tests/_setup/isolateDataDir.ts --test --test-force-exit tests/unit/files-batches-list-header-scope-14481.test.ts tests/unit/pinned-connection-no-rotation.test.ts`; `node --import tsx/esm --import ./tests/_setup/isolateDataDir.ts --test --test-force-exit tests/unit/provider-resource-routing.test.ts`. Resource routes and inference are still being implemented.

- 2026-11-14: Metadata-only resource registry and owner checks implemented. Native IDs are preserved, binding owner is immutable, metadata omits document contents and credentials. New ownership tests passed 20/20; with existing file/key-scope ownership regressions, 62/62 passed. Added canonical URI validation, Gemini Chat file carriers, and bounded structural reference inspection. Scoped ESLint/Prettier and diff checks passed. Registry and authorization are a separate checkpoint; endpoint/inference integration is still in progress.

- 2026-11-14: Native OpenAI/Gemini file and Gemini cache transport implemented; 21/21 transport tests passed after observed RED/GREEN cycles. Official origins only, selected primary key only, scoped OpenAI project/org headers, bounded multipart/JSON/error reads, 120-second deadline, validated resumable URL, redirect refusal and credential-redacted errors. No live provider calls. Focused route tests passed 9/9, including default/explicit key, legacy local files, owner restart/read/delete/list isolation, alternate key transport and endpoint/connection policy; endpoint code is the next checkpoint.

- 2026-11-14: Public routes now enforce existing authentication/policy, owner-scoped resource metadata, selected transport proxy and CORS. Independent review identified unbounded cache pre-parsing and OpenAI pagination across hidden resources; real-route regressions reproduced the failures before the fixes. Bounded parsing now reads without a tee clone, supports cancellation, and rejects declared/chunked oversized bodies before dispatch. Hidden OpenAI pages are traversed internally with repeat/page/deadline bounds. Root-focused route/selector/transport/legacy-scope run passed 63/63. `npm run check:docs-all` passed after updating the migration count (223) in required translated documentation. Core model-rewrite and additional native file-carrier review fixes are in progress; publication remains gated.

- 2026-11-14: Independent review reproduced an ownership bypass in native OpenAI image/tool file attachments. The collector now covers direct image, screenshot, mask, Code Interpreter and shell file references, including nested tool/prompt carriers and every file-list member. Expanded ownership tests first failed 11 cases; fixed suite passed 32/32 and adjacent authentication/ownership suite passed 74/74. Output-only citations/search results and separate response/container/vector-store namespaces remain outside this direct file/cache attachment registry. No live provider requests.

- 2026-11-14: Strict inference integration is complete. Selected requests preserve native Responses/Gemini controls, account and model; suppress extra-key/session/quota/emergency account substitution; bypass provider-pool executor substitution while preserving transport proxies; and reject downstream lifecycle/payload/recovery model changes. Native idempotency hashes the full connection-scoped request, and selected requests bypass shared semantic/in-flight reuse. Review regressions reproduced model, cache and continuation failures before fixes. Final agent offline suite passed 85/85. An expanded catalog integration test attempted HTTPS to aihorde.net and was rejected by automatic approval review; that expanded gate was not retried, and remains unverified. The safe mocked suites completed.

- 2026-11-14: Exact candidate workflow regression commands passed locally: preserved fork tests 171/171, native resource/ownership/scope tests 152/152, real command-palette UI tests 25/25. Fresh typecheck:core passed. check:docs-all passed; check:openapi-coverage passed at 759/791 (96.0%). Broader API TypeScript check exits 2 on both unchanged base ce57802a and feature: 162 diagnostics each, identical file/error-code multiplicities, no added diagnostic location categories. Focused lint/format checks passed. Final independent review is closing its original reproductions; image publication has not yet started.

- 2026-11-14: Owner approved completion with a **new image tag only**, preserving all previous tags and deployed containers. Added `.github/workflows/fork-provider-resource-image.yml` in commit `65f2a9095ac00d0e624e87fc3980c3d2205779d4`. Dedicated fork-only GHCR build targets `runner-base` on amd64/arm64 and publishes **only** `ghcr.io/samimozcan/omniroute:3.8.53-provider-resources-${GITHUB_SHA}`; no latest, existing image tag, deployment, or volume mutation. The connector returned no workflow runs for that commit at the time of inspection; **image build, manifest, digest, runtime/volume verification and live provider testing are NOT verified**. Do not mark the publication task complete until a successful run and digest exist. Workflow dispatch may be needed if the GitHub workflow-file commit did not trigger Actions.

- 2026-11-14: Independent targeted re-review cleared every established Important/P1/P2 finding. Original foreign image/Code Interpreter attachments returned 404 with zero outbound calls; owner controls reached official Responses. Original Gemini background-downgrade reproduction retained Flash and its cache. Twelve decisive mocked inference tests and three route regressions passed independently. No remaining Critical/Important review blocker. Source checkpoint: 4574ac6de8378e9fc755e23f233ff7ff6a436d4f. Image workflow can now be published; release digest and Relayhub link remain pending.

- 2026-11-14 21:31 UTC: Resumed after interruption and fetched the branch before writing. A later session had preserved source code and added the isolated image workflow. Remote head 3ef1bf674c9f3426fdf726a183d7ad4c4c973faf has successful build run https://github.com/samimozcan/OmniRoute/actions/runs/43594689604. The existing new-tag-only publication policy is retained. This documentation checkpoint was rebased onto that head, preserving its workflow and history; manifest/runtime verification and Relayhub cross-link are being completed.

- 2026-11-14: Public GHCR verification succeeded. Image `ghcr.io/samimozcan/omniroute:3.8.53-provider-resources-3ef1bf674c9f3426fdf726a183d7ad4c4c973faf`; OCI index digest `sha256:011a720297b8e853528c8a10fb75702839182a973486c971f28dc7d48cc58c81`. Linux amd64 manifest `sha256:4d61f56c94f259f556f3c5636c9b63fbe092b766b6f35d3d51bb29caacc2983e`; arm64 `sha256:336fbb6588b4976116f313b5d95c5ee1aea7c2d677032409036b12600064c0ca`. Both configs carry source revision `3ef1bf674c9f3426fdf726a183d7ad4c4c973faf`. Build run 43594689604 succeeded; registry values agree with the build job digest. Existing rollback image remains `ghcr.io/samimozcan/omniroute:3.8.53-terra-cmdk-ce57802a69b8` at `sha256:9908557122bf681e5a0523da75f5cf28fcfa745595c2b7c1c137336d75cdcbf1`. Neither image was deployed here.

- 2026-11-14: RelayHub follow-up started as https://github.com/atezsoftware/relayhub/pull/318 (draft), branch `codex/omni-provider-resource-continuation`, base `test/v1` at `7f33381a4bbe17417e708410f610e203941ae76d`, initial commit `f1bad1f59f91b8ff0ba62abfe59fdc56e047ed1c`. Durable contract: [RelayHub native resource contract](https://github.com/atezsoftware/relayhub/blob/f1bad1f59f91b8ff0ba62abfe59fdc56e047ed1c/apps/api/src/modules/ai/service/omni-provider-resources.md). It contains native provider/model selection, default index zero, stable account identity, file/cache/session/queue/usage invariants, implementation/test tasks and exact resume instructions. This is the requested follow-up PR start: RelayHub runtime integration is not implemented/enabled, and no runtime tests are claimed. Continue its implementation in PR #318 using its checked source references. Both PRs now link each other.

- 2026-11-14: Added `.github/workflows/verify-provider-resource-image.yml` to verify the already-published immutable digest, with contents-read permission and no build/push/tag/deploy step. It runs the remaining native amd64/arm64 health, endpoint, metadata migration and disposable-volume reuse checks; the already-passed 348 source regressions are not repeated because runtime code is unchanged. It confirms source affinity before attributing regressions to the image. Local YAML/bash/embedded Node syntax, real SQLite marker/reopen and formatting checks passed; actual Actions/container verification remains pending until its run completes. The earlier uncommitted publication prototype is superseded by the existing successful isolated publisher, preserving the owner's new-tag-only policy.

- 2026-11-14: Verification-only workflow published as commit `4a52c9f0822e80cdb60c236967785279de326e57`, independently of the documentation upload. It verifies the existing image without rebuilding or publishing tags. Runtime source, test and configuration files still match image source `3ef1bf674c9f3426fdf726a183d7ad4c4c973faf`; native container results remain pending. The documentation checkpoint follows this commit and retains all previous work.

- 2026-11-14: Final native runtime verification passed on both architectures in https://github.com/samimozcan/OmniRoute/actions/runs/43644599870. Jobs 132599442892 (arm64) and 132599443098 (amd64) both completed successfully, including source-affinity, manifest, native platform/revision, healthy startup, provider-resource table, selector endpoint responses, owner/metadata binding persistence and file persistence after recreating the container with the same disposable volume. No registry write, existing tag update or production deployment occurred. Usage/OpenAPI/migration-count documentation and both PR links were published in commit `aa613280e631657fb110e71d1575df4b8e18ce5e`. The remaining implementation work belongs to RelayHub PR #318.
