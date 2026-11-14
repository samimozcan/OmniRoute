# Provider-selected files and cache routing — work log

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
- [ ] Verify inference account affinity, unsupported capabilities and error redaction.
- [ ] Run focused regressions, existing fork tests, formatting/lint, relevant type checks and documentation gates; record baseline issues separately.
- [ ] Independently review the change and resolve concrete findings.
- [ ] Add/adapt the fork-only image workflow, build both supported architectures, and verify startup/volume-reuse and published manifests.
- [ ] Record the immutable image tag, digest, source commit, successful workflow and rollback reference.
- [ ] Only after the OmniRoute backend is complete: create the Relayhub PR from its current test base with its own initial task ledger.
- [ ] Implement/test the narrow Relayhub integration for file/cache continuation and pinned routing.
- [ ] Link Relayhub back here and record final status, outstanding limits and exact resume instructions.

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
