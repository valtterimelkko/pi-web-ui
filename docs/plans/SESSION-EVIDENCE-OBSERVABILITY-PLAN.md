# Session Evidence Observability Plan

**Status:** complete
**Goal:** make troubleshooting from any session identifier a bounded, one-call, agent-friendly operation without adding telemetry or raw transcript persistence.

## Design decision

Add an additive `GET /api/v1/sessions/:id/evidence` read-only endpoint. It accepts the same identifier forms as the transcript resolver (internal id, registry path, Claude native id, OpenCode native id, and Antigravity conversation id) and returns a compact default bundle. Existing transcript, diagnostics, history, and run-receipt response shapes remain unchanged.

The default bundle is intentionally diagnostic-first and bounded:

- canonical session identity and known aliases
- runtime, registry status, model, working directory, timestamps, message count, and execution identity
- exact runtime-specific source locators and bounded journal/API commands
- one compact, secret-scrubbed diagnostics slice (one record list, not duplicated `recentErrors`)
- process-local diagnostics metadata and durable run-receipt summary
- links to the existing full read paths

Optional `expand=` values may request bounded diagnostics, visible transcript, screen projection, and recent run receipts. Full raw JSONL, full history, tool payloads, prompts, and operational global snapshots are never part of the default response.

Also normalise WebSocket prompt correlation to the registry's canonical internal session id. Pi browser prompts currently use the full session path as the log `sessionId`, which prevents canonical session-scoped diagnostics from finding those records.

## Implementation phases

1. **Contract and tests (RED):** define the response type and endpoint semantics; add focused route tests for every identifier form, bounded default output, opt-in expansion, read-only behaviour, and secret absence. Add a WebSocket correlation regression test where Pi `entry.id !== entry.path`.
2. **Endpoint and correlation (GREEN):** implement the compact evidence builder, route it behind existing bearer auth, reuse the existing session resolver/diagnostics/run-receipt seams, and normalise WebSocket prompt correlation with a safe registry lookup fallback.
3. **CLI fallback:** add `--json` to `scripts/debug-where.mjs` while preserving the existing text output. The JSON output is offline locator evidence with canonical aliases and runtime source paths; the live endpoint remains the source for process-local logs and receipts.
4. **Docs and client seam:** document the endpoint, boundedness, process-local/durable distinction, and first-stop command. Add a validation client read method and a disposable live-validation assertion. Bump the additive Internal API contract to `1.10.0` and synchronise the Agent OS contract mirror/client only if the repository's existing cross-repo contract workflow requires it.
5. **Validation:** focused RED/GREEN tests, full lint/typecheck/build/suites, disposable Pi live validation (and other available runtime smoke if useful), critical review, secret/artifact audit, commit and push. Never target the production socket or service.

## Acceptance criteria

- Internal id, registry path, Claude native id, OpenCode native id, and Antigravity conversation id resolve to the same canonical session id.
- Default evidence JSON is bounded (target below 5 KB for fixture data), contains no raw prompt/tool/transcript body, no credentials, and clearly labels diagnostics as process-local.
- Default diagnostics contain a single compact record list; optional expansions are explicitly requested and bounded.
- Evidence lookup is strictly read-only and does not prompt, create, upsert, emit notifications, or change watches/pins.
- WebSocket Pi prompt logs use the registry internal id when available; registry lookup failure falls back to the existing path correlation without breaking prompts.
- `debug:where` default text output remains compatible; `--json` is valid machine-readable offline output and never contains the bearer token.
- Existing endpoint behavior and `/api/v1` auth remain unchanged.
- Disposable live validation proves the endpoint works against a real runtime/session and accepts a path/native alias; production remains untouched.
