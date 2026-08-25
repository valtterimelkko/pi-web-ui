# Internal API Contract and Versioning

> Canonical contract policy for Pi Web UI's local Internal API. Read this before changing any `server/src/internal-api/*` route, response shape, or orchestration behaviour.

## Contract identity

`server/src/internal-api/types.ts` is the machine-readable version source of
truth and this document is the canonical human-readable compatibility record.
Other indexes and delta summaries should link here rather than inventing a
second current version number.

The Internal API publishes its contract metadata through both:

- `GET /api/v1/health`
- `GET /api/v1/capabilities`

Current contract:

```json
{
  "name": "pi-web-ui-internal-api",
  "routePrefix": "/api/v1",
  "majorVersion": "v1",
  "contractVersion": "1.26.0",
  "stability": "beta",
  "contractDoc": "docs/INTERNAL-API-CONTRACT.md"
}
```

### Changelog

- **1.26.0** (minor, additive round-2 consumer fixes) — fixes the round-2 defects reported 2026-08-25 (after 1.25.0). Everything is additive; existing consumers keep working unchanged — including bare model ids, which were a silent regression in 1.25.0 and are restored here:
  - **Bare model id resolution** — `POST /sessions` with a Pi `model` that is a bare id (no `/`) again binds when it matches exactly one advertised, unblocked model: the qualified selector is applied and `resolvedModel`/`modelBinding.resolved` report the qualified form with `fallbackApplied: false`. A bare id matching several advertised models returns `422 MODEL_NOT_APPLIED` listing every `provider/id` candidate; unknown ids keep failing loudly exactly as in 1.25.0. Blocked providers are excluded from resolution. (1.25.0 rejected all bare ids as format errors despite its "additive" changelog claim.)
  - **Copyable `selector` on every `/models` entry** — each entry of `GET /api/v1/models` now carries a `selector` field whose value is exactly what `POST /sessions` accepts for that runtime (`provider/id` for pi and opencode; the alias or `profile:<id>` form for claude; the native id for commandcode and antigravity). Discovery clients copy rather than construct selectors.
  - **Long-poll watch wait** — `GET /api/v1/watches/wait?ids=w1,w2[&timeout=<ms>][&cursor=<opaque>]` blocks until at least one named watch records a firing the caller has not seen, then returns `{ fired: true, waitedMs, watches: [{ watchId, sessionId, runtime, firings[], firingCount }], nextCursor }`; `204` on timeout (bound clamped to `[0, 300000]`, default 60000, junk → `400`). Ids accept `watch-<sessionId>` or bare session ids and are resolved all-or-nothing (`404 WATCH_NOT_FOUND` names any missing one). The opaque `nextCursor` is a resumable cursor: pass it back as `?cursor=` to receive only new firings — at-least-once delivery across reconnects; without a cursor, already-recorded firings are returned immediately. Condition evaluation stays entirely server-side (pure observer watches work); this only removes the polling loop between the consumer and that evaluation. Client disconnects stop the wait cleanly.
  - The 1.25.0 note that an observed `agent_end` alone does not confirm completion remains authoritative and unchanged (round-2 defect 4 asked to keep it; it is kept).

- **1.25.0** (minor, additive orchestration-honesty surface) — fixes the consumer-reported defects of 2026-08-25. Everything is additive; existing consumers keep working unchanged.
  - **Model binding honesty** — `POST /sessions` no longer silently inherits when an explicit `model` cannot be applied: unresolvable/refused selectors now return `422 MODEL_NOT_APPLIED` and the half-created session is cleaned up. On success the response carries `resolvedModel` (what the session is actually bound to) plus a `modelBinding { requested?, resolved, fallbackApplied }` report; a default/fallback binding is labelled instead of echoed as if requested. Applies to Pi (previously swallowed via non-fatal catch), OpenCode, and Claude paths. The Pi provider policy check still runs on the *resolved* model.
  - **Authoritative retention in `/info`** — `GET /sessions/:id/info` now includes a top-level `retention { protected, leases[{ leaseId, mode, expiresAt }], latestExpiryAt? }`, so the endpoint a consumer uses for confirmation agrees with the create response.
  - **Session liveness** — `/info` and the session list now derive live status from runtime state (`busy: true` while an in-flight turn exists) instead of stale registry status.
  - **Run work-state honesty** — run receipts expose top-level `cessation` and a derived `workState`. A terminal `completed` status whose runtime cessation was never confirmed reports `workState: "turn_ended_unconfirmed"`; `completed` is reserved for confirmed cessation (`documented_handler_return` or resource quiescence). Note: an observed `agent_end` alone does **not** confirm work completion — a detached child can yield its turn awaiting a wake while its nested work continues, and the two are indistinguishable from the turn boundary. Consumers needing certainty should require confirmed cessation or verify output independently. Mirrors are omitted inside bounded evidence bundles where `liveness.cessation` remains available.
  - **Transcript `limit`** — `GET /sessions/:id/transcript?limit=<n>` honours a caller window (integer 1–500, junk/oversized → `400 INVALID_REQUEST`) instead of always capping `visible_recent` at 20; the applied limit is echoed in the response.
  - **Claude profile field alignment** — `/capabilities.claudeProfiles` entries now carry `claudeModel` alongside `model`, matching `/models` profile entries and the documented selection predicate.

