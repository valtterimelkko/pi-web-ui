# Command Code full-catalogue minimal solution plan

## Objective

Finish the smallest release-quality Command Code catalogue slice end-to-end:

- expose the complete live `cmd --list-models` catalogue with explicit per-model
  `runnable`, `evidence-only`, or `unavailable` status;
- keep execution fail-closed to the exact Qwen and Muse routes;
- preserve native effort semantics (Qwen `low|medium|xhigh`, default `medium`;
  Muse has no effort selector);
- keep browser availability separate from Internal API shadow availability;
- make the Internal API, REST/WebSocket browser metadata, frontend, and Agent OS
  consumer agree;
- prove the result on disposable fixtures and commit/push both repositories.

Production services, sockets, configuration, credentials, and state remain
untouched.

## Current baseline

- Pi Web UI is on `master` with the existing Command Code/runtime changes
  uncommitted; Agent OS is on `main` with its consumer changes uncommitted.
- Focused Pi Web UI Command Code and route suites pass; the full workspace
  suite is rerun as a release gate.
- A non-updating probe of the installed CLI currently reports `1.23.2` (the
  earlier audit observed `1.23.1`) and `cmd --no-auto-update --list-models`
  reports 54 rows in the exact canonical order pinned by
  `COMMAND_CODE_FULL_MODEL_CATALOGUE`. The pinned execution policy remains
  `COMMAND_CODE_EXPECTED_VERSION` is legacy diagnostic-only configuration; CLI
  version drift is not a readiness gate.
  fail-closed and cannot broaden execution. The full catalogue remains visible
  as evidence while the runtime is unavailable for execution.
- The catalogue anchor is now the complete 54-entry list, including
  `google/gemini-3.7-flash`; default startup discovery rejects missing, extra,
  duplicate, reordered, or malformed catalogue evidence before the shadow gate
  can become available.

## TDD work packages

### WP1 — authoritative full catalogue and discovery

1. Add a failing test for the complete observed catalogue, including
   `google/gemini-3.7-flash`, exact order, duplicate/missing/extra/reorder and
   malformed-row rejection.
2. Make the catalogue anchor 54 current model IDs and wire validation into the
   default discovery path. Keep the expected runtime version independently
   determined by live model and native-effort discovery, not a pinned CLI version.
3. Add/repair fixture generation so its model list is complete and its launcher
   has exactly one shebang.
4. Preserve bounded spawn, timeout, malformed-output, and unknown-effort
   fail-closed behaviour.

### WP2 — service status and execution policy

1. Add failing tests showing extra-model effort uncertainty does not make the
   approved pair executable-unavailable, while malformed required-model
   capability still fails closed.
2. Implement separate catalogue-discovered/readiness state from execution
   readiness. Full discovered models remain readable on version mismatch or
   browser-gate failure; only the exact approved pair can have `runnable: true`.
3. Validate the full catalogue and required Qwen/Muse capability identities;
   retain bounded extra-model evidence without allowing extra execution.
4. Ensure every session/resume/batch/persistence path checks the exact allowlist.

### WP3 — API, WebSocket, and browser projections

1. Add failing route/protocol tests for full catalogue visibility when the
   runtime is enabled but narrow execution is unavailable.
2. Return the same full model projection from Internal API `/models`,
   capabilities, REST `/api/models?sdkType=commandcode`, and WebSocket
   `commandcode_available`.
3. Keep `available`/`browserRunnable` separate from catalogue visibility and
   preserve browser/Internal API isolation.
4. Update additive contract documentation without changing the pinned contract
   version.

### WP4 — frontend and Agent OS consumer parity

1. Add failing frontend tests for disabled evidence-only/unavailable options,
   Qwen effort values/default, Muse no-effort UI, stale selections, and no
   create attempt for a disabled model.
2. Implement model selection from the full catalogue while disabling every
   model without `browserRunnable`.
3. Add the same catalogue/status fields to Agent OS mirror types and validate
   full canonical order, required pair identity/capabilities, and narrow
   shadow policy. Extra models remain visible evidence and never become routes.
4. Reconcile `effortSource` (`explicit`, `default`, `automatic`, `none`) across
   Agent OS types, response validation, receipts, and documentation.

### WP5 — capacity and deterministic gates

1. Add failing tests for configured `commandcode` concurrency, active-turn
   release after completion/abort/timeout/process failure, and N+1 rejection.
2. Verify `/api/v1/capacity` and Internal API admission use the same runtime
   limit; keep browser sessions out of shadow capacity/list surfaces.
3. Run focused Pi Web UI and Agent OS suites after each green cycle.

### WP6 — disposable live validation and release review

Use fresh disposable directories only:

- start the validation server with the completed full-catalogue fixture;
- verify health, capabilities, Internal API `/models`, REST model metadata and
  WebSocket availability all contain the same complete ordered catalogue;
- verify Qwen create/default/explicit effort and Muse no-effort creation;
- verify evidence-only model creation is rejected;
- verify prompt, receipt, transcript/evidence, replay, abort/delete and
  capacity cleanup;
- verify browser-contained records remain absent from Internal API shadow
  surfaces;
- run Agent OS client validation against the same disposable socket.

Then run full tests, typechecks, builds, lint, documentation/link checks,
secret/artifact scans, and independent diff review. Do not validate production.

## Acceptance criteria

- Full catalogue count and ordered IDs match the observed CLI fixture exactly.
- Every surfaced entry has an explicit status and browser execution flag.
- Qwen and Muse are the only `runnable: true` entries when pinned execution is
  healthy; no extra model can create a session.
- Version mismatch can make execution unavailable without erasing catalogue
  evidence.
- Qwen accepts only `low`, `medium`, and `xhigh`, with `medium` default.
- Muse rejects all effort values and has no effort selector.
- All consumer surfaces agree on IDs, order, statuses, and effort metadata.
- Disposable live validation and repository gates pass; production is untouched.
- Owned changes are committed and pushed separately in Pi Web UI and Agent OS,
  with one final Telegram notification reporting actual evidence.
