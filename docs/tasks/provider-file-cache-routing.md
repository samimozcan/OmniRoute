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
- [ ] Open the draft PR with the complete initial task ledger.
- [ ] Research current official OpenAI Files/Responses/prompt cache and Gemini Files/cachedContents contracts.
- [ ] Read current resource routes, connection ordering, auth/policy, inference routing and fork publication workflow.
- [ ] Commit a concrete design and implementation plan with exact files, contracts, index semantics and tests.
- [ ] Add failing tests for opt-in selection, default index zero, explicit index, invalid index/provider, disabled credentials, auth and legacy behavior.
- [ ] Implement deterministic account selection and stable connection identity for follow-up operations.
- [ ] Implement supported upstream file lifecycle operations and return native identifiers.
- [ ] Implement supported explicit cache lifecycle and continuation routing.
- [ ] Verify inference account affinity, unsupported capabilities and error redaction.
- [ ] Run focused regressions, existing fork tests, formatting/lint, relevant type checks and documentation gates; record baseline issues separately.
- [ ] Independently review the change and resolve concrete findings.
- [ ] Add/adapt the fork-only image workflow, build both supported architectures, and verify startup/volume-reuse and published manifests.
- [ ] Record the immutable image tag, digest, source commit, successful workflow and rollback reference.
- [ ] Only after the OmniRoute backend is complete: create the Relayhub PR from its current test base with its own initial task ledger.
- [ ] Implement/test the narrow Relayhub integration for file/cache continuation and pinned routing.
- [ ] Link Relayhub back here and record final status, outstanding limits and exact resume instructions.

## Design decisions to resolve in research

A shared HTTP-header selector is the initial implementation proposal because it works for multipart upload, JSON cache calls, GET/DELETE and inference without injecting router fields into provider payloads. The exact names and supported endpoint mapping are not implemented yet. Determine index ordering from the existing UI/database contract and return a stable connection identifier for reuse if account ordering changes.

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