- **1.24.0** (minor, additive bounded reads on `/sessions/:id/events`) — the default `GET /sessions/:id/events` behaviour is unchanged (unbounded SSE subscription that ends only on client disconnect; correct for browser `EventSource` consumers). Two additive opt-ins exist for clients that cannot consume an infinite stream:
  - `?mode=snapshot` — a plain request/response read: returns `{ sessionId, mode:"snapshot", count, events }` from the broker's replay buffer (oldest first) and closes. Always terminates; safe to call from a CLI, script, or agent tool call.
  - `?timeout=<ms>` — a bounded SSE stream: identical framing and headers to the default mode, but the server closes the stream after the bound with a terminal `complete` event carrying `reason:"timeout"`. The bound is clamped to `[0, 300000]`, exactly like `/wait`. No `timeout` parameter keeps the historical unbounded behaviour byte-for-byte.

- **1.23.0** (minor, additive Command Code watch subjects) — Command Code sessions can now be the *observed* session of a watch (`POST/GET/DELETE /sessions/:id/watch` with a `commandcode-*` id), completing the watch-wake matrix: any of pi/claude/opencode/antigravity/**commandcode** can be the child, any managed runtime can be the `onFire` wake target. Command Code turns reach the watch from every source (Internal API dispatch, browser, follow-ups) via a service-level observer attached at registration; the subject is pinned with the source-owned `watch:<watchId>` claim via the Command Code service, released on delete/replace. Previously these registrations returned `404 SESSION_NOT_FOUND`.
- **1.22.0** (minor, additive watch onFire wake) — a watch can now wake a *different* session when a condition fires. This is the runtime-agnostic parent-wake: the watch stays an observer, and an opt-in action dispatches a prompt to the target (typically the idle parent orchestrating the watched child). Adds to `POST /sessions/:id/watch`:
  - optional `onFire: { type: "prompt", targetSessionId, message, mode?, maxWakeups?, cooldownSeconds?, pinTarget?, includeEvidence? }` — `type` must be `prompt`, the target must exist and must differ from the watched session (self-target is a `400`; a missing target is a `404 SESSION_NOT_FOUND`);
  - the wake dispatch is always detached and takes the same receipted, admission-controlled, prompt-injection-checked path as `POST /sessions/:id/prompt` (`follow_up` queues on a busy Pi target and idle-promotes; busy non-Pi targets fail with `SESSION_BUSY`; steer is not available here);
  - the target is pinned with a source-owned `watch-target:<watchId>` claim by default (`pinTarget: false` opts out) so idle eviction cannot kill the parent before the wake;
  - the poll response gains `onFire` (echo) and `wakeAttempts[]` — a durable audit of every attempt (`dispatched` + `runId`, `failed` + `errorCode`, or `suppressed` + `reason` `max_wakeups_reached`/`cooldown`), capped at 50 recorded entries;
  - `message` supports bounded placeholders `{{conditionId}}`, `{{eventType}}`, `{{sessionId}}`, `{{firedAt}}`, and `{{evidence}}` only with `includeEvidence: true` (evidence is child-controlled text and is excluded by default);
  - watches registered without `onFire` are byte-for-byte pure observers as before.
- **1.21.0** (minor, truthful Pi create responses; additive error code) — Pi session creation becomes verifiable about route identity:
  - the Pi create response's `model` is the model the session **actually resolved to** (`provider/model`); it never echoes a request that was not applied. `modelSelector` (additive, Pi creates) echoes the exact requested selector;
  - a selector the runtime refuses or cannot apply (for example a bare model id without a provider component) fails the create with `422 MODEL_NOT_APPLIED` (new additive error code) after the half-created session, registry entry and socket files are cleaned up — the same fail-closed shape as the blocked-provider path;
  - session-list/`firstMessage` no longer skips genuine user prompts that merely reference a skill path (the Part 3 envelope case): only canonical `<skill name=` injections are treated as skill content.
- **1.20.0** (minor, breaking for Command Code role metadata) — Command Code session creation no longer requires `invocationRole` or a role attestation; both request fields are accepted and ignored (removal tracked in `session-validation.ts`). The `catalogue`, `browserRunnable` and `supportsEffort` fields are removed from the Command Code model projection, and the effort metadata on sessions/receipts collapses to `effort` / `effortLevels` / `defaultEffort`. Command Code is one direct subprocess for both browser and Internal API callers; a session is a session.
- **1.19.0** (minor, additive normalized-output evidence) — adds:
  - `RunReceipt.outputEvidence` with bounded counts of normalized assistant messages, text-bearing events/characters, tool calls, and a `text` / `no-text` / `unknown` disposition;
  - `no-text` is emitted only when a terminal `agent_end` was observed without normalized assistant text; `unknown` remains the honest value when lifecycle terminality occurred without that signal;
  - the field is payload-free, persisted across restart, and old receipts/clients remain readable and compatible. It does not change terminal statuses or claim semantic answer quality.
- **1.18.0** (minor, additive run-scoped Command Code usage evidence) — adds:
  - `RunReceipt.tokenUsage` for Command Code when the matching terminal NDJSON result contains valid non-negative input/output counts; the projection is `{ scope: "run", source: "commandcode-terminal-result-v1", input, output, total }` and `total` must equal `input + output`;
  - the usage field is persisted through receipt restart recovery, exposed by `/runs/:runId` and the Command Code session detail/evidence projections, and included in bounded run chronology;
  - missing, malformed, contradictory, or cumulative session/context usage is omitted rather than inferred. Agent OS child budgets must treat omitted usage as unmeasurable and fail closed; old clients may ignore this additive field.
- **1.17.0** (minor, additive Command Code runtime) — adds the feature-gated `commandcode` runtime:
  - `GET /capabilities`, `GET /health`, and `GET /models` expose truthful disabled, unavailable, exact-model, version, and available states; the complete catalogue is advertised as bounded live evidence after fresh `cmd --no-auto-update --version` and `--list-models` probes, while model-scoped effort evidence independently controls execution and the observed CLI version is diagnostic only;
  - standard session, prompt, run-receipt, evidence, history, transcript/screen, events, wait, abort, pin, and delete routes use a private atomic mapping and normalized event journal; native transcripts remain owned by Command Code, while credentials are copied into each session-private native home and never symlinked into the operator's shared config;
  - `/models` and `/capabilities` expose the complete ordered `cmd --list-models` catalogue with per-model `status`, `runnable`, and `browserRunnable` fields plus additive catalogue `availabilityStatus`, `checkedAt`, and `source` metadata; unknown or drifted capability evidence fails closed, and `effort` is never mapped to generic `thinkingLevel`; full catalogue visibility remains separate from execution authority;
  - the authenticated Internal API shadow path remains narrow: callers provide only `invocationRole` plus a short-lived HMAC role attestation binding the exact model, canonical cwd/worktree, lease, and (for children) parent session; Pi Web UI maps the role to fixed server-owned profiles and rejects aliases/raw flags;
  - browser/shared runtime support is now separately feature-gated. Browser sessions require a non-empty exact model allowlist, canonical non-symlink workspace roots, a browser-only credential, pinned read-only runtime mounts, an unshared Bubblewrap network namespace, and a server-owned profile; the browser never chooses executable paths, argv, environment, auth paths, native ids, or permission profiles. Browser-contained records are excluded from Internal API shadow session, diagnostics, notification, receipt, and transfer resolution; browser transfer is WebSocket-only and uses the active containment policy. MCP and disposable `--runtime all` remain excluded;
  - the runtime is disabled by default with `PI_INTERNAL_API_COMMANDCODE_ENABLED=false` and `PI_COMMAND_CODE_BROWSER_ENABLED=false`. Old clients can ignore the additive runtime/capability/model fields.
  - Command Code readiness is not pinned to a repository-owned CLI version: the observed version is reported for diagnostics, while live catalogue/effort evidence and the exact Agent OS shadow pair continue to control execution; version-probe disagreement still fails closed.
- **1.16.0** (minor, additive Internal API Pi-provider execution policy) — prevents accidental metered-provider agent spend on the local automation surface while preserving browser features:
  - Pi providers configured by `INTERNAL_API_BLOCKED_PI_PROVIDERS` (default `openai,openrouter`) are omitted from `GET /api/v1/models` and rejected with `403 PROVIDER_NOT_ALLOWED` before Internal API session creation, model switching, prompt/follow-up/steer/detached/batch dispatch, or transfer dispatch can invoke them;
  - the policy compares exact provider ids, so the subscription-backed `openai-codex` provider remains available; `/capabilities.features.piProviderPolicy.blockedProviders` exposes the effective list;
  - enforcement re-checks the live Pi session model at dispatch, including browser-created sessions used later through the Internal API, and serializes that execution boundary with Pi model changes so an in-flight browser switch cannot win between check and dispatch; idempotent receipt replay and read/control operations that do not execute a model remain available;
  - browser REST/WebSocket model use and the separate `/api/dictation` and `/api/tts` routes are unchanged. An explicitly empty env value disables the policy for operators who intentionally want those providers on the Internal API.
  Old clients can ignore the additive capability field and handle the new stable 403 code as an ordinary refusal.

The owner-approved Phase 7 shadow gate adds an optional `phase7Shadow` field to
Pi Internal API run receipts on the disposable `validationMode` server only,
without changing the published contract version or any dispatch semantics.
Normal development/production servers do not enable this observation. This is
intentionally server-owned evidence, not a caller-selectable profile or a
contained execution route; consumers may ignore it. The policy identifier is
`phase7-pi-shadow/v1`, and its resource identity truthfully describes the
existing shared Pi control process until a later owner pause authorises any
routing change.
- **1.15.0** (minor, additive disabled-runtime contract) — made an operator-disabled runtime truthfully distinct from an uninstalled/unhealthy one:
  - `/capabilities` adds an additive `enabled` boolean to every runtime entry; OpenCode reports `enabled:false` together with `available:false` when `OPENCODE_ENABLED=false`, while an installed-and-enabled runtime reports `enabled:true`; automation clients must treat a disabled runtime as unavailable and must not silently substitute another runtime;
  - OpenCode session creation and cross-runtime transfer to a new or existing OpenCode target fail closed with `RUNTIME_UNAVAILABLE` (transfer surface: `TRANSFER_RUNTIME_UNAVAILABLE`) when the runtime is disabled, before any managed `opencode serve` is spawned or attached;
  - historical OpenCode sessions and registry entries are preserved and remain listable; operations that require the disabled backend fail read-only with the contracted error and do not mutate state;
  - re-enabling is `OPENCODE_ENABLED=true` plus a controlled restart; no implementation, tests, or historical state are removed. Old clients can ignore the additive `enabled` field.
- **1.14.0** (minor, additive run-liveness and recovery evidence) — made watchdog and recovery evidence reconstructable without importing an orchestrator ontology:
  - run receipts add bounded, payload-free `liveness` evidence with policy version/timeouts, the latest eligible run-correlated activity, idle-versus-absolute watchdog decisions, up to four terminal observations, and explicit cessation state;
  - blind `stream_activity` heartbeats no longer reset the Internal API run watchdog; polling, retention and observer lifecycle remain ineligible by construction;
  - late `agent_end` evidence annotates a terminal receipt without reopening it, changing capacity, or claiming arbitrary nested-process quiescence; Pi API-error-grace terminal events are explicitly marked synthetic, reach Internal API observers, and cannot by themselves successfully complete direct or queued Pi work;
  - `GET /sessions/:id/evidence` adds separate active-lease counts, current adapter materialization, and a bounded three-run chronology; it does not expose lease owners/labels or scan worktree artefacts;
  - `/capabilities` advertises `runLivenessEvidence` and `sessionRecoveryEvidence`. Old receipts without `liveness` remain readable and mean legacy/unknown evidence.
- **1.13.0** (minor, additive with corrected dispatch/approval semantics) — made accepted work and session identity truthful:
  - idle `follow_up` is promoted to a real turn and reports requested `mode` plus actual `dispatchMode`; strict callers can set `requireActiveTurn:true`;
  - `follow_up`/`steer` now apply state-aware busy checks, with `SESSION_NOT_STREAMING` and `Retry-After` where applicable;
  - unknown approval ids return `404 APPROVAL_REQUEST_NOT_FOUND`, `toolCallId` is accepted as an alias, and `/approvals/pending` exposes live Claude SDK questions;
  - run receipts persist mode/dispatch mode and idle/absolute watchdogs terminalise `TURN_STALLED` runs and release capacity;
  - Pi rehydration fails closed for missing files or filename/header identity mismatch, while incremental watcher indexing and `debug:where` exact filename fallback improve discoverability.
- **1.12.0** (minor, additive) — separated source-owned retention from execution admission:
  - `POST /sessions` accepts required `retention: {mode:"durable"|"resident",ttlSeconds?,ownerId,label?}` and returns a lease id; failure is atomic and removes the unused session;
  - `acquire_retention` adds an independent lease to an existing session; `renew_retention` and `release_retention` target one lease id, so Web UI, watch, and concurrent Internal API owners cannot release each other's claims;
  - the historical two-pin cap now applies only to human Web UI claims; API leases do not consume those slots;
  - `GET /api/v1/capacity` reports process-local admission, dynamic per-runtime active turns, interactive/control reserve, ordinary execution capacity, measured cgroup/RSS memory headroom, optional PID/task and host-pressure/event evidence, and conservative-knob provenance; prompt refusal returns `429` (or `503` under resource pressure) with `ADMISSION_CAPACITY_EXHAUSTED` and `Retry-After`;
  - Pi Internal API synthetic subscriptions are released after create/turn completion, and explicit DELETE disposes the loaded SDK session before removing files;
  - legacy `pin`/`unpin` fields remain compatible API-owned projections during migration. Old clients can ignore every additive field/endpoint.
- **1.11.0** (minor, additive) — made exact Claude profile identity explicit and fail-closed:
  - profile-backed Claude create/session-info/list/run-receipt responses add `modelSelector: "profile:<id>"`; for backwards compatibility the create response keeps its existing request-selector echo in `model`, while session info/list/receipts keep their existing effective-runtime-model meaning (for example `sonnet`);
  - exact creation responses also expose the resolved `executionInstanceId`;
  - conflicting `model: "profile:<a>"` plus `profileId: "<b>"` is rejected before creation;
  - an explicit unknown profile or unavailable/unhealthy requested backend now fails creation instead of silently creating a session through another Claude backend;
  - historical sessions and receipts remain readable because the new field is additive and derived from persisted profile metadata when available.
- **1.10.1** (patch) — corrected Pi run-receipt completion across auto-compaction:
  - Pi prompt-promise return is no longer treated as a terminal turn boundary because the same `AgentSession` may resume asynchronously after compaction;
  - an ordinary Pi LLM receipt now terminalises only after the normalized `agent_end` signal, preserving truthful `agentEndAt` evidence for detached orchestrators; synchronous extension slash commands remain terminal on documented handler return and may have no `agentEndAt`;
  - runtime errors remain terminal failures. Existing clients remain compatible; defensive consumers should treat a Pi `completed` receipt without `agentEndAt` as contradictory/nonterminal evidence from an older server.
- **1.10.0** (minor, additive) — added a compact, one-call session evidence bundle without external telemetry:
  - `GET /api/v1/sessions/:id/evidence` resolves internal, registry-path, and runtime-native identifiers to one canonical session id.
  - The default response is bounded and diagnostic-first: aliases, runtime/status/backend metadata, exact runtime source locators, bounded process-local diagnostics, durable run-receipt summary, warnings, and links to the existing full read paths.
  - `expand=diagnostics,transcript,screen,runs` opts into bounded detail; prompts, raw JSONL, tool payloads, and the global operational snapshot are never included by default.
  - WebSocket Pi prompt correlation now maps session paths to the registry id with a fail-safe path fallback, so browser-originated logs are discoverable through canonical session diagnostics.
  - `npm run debug:where -- --json <id>` provides matching offline locator evidence while preserving the existing text output.
  Old `1.9.x` clients can ignore the additive endpoint and fields.
- **1.9.0** (minor, additive) — added lightweight local observability without external telemetry:
  - `GET /api/v1/health` retains the legacy runtime availability strings and adds a unified `runtimeHealth` matrix with enabled/available/backend/check status, bounded check timing, and the latest scrubbed failure.
  - diagnostics responses add a privacy-safe `operational` snapshot with bounded turn outcome/latency counters, pipeline-integrity counters, aggregate registry session counts, and worker/crash statistics.
  - diagnostics log filtering adds `requestId`, `runId`, `component`, `runtime`, and `since` selectors, alongside the existing bounded `limit`/`minLevel` filters.
  - the detailed runtime-health checks and diagnostics operational snapshot are bounded and process-local; consumers must not treat them as durable history and should use receipts/transcripts for restart-surviving evidence.
  Old `1.8.x` clients can ignore every new field; no existing route or field was removed.
- **1.8.0** (minor, additive with a corrected acceptance status) — hardened trusted multi-client operation and notification ingress:
  - `POST /api/v1/notifications` accepts an optional `Idempotency-Key`, durably queues before responding, returns `202 Accepted` plus `Location`/`statusUrl`, and returns `409 IDEMPOTENCY_KEY_CONFLICT` if a key is reused with a different payload.
  - `GET /api/v1/notifications/:notificationId` exposes pollable `pending | sent | failed` delivery state.
  - identical concurrent notification submissions join one durable enqueue; keys are hashed in the notification store.
  - enabled Internal API startup is now fail-closed when socket ownership/binding fails, owner-only socket mode is applied before readiness, and shutdown bounds persistent-connection grace before releasing ownership.
  - JSON request buffering is capped (1 MiB generally, 32 KiB for notification bodies), batch create/prompt calls are capped at 50 entries, and malformed path encoding returns a structured client error.
  Existing notification clients should accept any 2xx response; clients needing retry safety should reuse one idempotency key and poll the returned status URL. External Telegram delivery remains at least once.
- **1.7.0** (minor, additive) — completed model-aware max thinking-level support:
  - `max` is accepted by create-time and control-time thinking-level requests for runtimes that support thinking control.
  - Pi create-time requests apply the level after model selection, so GPT-5.6 models can be created directly at `max`.
  - OpenCode create-time requests apply the level after model selection, matching its existing reasoning-effort bridge.
  - `/api/v1/models` now advertises Claude model/profile thinking levels, including `max` for Sonnet, Opus, and Z.AI profiles while preserving Haiku's legacy ceiling.
  - Pi model entries continue to advertise their SDK-provided `thinkingLevels` metadata.
  Old clients can ignore the additive model metadata; clients that use `max` should capability-gate on `contractVersion >= 1.7.0`.
- **1.6.1** (patch) — hardened the `1.6.0` run-receipt contract:
  - a reservation rejected before runtime dispatch releases its idempotency key, so retrying after a local busy/state-check/persistence race cannot silently swallow the prompt;
  - streaming success is emitted only after the terminal receipt write completes, and response-transport setup failures terminalize an already-started receipt;
  - Pi receipts capture the live session model when registry metadata is absent or stale;
  - duplicate batch responses preserve the receipt's terminal error code instead of misreporting every non-completed run as `SESSION_BUSY`.
- **1.6.0** (minor, additive) — added run identity, session-scoped idempotent prompt dispatch, persisted run receipts, and `executionInstanceId`:
  - `idempotencyKey` on prompt dispatch (including batch entries) with a 24-hour default replay TTL and `(sessionId, idempotencyKey)` scope.
  - `runId` on answers/detached dispatch responses, `X-Run-Id` on streaming responses, and `GET /api/v1/runs/:runId` for receipt lookup.
  - `executionInstanceId` on session list/info projections and receipts (`claudeProfileId` for Claude, stable local defaults for the other runtimes).
  - receipts persist accepted/queued/started/terminal lifecycle state; server restarts recover in-flight records as `interrupted` with `SERVER_RESTART`, and bounded retention prunes old terminal records.
  - reusing a key for a different request returns `IDEMPOTENCY_KEY_CONFLICT` rather than silently swallowing a legitimate prompt. Old clients can ignore the additive fields/endpoints. See [`INTERNAL-API.md`](./INTERNAL-API.md).
- **1.5.0** (minor, additive) — added notification endpoints for one-way operator notifications and explicit emits:
  - `POST /api/v1/sessions/:id/notifications/opt-in`
  - `DELETE /api/v1/sessions/:id/notifications/opt-in`
  - `GET /api/v1/sessions/:id/notifications`
  - `POST /api/v1/notifications`
  - `GET /api/v1/notifications`
  These are additive endpoints and do not change existing session/prompt flows. Old clients can ignore them safely. See [`NOTIFICATIONS.md`](./NOTIFICATIONS.md) and [`INTERNAL-API.md`](./INTERNAL-API.md).
- **1.4.0** (minor, additive) — added the read-only screen-view projection to the
  transcript endpoint: `GET /sessions/:id/transcript?view=screen` (with optional
  `expand=tools,thinking`) returns a faithful "what the user sees by default"
  view (visible messages, collapsed tool cards, summarized/collapsed thinking,
  tool groups, skill placeholders) as both a structured `screenView` and a
  rendered `markdown` "text screenshot". Strictly read-only and prod-usable.
  Additive: the existing transcript behaviour is unchanged when `view` is
  absent. Old clients ignore the new param. See [`INTERNAL-API.md`](./INTERNAL-API.md).
- **1.3.0** (minor, additive) — added observability and introspection endpoints plus enriched error responses:
  - `GET /api/v1/diagnostics` and `GET /api/v1/sessions/:id/diagnostics` for self-service, secret-scrubbed recent logs.
  - `GET /api/v1/events/types` for a machine-readable catalogue of normalized SSE event kinds.
  - Error responses may now include additive `hint` and `docs` fields for the most actionable codes.
  Old clients can ignore the new endpoints and fields.
- **1.2.0** (minor, additive) — added standalone, time-bounded session pinning
  (`pin`/`pinTtlSeconds` on `POST /sessions` and `POST /sessions/batch`;
  `pinTtlSeconds` on `POST /sessions/:id/control` `pin` action) and detached
  fire-and-forget prompt dispatch (`detach` on `POST /sessions/:id/prompt`,
  returns `202`). API pins carry an absolute expiry surfaced as `pinnedUntil`
  and are revoked automatically (default 24h, hard max 7d). Old clients ignore
  the new fields. See [`INTERNAL-API.md`](./INTERNAL-API.md).
- **1.1.0** (minor, additive) — added the durable watch endpoints
  `POST/GET/DELETE /sessions/:id/watch` for long-horizon validation. Old
  clients can ignore them. See [`LONG-HORIZON-VALIDATION.md`](./LONG-HORIZON-VALIDATION.md).
- **1.0.0** — initial contracted surface.

Implementation source of truth:

- `server/src/internal-api/types.ts` — TypeScript request/response contract and contract metadata constants
- `docs/INTERNAL-API.md` — endpoint reference
- `docs/INTERNAL-API-ORCHESTRATION.md` — orchestration usage patterns
- `/root/.pi/agent/skills/pi-web-ui-internal-api-orchestration/SKILL.md` — reusable agent-facing operational guide on this machine

## Why this matters

The Internal API is no longer only a live-validation helper. It is also a local backend surface for trusted same-machine consumers. One important consumer under active design is a separate Agent OS project that will use Pi Web UI as its runtime control plane while keeping its own memory, project, and work-object state.

Do not assume the web UI frontend is the only consumer of this API.

## Versioning model

Pi Web UI uses two related version identifiers:

### 1. Route major version

The path prefix, currently `/api/v1`, is the coarse compatibility boundary.

Breaking changes require a new route major version, for example `/api/v2`, unless there is an explicit migration window and all known local consumers are updated together.

### 2. Contract version

`contractVersion` is a SemVer-style version for the `/api/v1` contract.

Use it as follows:

- **Patch** — documentation clarifications, bug fixes, or response additions that do not change existing fields or semantics.
- **Minor** — additive endpoint, field, capability, or enum value that old clients can ignore safely.
- **Major** — breaking change. Prefer a new route prefix such as `/api/v2` instead of changing `/api/v1` in place.

While the API is marked `beta`, minor additive changes are expected. Breaking changes still require deliberate migration notes.

## Compatibility rules

For `/api/v1`, preserve these rules:

1. **Additive changes are preferred.** Add fields instead of renaming or removing fields.
2. **Existing field meanings are stable.** Do not silently change semantics of a documented field.
3. **Unknown fields must be safe to ignore.** Consumers should not need to exhaustively parse every object property.
4. **Runtime differences must remain explicit.** Put new runtime capability differences under `/capabilities` before depending on them.
5. **Completion must be machine-detectable.** If an orchestration flow can run work, it must expose a reliable completion path via `/wait`, `/transcript`, or documented SSE events. For a prompt whose caller may disconnect, use `detach:true` with `verbosity=answers` and retain the returned `runId`.
6. **Claude channel event caveats stay documented.** Do not imply all runtimes have identical event reliability.
7. **Local-only security boundary stays intact.** Keep Unix-socket + bearer-token assumptions unless a separate public API is intentionally designed.
8. **Trusted multi-client, not multi-tenant.** Every process holding the shared token can inspect and control every API session. Concurrency safety does not provide tenant isolation or per-client authorization.
9. **Retention ownership and execution capacity are separate.** Durable recovery claims do not imply residency, residency does not grant a turn permit, and only the owner-selected lease id may be renewed/released.
10. **Pi Web UI is final admission authority.** External conductors may preflight `/capacity`, but prompt admission is rechecked atomically against process-local concurrency and measured memory headroom while preserving interactive reserve.

## Error code catalog

Every error response has the stable shape `{ error, code }` (plus optional
additive `hint`/`docs`, see below). The `code` strings are a **contracted** set:
consumers (live-validation scripts, the orchestration skill, Agent OS-style
local tools) switch on their exact values, so they must never change. Adding a
new code is additive and safe; renaming or removing one is a breaking change.

The single source of truth is `server/src/internal-api/error-codes.ts`
(`ErrorCode` constants + `ERROR_CODE_INFO` metadata). Routes reference
`ErrorCode.SESSION_NOT_FOUND` etc.; raw `code: '…'` literals must not be
re-introduced.

| Code | HTTP | Meaning | Typical cause |
|---|---|---|---|
| `UNAUTHORIZED` | 401 | Missing/invalid bearer token | No/wrong `Authorization: Bearer <token>` |
| `METHOD_NOT_ALLOWED` | 405 | HTTP method unsupported for endpoint | e.g. `PUT` on a GET-only route |
| `NOT_FOUND` | 404 | Unknown endpoint / API version | Path not matched, or version ≠ `/api/v1` |
| `INVALID_REQUEST` | 400 | Missing/malformed required field or URL encoding | e.g. no `runtime`; malformed path escape; `detach:true` with streaming verbosity |
| `PAYLOAD_TOO_LARGE` | 413 | Request exceeds bounded parser limit | More than 1 MiB generally or 32 KiB on notification endpoints |
| `SESSION_NOT_FOUND` | 404 | No session with that id | Wrong/expired id, or session deleted |
| `SESSION_BUSY` | 409 | Session already processing a prompt | A session runs one prompt at a time |
| `SESSION_NOT_STREAMING` | 409 | Operation requires an active turn | Idle `steer` or strict idle `follow_up` |
| `SESSION_CREATE_FAILED` | 500 | Session creation failed | Runtime threw while provisioning |
| `RUNTIME_UNAVAILABLE` | 503 | Runtime not installed/enabled | Binary missing, disabled via env, or unhealthy |
| `OPENCODE_UNAVAILABLE` | 503 | OpenCode backend unavailable | OpenCode not enabled, or recycle failed |
| `RUNTIME_ERROR` | 500 | Runtime failed mid-prompt | Provider/model/tool/abort error |
| `PROMPT_INJECTION` | 400 | Prompt blocked by safety filter | Injection-like text detected pre-runtime |
| `ASK_ALREADY_CLOSED` | 409 | `AskUserQuestion` dialog already closed | Answer arrived after timeout/abort/turn-end/disconnect resolution |
| `APPROVAL_REQUEST_NOT_FOUND` | 404 | No live approval matches the supplied alias | Unknown/wrong-session `requestId` or `toolCallId` |
| `UNSUPPORTED_OPERATION` | 400 | Op not supported for this runtime/config | e.g. `steer` outside Pi |
| `NOT_IMPLEMENTED` | 501 | Endpoint exists but runtime path unimplemented | e.g. replay history for unsupported runtime |
| `INTERNAL_ERROR` | 500 | Unexpected internal error | Unhandled exception in a route |
| `RETENTION_CLAIM_NOT_FOUND` | 404 | Retention lease absent | Wrong, expired, released, or different-session lease id |
| `RETENTION_CLAIM_OWNER_MISMATCH` | 409 | Conditional owner check failed | Caller supplied a different owner id |
| `RETENTION_RESIDENT_CAPACITY_EXHAUSTED` | 409 | Required residency could not be applied | Runtime could not materialise/retain the new session |
| `RETENTION_STORE_UNAVAILABLE` | 503 | Lease guarantee could not be persisted | Owner-only ledger unavailable/unwritable |
| `ADMISSION_CAPACITY_EXHAUSTED` | 429 | Turn admission temporarily refused | Global/runtime budget or measured memory headroom |
| `WATCH_NOT_FOUND` | 404 | No long-horizon watch for session | GET/DELETE `/watch` before POST, or post-restart |
| `TRANSFER_DISPATCH_FAILED` | 500 | Transfer could not be dispatched | Target creation / injection / IO failure |
| `EMPTY_TRANSCRIPT` | 404 | No visible transcript yet | `/transcript` before any turn produced content |
| `RUN_NOT_FOUND` | 404 | No persisted run receipt exists | Unknown or retention-pruned `runId` |
| `TURN_STALLED` | 500 | Accepted run exceeded its idle/absolute watchdog | Runtime stopped emitting events or queued work could not be correlated |
| `IDEMPOTENCY_KEY_CONFLICT` | 409 | Key reused for a different request | Same endpoint-scoped key has a different request fingerprint (prompt dispatch or explicit notification payload) |
| `PROVIDER_NOT_ALLOWED` | 403 | Pi provider blocked on the Internal API | Operator policy prevents agent execution through a metered provider |
| `MODEL_NOT_APPLIED` | 422 | The explicit Pi model selector was refused or not applied; the session was not created (1.21.0) | Use the exact `provider/model` selector from the models list |

### Additive error enrichment (`hint`, `docs`)

The most actionable codes additionally include a `hint` (an
agent/human-actionable next step) and/or a `docs` anchor. These fields are
**additive** — existing `{ error, code }` consumers ignore them. See
[`docs/OBSERVABILITY.md`](./OBSERVABILITY.md).

```json
{ "error": "Session not found", "code": "SESSION_NOT_FOUND", "hint": "List current sessions with GET /api/v1/sessions …" }
```

## Required workflow for API changes

When changing the Internal API:

1. Update TypeScript types in `server/src/internal-api/types.ts`.
2. Update route implementation under `server/src/internal-api/routes/`.
3. Update or add unit tests under `server/tests/unit/internal-api/`.
4. Update `docs/INTERNAL-API.md` for endpoint/reference changes.
5. Update `docs/INTERNAL-API-ORCHESTRATION.md` if orchestration behaviour changes.
6. Update this contract document if compatibility/versioning rules change.
7. If the change affects known local consumers such as Agent OS, update their contract notes before merging or record an explicit migration task.
8. Run at least the relevant Internal API tests and typecheck before committing.

## Agent OS coordination note

Agent OS should treat Pi Web UI as a runtime gateway, not as its own source of truth. Agent OS should store durable work state itself and record Pi Web UI session IDs as execution/evidence references.

Pi Web UI should expose stable enough session, event, transcript, transfer, and usage primitives for that local consumer without importing Agent OS concepts into the Pi Web UI data model.

> **1.20.0 note for Agent OS callers:** Command Code creation no longer requires `invocationRole` or `commandCodeAttestation` — both are accepted and ignored, so existing callers keep working while the fields are retired on the Agent OS side. The Agent OS mirror of this contract is maintained in the Agent OS repository at `/root/agent-os/docs/PI-WEB-UI-INTERNAL-API-CONTRACT.md` and is intentionally not edited from here.

Practical contract boundary:

```text
Agent OS owns: identity/role/project/thread/horizon memory, durable work objects, conductor state.
Pi Web UI owns: runtime adapters, live sessions, normalized events, replay/transcript access, local runtime orchestration API.
```

## Agent-facing skill

For agents operating on this machine, the reusable operational guide is:

```text
/root/.pi/agent/skills/pi-web-ui-internal-api-orchestration/SKILL.md
```

Use that skill for orchestration workflows and keep it aligned with this contract when endpoint behaviour changes.
