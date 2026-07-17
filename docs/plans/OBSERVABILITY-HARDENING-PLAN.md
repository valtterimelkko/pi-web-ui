# Observability Hardening Implementation Plan

**Status:** complete (2026-07-17)  
**Contract target:** Internal API `1.9.0` (additive)  
**Scope:** all actionable improvements from the 2026-07-17 observability review, while preserving the local-first, single-operator architecture.

## Guardrails

- TDD for every behaviour change: add focused failing tests, verify RED, implement the minimum, verify GREEN.
- No OpenTelemetry, Prometheus, Grafana, Loki, SaaS APM, automatic browser telemetry upload, global normalized-event persistence, prompt/tool/provider payload logging, or broad Telegram alerting.
- No production restart, deployment, or production live validation. Runtime checks use a disposable validation server.
- Keep `.code-review-ledger.md` untouched.
- Internal API additions remain backwards-compatible under `/api/v1`; bump the additive contract to `1.9.0` and synchronise `/root/agent-os` docs/types/client/tests.

## Phase 1 — Logging safety and correlation

1. Make `DEBUG` namespace filtering focus info/debug records; warnings and errors from unmatched components remain visible.
2. Expand diagnostics redaction for common compound credential keys (`accessToken`, `refreshToken`, `clientSecret`, `privateKey`, bot-token variants).
3. Add structured `runId` and `executionInstanceId` correlation fields and filters for `requestId`, `runId`, `component`, `runtime`, and `since`.
4. Bind per-child session/runtime/run context around Internal API batch prompts and runtime on browser WebSocket prompts.

**Tests:** `server/tests/unit/logging/logger.test.ts`, `server/tests/unit/internal-api/diagnostics-buffer.test.ts`, `diagnostics-routes.test.ts`, correlation and session-route tests.

## Phase 2 — Pipeline integrity, workers, watches, and runtime drift

1. Add a lightweight in-memory operational metrics registry with low-cardinality counters/gauges only.
2. Record rate-limited event-subscriber failures instead of silently swallowing them.
3. Record Claude/OpenCode adapter malformed/unknown event categories without recording raw payloads.
4. Route worker crash evidence through the central logger; retain bounded crash records.
5. Track real worker spawn timestamps and warn when readiness falls back to the legacy timeout assumption.
6. Observe watch persistence failures, retain dirty state, and retry boundedly.

**Tests:** event broker, Claude/OpenCode adapters, crash logger, worker pool/session worker, watch manager/store.

## Phase 3 — Runtime health and operational summary (Internal API 1.9)

1. Publish a unified runtime-health matrix: enabled/available/backend/check status/last failure/check time, without making optional runtime unavailability a global readiness failure.
2. Extend authenticated diagnostics with a lightweight operational snapshot: turn outcomes/latency, active registry sessions by runtime/status, latest event age, observer/adapter/watch failures, worker crash statistics, and notification delivery counts.
3. Keep all dimensions bounded; no session IDs, paths, prompts, models, or tool details as metric labels.
4. Update contract types, docs, examples, tests, and capabilities expectations to `1.9.0`.

**Tests:** health routes, diagnostics routes, operational metrics, contract/capabilities tests.

## Phase 4 — Notification correctness and milestone UX

1. Preserve assistant tail until durable outbox enqueue succeeds.
2. Canonicalise Pi notification identity consistently for POST/GET/DELETE in browser and Internal API routes.
3. Validate/trim explicit notification bodies and permit only relative-app or HTTP(S) deep links.
4. Sort ingress claims deterministically and log unexpected opt-in identity replacement.
5. Surface browser toggle read/write failures with a small toast rather than silently failing.
6. Add `milestone` to `scripts/notify.sh` and document the lightweight milestone policy, idempotency/cooldown guidance, and no-double-notify rule.

**Tests:** notification manager/store/spool/routes, browser toggle, CLI self-notify integration.

## Phase 5 — Frontend diagnostics and reconnect reliability

1. Prevent intentional WebSocket closes from reconnecting; add bounded reconnect jitter and retain close code/reason/count.
2. Add a small in-memory browser diagnostic recorder containing only message types, timestamps, connection state, build version, low-cardinality runtime, and store status (no session identity/path).
3. Add a user-triggered copy/download diagnostic action and integrate it into `ErrorBoundary`; no automatic upload and no transcript/tool content.
4. Count unknown/malformed protocol message types in the local diagnostic recorder.
5. Make local-storage quota failures visible in that recorder while retaining graceful degradation.

**Tests:** new WebSocket client tests, recorder tests, ErrorBoundary tests, session-store protocol-drift tests; localhost browser validation via `webapp-testing`.

## Phase 6 — Live-validation evidence and wire-proxy safety

1. Add request timeouts to the validation Internal API client and retain streaming `X-Run-Id`.
2. Extend scenario results with timestamps, duration, run/model/backend/execution identity, event counts, attempt history, cleanup warnings, and scrubbed failure diagnostics.
3. Never report cleanup success after a swallowed failure; keep cleanup non-fatal but explicit.
4. Make watch/ephemeral cleanup evidence truthful in long-horizon runs.
5. Fail early when the wire-proxy log is unwritable; make later write failures visible; replace `--log-body` with explicit unsafe opt-in, recursive redaction, `0600` output, and bounded capture.
6. Add observability assertions to disposable smoke validation without making provider payloads observable.

**Tests:** validation client/scenario runner/long-horizon runner/proxy helper tests. Live-validate on an isolated disposable server.

## Phase 7 — Agent OS compatibility

1. Add compatible `1.9.0` health/diagnostics/operational snapshot types and client read methods while retaining `1.8.0` notification gating.
2. Update Agent OS contract documentation and contract tests to recognise `1.9.0`.
3. Run Agent OS tests, typecheck, docs checks, then commit and push independently.

## Review and validation gates

After Phases 1–3, 4–5, and 6–7:

1. Run focused tests and typecheck.
2. Perform a critical code/security/privacy review with a reviewer subagent.
3. Fix material findings test-first.
4. Re-run the affected suite.
5. Send a Telegram milestone.

Final gate:

- `npm run docs:check-agent-guides`
- `npm run lint`
- `npm run typecheck`
- `npm run build`
- `npm test`
- localhost UI validation through `webapp-testing`
- disposable Internal API live validation (never production)
- inspect `git status --short`, `git diff --stat`, `git diff --cached --stat`
- secret/session-artifact review
- commit and push both repositories.

## Completion evidence

- Three critical review/fix cycles completed. Material findings were corrected,
  including enqueue rollback/retry races, stale WebSocket callbacks, absolute
  request deadlines, cleanup truthfulness, proxy content/query redaction,
  runtime-probe timeouts, path-free operational crash summaries, and browser
  session-identity removal.
- Pi Web UI: lint completed with the existing warning baseline and no errors;
  docs guide sync, typecheck, build, and the full test suite passed (2378 server
  + 760 client tests).
- Agent OS: all 279 tests and typecheck passed. An initial stale `1.8.0`
  documentation assertion was updated to `1.9.0` before the final green run.
- Disposable live validation passed on Pi (`smoke`, model `kimi-coding/k3`) with
  `runId`, execution identity, event counts, runtime-health `1.9.0`, filtered
  diagnostics, and operational turn latency evidence. The disposable process
  tree/socket/directory were removed; production was not queried or changed.
- Localhost browser smoke passed through `webapp-testing` with API requests
  mocked to unauthenticated; the login UI rendered without page errors and the
  temporary Vite process tree was removed.
