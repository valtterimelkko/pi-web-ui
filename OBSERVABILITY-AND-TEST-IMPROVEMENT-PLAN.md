# Observability, Logging & Test-Suite Improvement Plan

> **Audience:** an autonomous reasoning agent (1M-token context window) that will execute this plan **end-to-end** in this repository.
> **Status:** APPROVED FOR EXECUTION. No code has been written yet — you are the builder.
> **Author of plan:** a senior analysis pass over the repo. You should trust the file/line references but **verify them before editing** (the repo moves).

---

## 0. How to read and use this document

This plan is written to be executed by a capable agent that is nonetheless **less of a deep reasoner than the author**. That has two consequences you must internalize:

1. **The intent sections are not decoration.** They exist so that when reality diverges from the literal instructions (a file moved, a function was renamed, a better seam exists), you can make a *correct autonomous decision* by optimizing for the stated intent rather than the stated letter. When in doubt, re-read the intent and choose the option that best serves it.
2. **The "Definition of Done" (DoD) for each task is a contract, not a suggestion.** The human reviewer will push back hard against anything claimed "done" that does not meet every checkbox. Do **not** mark a task complete, summarize it as complete, or move on until **every** DoD item is literally true and you have **demonstrated** it (test output, validation transcript, or command output pasted into your working notes). "It should work" is a failure. "Here is the passing output" is success.

**Golden rule of this plan:** *No victory is claimed without evidence. Every change is proven by an automated test, and every behavior that crosses the Internal API or a real runtime is additionally proven by live validation.*

---

## 1. Purpose & intent (read this fully before doing anything)

### 1.1 Why this work exists

Pi Web UI is troubleshooted, extended, and fixed primarily by **AI coding agents** (like you), not only humans. The faster and cheaper those agents can understand what the system is doing, the more reliable the whole project becomes. Today the codebase is functionally rich but **observability-poor for agents**: logging is ad-hoc, errors are frequently swallowed, the Internal API does not let an agent introspect its own diagnostics, and the test suite buries real signal under noise. Every one of those gaps translates directly into **wasted agent tokens, slower troubleshooting, and unreliable pass/fail signals.**

The goal of this plan is to make the repository **maximally legible to a reasoning agent**: when something breaks, an agent should be able to find the cause in *one or two* reads/commands instead of ten, and should be able to *trust* the green/red signal it gets back.

### 1.2 The three outcomes we are optimizing for

Every decision you make should serve at least one of these, and never sacrifice one without a stated reason:

1. **Fewer tokens to diagnose.** Structured, level-filtered, correlated logs and self-describing errors mean an agent reads less to understand more.
2. **Faster troubleshooting.** An agent can turn on exactly the subsystem it cares about, fetch diagnostics over the API it already uses, and run a narrow test loop instead of the whole suite.
3. **Trustworthy signal.** Red means red. A green test run means the change is actually safe. Live validation proves real runtime behavior, not just mocked behavior.

### 1.3 Non-goals / guardrails (do NOT do these)

- **Do not rewrite working subsystems.** This is an *additive observability and test-hygiene* effort. Preserve all existing behavior, contracts, auth, CSRF, origin checks, and path validation.
- **Do not change the Internal API contract in a breaking way.** You may *add* endpoints, fields, and error metadata. You may not remove or rename existing endpoints/fields/codes. Existing consumers (live-validation scripts, the orchestration skill) must keep working.
- **Do not introduce a heavy logging dependency without justification.** Prefer a small in-house logger. If you choose a library (e.g. `pino`), it must be justified against bundle/footprint and the existing `[Tag]` convention, and it must support all required modes (levels, namespaces, JSON, pretty).
- **Do not commit secrets, tokens, cookies, session dumps, or local machine files.** Treat the repo as permanently public.
- **Do not silence errors to make tests pass.** If a test fails, fix the cause or document why it is legitimately skipped.
- **Do not leave the build, typecheck, or lint broken** at the end of any task.

### 1.4 Baseline facts measured at plan time (for your orientation — re-measure, don't trust blindly)

| Signal | Value at plan time |
|---|---|
| `console.*` calls in `server/src` | ~331 across ~47 files |
| Central logger / log levels | none (only `OPENCODE_DEBUG_RAW_EVENTS` flag + one `verboseLogging` option) |
| Silent error swallows | ~181 bare `catch {}` + ~47 `.catch(() => …)` |
| Global `uncaughtException`/`unhandledRejection` handlers in `server/src/index.ts` | none |
| Internal-API error codes | ~16 distinct string literals, no central enum/catalog |
| Server test run | ~1740 tests, ~121 files, ~37s wall, ~987MB RSS, ~22.5s of that is collection |
| Test output that is `[Tag]` log noise | ~776 / ~1921 lines (~40%) |
| Failing at baseline | 3 (2 known SSE hangs + 1 `dual-path-coexistence`) |
| Test files using real timers | ~14 (vs ~13 using fake timers) |

---

## 2. Operating rules for the executing agent

### 2.1 Required reading before you start (signposts)

Read these first. They are the canonical knowledge; this plan links to them rather than duplicating them.

- `CLAUDE.md` / `AGENTS.md` — root agent guide (these two **must stay byte-identical**, see §2.5).
- `docs/MAINTAINER-INDEX.md` — index of all docs.
- `docs/ARCHITECTURE.md`, `docs/CODEBASE-MAP.md` — system shape and where things live.
- `docs/EVENT-PIPELINE.md`, `docs/PROTOCOL.md` — event normalization & WebSocket protocol.
- `docs/INTERNAL-API.md`, `docs/INTERNAL-API-CONTRACT.md`, `docs/INTERNAL-API-ORCHESTRATION.md` — the agent-facing backend boundary you will extend.
- `docs/LIVE-VALIDATION.md`, `docs/LONG-HORIZON-VALIDATION.md` — how to prove runtime behavior.
- `docs/TROUBLESHOOTING.md` — current log/session-file map and `npm run debug:where`.
- `SECURITY.md` — auth/CSRF/path-validation/prompt-injection rules you must preserve.

### 2.2 Key file locations you will touch or reference

- Server entry / startup: `server/src/index.ts`
- Config & env: `server/src/config.ts`, `.env.example`
- Internal API: `server/src/internal-api/` (`server.ts`, `routes/*.ts`, `types.ts`, `sse-stream.ts`, `event-broker.ts`, `event-filter.ts`)
- Existing structured logging precedent: `server/src/workers/crash-logger.ts`
- Existing correlation seam: `server/src/pi/event-forwarder.ts` (`setRequestCorrelation`)
- Existing per-connection verbose flag precedent: `server/src/websocket/session-websocket.ts`
- Test configs: `server/vitest.config.ts`, `client/vitest.config.ts`, `shared/vitest.config.ts`, `tests/benchmarks/vitest.bench.config.ts`
- Client test setup: `client/tests/setup.ts`
- Lint config: `.eslintrc.json`
- Validation scripts: `scripts/validation-server.ts`, `scripts/live-validate.ts`, `scripts/long-horizon-validate.ts`, `scripts/debug-where.mjs`
- Docs sync scripts: `scripts/sync-agent-guides.mjs`, `scripts/check-agent-guides.mjs`

### 2.3 Mandatory workflow per task (TDD)

For **every** code task, in this order:

1. **Re-read the intent** for the task and confirm the file references still exist (grep/read first).
2. **Write the test first** (or extend an existing test) that fails for the right reason. Run it; confirm it fails.
3. **Implement the minimal change** to make it pass. Keep diffs minimal and idiomatic to surrounding code.
4. **Run the task's test boundary** (see each task's "How to test").
5. **Run the global gates** (§2.4) relevant to what you changed.
6. **Live-validate** if the task touches the Internal API or real runtime behavior (§3).
7. **Only then** check the DoD boxes and record evidence.

### 2.4 Global gates (must pass before any task is "done")

Run and confirm clean (relative to the documented baseline) for any task that changes code:

```bash
npm run lint
npm run typecheck
npm run build
npm test            # server + client; compare against the known baseline failures (see Task 15)
```

If you changed `CLAUDE.md` or `AGENTS.md`, also run §2.5.

> **Baseline-failure handling:** Until Task 15 is complete, `npm test` will show the 2 known SSE hangs in `server/tests/unit/internal-api/session-routes-orchestration.test.ts` and possibly `dual-path-coexistence`. These are **pre-existing**, not your regression. You must (a) confirm the failing set is *exactly* the documented baseline before and after your change, and (b) never let your change add a new failure. After Task 15, the baseline is **zero** failures and any failure is yours.

### 2.5 The CLAUDE.md / AGENTS.md sync rule (do not forget)

`AGENTS.md` and `CLAUDE.md` must stay **byte-identical**. `AGENTS.md` is the maintainer source. Any task that edits one (e.g. Task 21 adds a doc link) must edit `AGENTS.md` then run:

```bash
npm run docs:sync-agent-guides
npm run docs:check-agent-guides
```

### 2.6 The Definition of Ready (entry criteria for starting a task)

Before starting any task, it is "ready" only if: you have read its intent; you have confirmed its target files exist (or located their moved equivalents); you understand its test boundary; and you have the global gates passing on the current tree (baseline known-good). If any is false, resolve it first.

---

## 3. Testing & live-validation doctrine (THE quality bar)

This is the most important section. The human reviewer will push hardest here.

### 3.1 Two layers of proof, both required where applicable

1. **Automated tests (always).** Unit/integration tests via Vitest. Every behavioral change must be covered by a test that would fail without the change. No exceptions.
2. **Live validation (whenever the change crosses the Internal API or affects real runtime behavior).** Mocked tests prove logic; live validation proves the system actually behaves correctly against a real backend.

A task that adds an Internal API endpoint, changes error responses, changes logging that an agent consumes over the API, or changes runtime behavior is **not done** until it is live-validated.

### 3.2 How to live-validate — use the orchestration skill

For all Internal API / real-runtime live validation, **use the skill named `pi-web-ui-internal-api-orchestration`** (the "Pi Web UI Internal API orchestration / live-validation" skill). You have it available exactly as the plan author does — invoke it by name; you do not need a filesystem path. It knows how to spin up a disposable validation server, exercise real sessions across Pi/Claude/OpenCode/Antigravity, and report a PASS/FAIL verdict.

For checks that must wait minutes-to-hours for a condition (durable watches, restart survival), use the sibling skill **`pi-web-ui-long-horizon-validation`** instead.

The underlying mechanics (also documented in `docs/LIVE-VALIDATION.md`) are:

```bash
# 1. Start a disposable validation server (ephemeral; does not touch real sessions)
npm run validate:server

# 2. Run a scenario against it
npm run validate:live -- \
  --socket <validation.sock> \
  --token-path <validation-token> \
  --runtime <pi|claude|opencode|antigravity|all> \
  --scenario <id>
```

- Prefer `--runtime pi` for fast, dependency-free validation of API-shape/observability changes; use `all` when a change must hold across runtimes.
- **Never** run against production. Production is only ever used with explicit human permission plus `--allow-production`. This plan does **not** grant that permission.
- When validating new behavior that no scenario covers, add a scenario (or use the skill's ad-hoc orchestration) — do not skip live validation because "there's no scenario."

### 3.3 The narrow test loop (use this while iterating; saves time and tokens)

Do not run the whole suite on every edit. Run the single file/test:

```bash
# one file
npx vitest run path/to/file.test.ts --root server
# one test by name
npx vitest run --root server -t "name of the test"
```

Run the full `npm test` only at task completion and before commit.

### 3.4 Evidence you must capture per task

For each task, keep working notes containing: the failing-then-passing test output for the new test; the global-gate results; and (where applicable) the live-validation PASS verdict (scenario id + runtime + summary). The human may ask to see any of these.

---

## 4. Execution phases & task list

Execute in phase order. Within a phase, order is flexible but respect dependencies noted per task. Tasks map 1:1 to the 22 analysis items.

> **Sequencing rationale:** Phase A delivers immediate agent-experience wins cheaply and de-risks the rest. Phase B builds the structural backbone (central logger, correlation, diagnostics, trustworthy tests) that everything else leans on. Phase C hardens and prevents regression. Doing the central logger (Task 1) is easier *after* levels/namespaces are designed (Tasks 2–3), so they are sequenced accordingly.

---

### PHASE A — Quick wins (low effort, high impact)

#### Task 14 — Silence test console output by default
**Intent:** ~40% of test output is `[Tag]` log noise that buries the actual assertion when a test fails, costing agents large token counts to locate the real error. Make failing-test output legible.

**Actions:**
- In `server/vitest.config.ts` and `client/vitest.config.ts`, add an `onConsoleLog` hook (or `silent`/console-intercept config) that **suppresses app console output by default** but is re-enabled by an env flag (e.g. `VITEST_LOG=1`).
- Ensure genuine test-framework output (assertion diffs, errors, reporter summary) is **never** suppressed.
- Document the `VITEST_LOG=1` opt-in in the test docs / `docs/TROUBLESHOOTING.md`.

**Files:** `server/vitest.config.ts`, `client/vitest.config.ts`, (optionally) `shared/vitest.config.ts`.

**How to test:** Run `npm test` and confirm the `[MultiSessionManager]`-style lines are gone from output while pass/fail counts are unchanged. Run with `VITEST_LOG=1` and confirm the logs reappear.

**Definition of Done:**
- [ ] Default `npm test` output contains **no** app `[Tag]` log lines (verify by grepping the captured output for `^\[`).
- [ ] `VITEST_LOG=1 npm test` restores full app logging.
- [ ] Test pass/fail counts identical to baseline before the change (no tests altered, only console behavior).
- [ ] Opt-in flag documented.
- [ ] Global gates pass.

---

#### Task 2 — Log levels with a runtime env switch
**Intent:** Everything is unconditional `console.log`; agents drown in init chatter. A level switch lets an agent re-run a repro at `debug` and get only relevant output. (Designed before Task 1 so the central logger can honor it.)

**Actions:**
- Define a `LOG_LEVEL` env var (`error|warn|info|debug`, default `info`) wired through `server/src/config.ts`.
- Specify the level semantics that the central logger (Task 1) will implement: `error` = failures needing attention; `warn` = recoverable anomalies; `info` = lifecycle milestones; `debug` = per-operation detail.

**Files:** `server/src/config.ts`, `.env.example`, (consumed by) Task 1's logger.

**How to test:** Unit test the config parsing (valid value, invalid value falls back to `info`, default is `info`). After Task 1, add a logger test asserting that messages below the configured level are dropped.

**Definition of Done:**
- [ ] `LOG_LEVEL` parsed and validated in config with a safe default.
- [ ] Documented in `.env.example` with allowed values and meaning.
- [ ] Unit test covers default + override + invalid-fallback.
- [ ] Global gates pass.

---

#### Task 3 — Per-component debug namespaces
**Intent:** The `[Tag]` taxonomy (`[MultiSessionManager]`, `[ClaudeChannel]`, `[OpenCodeSSE]`, …) already exists informally. Formalize it so an agent can enable exactly the subsystem it's debugging (e.g. `DEBUG=claude,opencode-sse`) and nothing else — an order-of-magnitude token reduction per debug session.

**Actions:**
- Define a `DEBUG`-style namespace filter (comma-separated component names, `*` wildcard) wired through config and honored by the central logger (Task 1).
- Catalog the existing component tags (grep `console\.(log|error|warn|info)\(\s*['\`"]\[` in `server/src`) and define the canonical component-name list. Reuse existing tag names; do not invent a parallel taxonomy.

**Files:** `server/src/config.ts`, `.env.example`, the central logger (Task 1), and a documented component list (goes into `docs/OBSERVABILITY.md`, Task 21).

**How to test:** Unit test the namespace matcher (exact match, multiple, wildcard, no-match suppresses). Integration-style test that a logger bound to component `claude` emits when `DEBUG=claude` and is silent when `DEBUG=opencode`.

**Definition of Done:**
- [ ] Namespace filter implemented, wildcard supported, default = off (i.e. respects `LOG_LEVEL` only).
- [ ] Canonical component list documented and matches the names actually used in code after Task 1 migration.
- [ ] Unit tests cover match/no-match/wildcard.
- [ ] Global gates pass.

---

#### Task 6 — Global `uncaughtException` / `unhandledRejection` handlers
**Intent:** Today an unexpected throw outside a worker leaves no contextual log — "it just died." A handler that logs component + stack + active-session count turns that into a one-line diagnosis.

**Actions:**
- In `server/src/index.ts`, register `process.on('uncaughtException', …)` and `process.on('unhandledRejection', …)` that log via the central logger (Task 1) with: error message, full stack, and a small context snapshot (e.g. active session count from the registry if cheaply available).
- Follow Node best practice: log, then for `uncaughtException` perform a graceful shutdown/exit (do not silently continue in a corrupt state). Mirror the existing SIGTERM/SIGINT shutdown path already in `index.ts`.
- Ensure these do not interfere with the existing worker-level handlers (`server/src/workers/session-worker.ts`, `server/src/opencode/opencode-process-manager.ts`).

**Files:** `server/src/index.ts`.

**How to test:** Unit/integration test that emitting a simulated `unhandledRejection` invokes the logger with the expected shape (you can spy on the logger). For `uncaughtException`, test the handler function in isolation (extract it so it's testable without killing the test process).

**Definition of Done:**
- [ ] Both handlers registered exactly once at startup.
- [ ] Handler logs message + stack + context via central logger.
- [ ] `uncaughtException` triggers graceful shutdown consistent with existing shutdown logic.
- [ ] Extracted handler logic is unit-tested (does not kill the test runner).
- [ ] Global gates pass.

**Depends on:** Task 1 (uses central logger). If implementing before Task 1 lands, use a temporary direct log and refactor in Task 1 — but prefer ordering after Task 1.

---

#### Task 9 — Centralize Internal-API error codes into one catalog
**Intent:** ~16 error codes are inline string literals scattered across files — undiscoverable and prone to drift. A single exported catalog lets an agent map code → cause → fix without reading source.

**Actions:**
- Create `server/src/internal-api/error-codes.ts` exporting a const object / enum of all existing codes (grep `code: '` under `server/src/internal-api` to enumerate them — e.g. `METHOD_NOT_ALLOWED`, `SESSION_NOT_FOUND`, `INVALID_REQUEST`, `INTERNAL_ERROR`, `RUNTIME_ERROR`, `UNSUPPORTED_OPERATION`, `SESSION_CREATE_FAILED`, `RUNTIME_UNAVAILABLE`, `NOT_FOUND`, `WATCH_NOT_FOUND`, `PROMPT_INJECTION`, `NOT_IMPLEMENTED`, `TRANSFER_DISPATCH_FAILED`, `SESSION_BUSY`, `OPENCODE_UNAVAILABLE`, `EMPTY_TRANSCRIPT`).
- Replace inline literals with references to the catalog. **Values must not change** (consumers depend on the exact strings).
- Document each code (meaning + typical cause) in `docs/INTERNAL-API-CONTRACT.md`.

**Files:** new `server/src/internal-api/error-codes.ts`; edits across `server/src/internal-api/**`; `docs/INTERNAL-API-CONTRACT.md`.

**How to test:** Unit test that the catalog contains every code, that values are unchanged strings. Grep to prove no inline `code: '…'` literals remain in internal-api (or document the few intentional exceptions).

**Definition of Done:**
- [ ] Catalog module created; all codes present with stable string values.
- [ ] All internal-api routes reference the catalog (verified by grep).
- [ ] Every code documented in `docs/INTERNAL-API-CONTRACT.md`.
- [ ] Live-validate: run an orchestration scenario (via `pi-web-ui-internal-api-orchestration`) that triggers at least 2 error codes (e.g. unknown session → `SESSION_NOT_FOUND`, bad method → `METHOD_NOT_ALLOWED`) and confirm the wire response codes are byte-identical to before.
- [ ] Global gates pass.

---

#### Task 20 — Document the fast inner-loop test recipe
**Intent:** The required workflow currently points only at full `npm test`. A documented narrow loop (single file/test, console enabled, JSON out) directly reduces agent iteration cost. Pure docs.

**Actions:**
- Add a "Fast test loop for agents" section to `docs/TROUBLESHOOTING.md` (and reference from `docs/OBSERVABILITY.md`, Task 21) with the `npx vitest run <file>` / `-t "name"` recipes from §3.3, the `VITEST_LOG=1` flag, and the JSON reporter (Task 16).

**Files:** `docs/TROUBLESHOOTING.md`.

**Definition of Done:**
- [ ] Section added with copy-pasteable commands for: single file, single test, console-on, machine-readable output.
- [ ] Cross-linked from the observability doc once Task 21 lands.
- [ ] `npm run docs:check-agent-guides` still passes (docs-only change, but run it).

---

#### Task 21 — Write `docs/OBSERVABILITY.md` and link it from the agent guide
**Intent:** Agents read `CLAUDE.md` first. One canonical observability doc, linked from the guide, eliminates repeated rediscovery of log format, levels, namespaces, correlation IDs, diagnostics endpoint, error catalog, and the fast test loop.

**Actions:**
- Create `docs/OBSERVABILITY.md` documenting (as they land): log format & levels (Tasks 1–2), component namespaces (Task 3), correlation-ID story (Task 5), diagnostics endpoint (Task 10), error-code catalog (Task 9), structured error responses (Task 11), event-type registry (Task 12), request logging (Task 13), and the fast test loop (Task 20).
- Add a row to the "If you need to change X, read Y" table in **`AGENTS.md`** pointing to it, then run the sync (§2.5) so `CLAUDE.md` matches.

**Files:** new `docs/OBSERVABILITY.md`; `AGENTS.md` (then synced to `CLAUDE.md`); `docs/MAINTAINER-INDEX.md` (add to index).

**Definition of Done:**
- [ ] `docs/OBSERVABILITY.md` exists and accurately reflects what was actually built (update it as later tasks land; final pass at end).
- [ ] Linked from `AGENTS.md` table and `docs/MAINTAINER-INDEX.md`.
- [ ] `AGENTS.md` and `CLAUDE.md` byte-identical (`npm run docs:check-agent-guides` passes).

> **Note:** This doc is "living" — start it early, finish it last so it matches reality. Its final accuracy is part of the Phase-end acceptance (§5).

---

### PHASE B — Structural backbone (medium effort, high/very-high impact)

#### Task 1 — Introduce one central logger and migrate `console.*`
**Intent:** A single, greppable, level-and-namespace-filterable log format means an agent reads one log shape instead of reverse-engineering 47 files. This is the backbone the rest of the logging work hangs on.

**Actions:**
- Create `server/src/logging/logger.ts` exposing a `createLogger(component)` (or equivalent) that honors `LOG_LEVEL` (Task 2), `DEBUG` namespaces (Task 3), and `LOG_FORMAT` (Task 4). Preserve the existing `[Component]` prefix convention as a structured `component` field; keep human-readable pretty output as default.
- Migrate the ~331 `console.*` calls in `server/src` to the logger, mapping each call to the right level and the existing tag to the `component`. Do this systematically by directory; keep diffs minimal and mechanical.
- Keep `server/src/workers/crash-logger.ts` behavior intact (it is the existing structured-logging precedent; align format if cheap, but do not regress it).
- Leave deliberate `console` usage in CLI scripts (`scripts/*`) as-is unless trivially beneficial — the target is the server runtime.

**Files:** new `server/src/logging/logger.ts`; broad edits across `server/src/**`.

**How to test:** Unit tests for the logger: level filtering, namespace filtering, component field, format switching. After migration, grep to confirm `console.*` in `server/src` is reduced to an approved minimal set (document any intentional remainder).

**Definition of Done:**
- [ ] Logger module exists with full unit coverage (levels, namespaces, format, component).
- [ ] `console.*` count in `server/src` reduced to a documented, justified minimum (target: near-zero in runtime code paths).
- [ ] Existing log *content* preserved (no loss of information; tags become components).
- [ ] `crash-logger.ts` still works (covered by its existing tests).
- [ ] Live-validate: run a `pi-web-ui-internal-api-orchestration` scenario at `LOG_LEVEL=debug` and confirm logs are emitted in the new format and are coherent for a full prompt lifecycle.
- [ ] Global gates pass.

**Depends on:** Tasks 2, 3, 4 (their behaviors are implemented or honored here). It is acceptable to land 2/3/4 as part of this task's PR if cleaner, as long as each has its own tests.

---

#### Task 4 — Optional JSON log mode (`LOG_FORMAT=json`)
**Intent:** Structured JSON lines (`{ts, level, component, sessionId, runtime, msg, …}`) are far cheaper for an agent to filter/parse than free text, and they enable the diagnostics endpoint (Task 10). Pretty text stays the human default.

**Actions:**
- Add `LOG_FORMAT` env (`pretty|json`, default `pretty`) to config and implement both renderers in the central logger.
- JSON mode emits one JSON object per line with stable field names.

**Files:** `server/src/config.ts`, `.env.example`, `server/src/logging/logger.ts`.

**How to test:** Unit test that `pretty` produces the human format and `json` produces valid, parseable JSON with the required fields.

**Definition of Done:**
- [ ] Both formats implemented and unit-tested; default is `pretty`.
- [ ] JSON lines are valid JSON with stable keys (`ts`, `level`, `component`, `msg`, plus optional `sessionId`/`requestId`/`runtime`).
- [ ] Documented in `.env.example` and `docs/OBSERVABILITY.md`.
- [ ] Global gates pass.

---

#### Task 5 — Thread a correlation / session ID through the prompt path
**Intent:** **This is the single biggest token-saver for troubleshooting.** Today logs rarely carry the request/session id, so an agent must stitch the causal chain from timestamps. Stamping `sessionId` + `requestId` on every log line for a prompt's lifecycle lets an agent `grep <id>` and get the whole story in one pass. `server/src/pi/event-forwarder.ts` already has `setRequestCorrelation` — build on that seam.

**Actions:**
- Establish a correlation id at the entry of a prompt (Internal API `prompt` handler and the WebSocket prompt path), propagate it through to the logger calls along that path. Prefer a lightweight context mechanism (explicit parameter threading, or `AsyncLocalStorage` if it fits cleanly without large refactors).
- Ensure `sessionId` and `requestId` appear as structured fields on log lines emitted during a prompt's handling across the runtimes.
- Reuse / align with the existing `event-forwarder` correlation rather than inventing a parallel scheme.

**Files:** `server/src/internal-api/routes/sessions.ts`, `server/src/websocket/connection.ts`, `server/src/pi/event-forwarder.ts`, the logger, and the per-runtime services as needed.

**How to test:** Integration test that, for a simulated prompt, the emitted log lines carry a consistent `requestId` and the correct `sessionId` from entry through event forwarding.

**Definition of Done:**
- [ ] A prompt's lifecycle log lines share one `requestId` and carry the `sessionId`.
- [ ] Mechanism reuses/extends the existing correlation seam (no parallel duplicate).
- [ ] Integration test proves the id propagates across at least one full prompt path.
- [ ] Live-validate: via `pi-web-ui-internal-api-orchestration`, send a prompt at `LOG_FORMAT=json LOG_LEVEL=debug`, capture logs, and demonstrate that filtering by the single `requestId` yields the full coherent lifecycle. Paste the filtered transcript as evidence.
- [ ] Global gates pass.

**Depends on:** Tasks 1, 4.

---

#### Task 10 — Diagnostics endpoint over the Internal API
**Intent:** The missing piece. Today an agent must shell out to `journalctl` (often unavailable in its sandbox). An in-process ring buffer exposed over the Unix socket the agent already uses lets agents **self-serve logs and recent errors** through the same API surface.

**Actions:**
- Add an in-memory ring buffer that captures recent structured log lines (cap size; cheap; no PII/secret leakage — scrub tokens).
- Add `GET /api/v1/diagnostics` (global) and/or `GET /api/v1/sessions/:id/diagnostics` (per-session) returning: recent log lines, last N errors, and lifecycle/state summary for the session. Wire it into `server/src/internal-api/server.ts` dispatch and a new handler in `routes/`.
- Protect it with the same auth as other internal-api routes (`internal-api/middleware/auth.ts`). Do not weaken auth.
- Respect `LOG_LEVEL`/namespace semantics; never return secrets/tokens/cookies (scrub before returning).

**Files:** new `server/src/internal-api/routes/diagnostics.ts`; `server/src/internal-api/server.ts`; logger (ring buffer hook); `docs/INTERNAL-API.md` + `docs/INTERNAL-API-CONTRACT.md`.

**How to test:** Unit/integration tests: endpoint returns buffered lines; respects auth (401/unauthorized without token); per-session filter works; secrets are scrubbed; ring buffer caps size.

**Definition of Done:**
- [ ] Endpoint(s) implemented, authed identically to existing internal-api routes, documented in the contract.
- [ ] Ring buffer is bounded and does not leak secrets (explicit scrub test).
- [ ] Additive only — no existing endpoint changed.
- [ ] Live-validate: via `pi-web-ui-internal-api-orchestration`, run a prompt, then call the diagnostics endpoint and demonstrate it returns coherent recent logs/errors for that session. Paste the verdict.
- [ ] Global gates pass.

**Depends on:** Tasks 1, 4, 5 (consumes structured + correlated logs).

---

#### Task 15 — Make the test baseline green (red means red)
**Intent:** A non-green baseline means agents waste turns deciding whether *their* change caused a failure. After this task, baseline failures = 0, so any failure is unambiguously the agent's.

**Actions:**
- Investigate the 2 SSE failures in `server/tests/unit/internal-api/session-routes-orchestration.test.ts` (`streams events to subscribers…`, `replays buffered events to late subscribers`) and the `tests/integration/claude/dual-path-coexistence.test.ts` failure.
- Determine root cause for each: real bug, test environment assumption, or genuinely-flaky timing. **Fix the cause** if it's a real bug or a fixable test. If a test is legitimately environment-dependent and cannot run here, `skip` it with a clear `// reason:` comment **and** a tracking note in `docs/TROUBLESHOOTING.md` — do not silently delete coverage.
- Prefer fixing over skipping. Skipping is a last resort with a documented justification.

**Files:** the three failing test files; possibly the SSE code (`server/src/internal-api/sse-stream.ts`, `event-broker.ts`) if a real bug.

**How to test:** Run the specific files in isolation and as part of the full suite, multiple times, to confirm determinism.

**Definition of Done:**
- [ ] `npm test` shows **0** failures, run 3× consecutively without flake.
- [ ] Any skipped test has an inline reason + a tracking entry in `docs/TROUBLESHOOTING.md`.
- [ ] If an SSE bug was found, it is fixed and live-validated via `pi-web-ui-internal-api-orchestration` (SSE `/events` scenario).
- [ ] Global gates pass.

> **After this task:** update §2.4 expectations in your working notes — baseline is now zero failures.

---

### PHASE C — Hardening & regression prevention

#### Task 7 — Audit and de-silence error swallows
**Intent:** ~181 bare `catch {}` + ~47 `.catch(() => …)` swallows are places where an agent's repro "succeeds" while actually failing. Surface the non-cleanup ones.

**Actions:**
- Enumerate all swallow sites in `server/src`. Classify each: (a) legitimate cleanup/best-effort (e.g. `unlink` of a maybe-missing socket) → leave, optionally add a one-line comment; (b) meaningful failure being hidden → convert to at least `logger.debug(...)` (or higher) with context.
- Prioritize `internal-api/`, `claude/`, `opencode/`.

**Files:** broad, prioritized as above.

**How to test:** For converted sites that matter, add/extend a test asserting the error path now logs (spy on logger). Grep before/after counts.

**Definition of Done:**
- [ ] Every swallow in the prioritized dirs is classified (cleanup vs hidden-failure) — produce the list in working notes.
- [ ] Hidden-failure swallows now log with context.
- [ ] Legitimate cleanup swallows are intentional/commented.
- [ ] No behavior change other than added logging.
- [ ] Global gates pass.

**Depends on:** Task 1.

---

#### Task 8 — Standardize error log shape (message + stack + context)
**Intent:** Stack-less error logs force agents into extra round-trips. Always log `error.message` + `error.stack` + the operation context.

**Actions:**
- Provide a logger helper for errors that captures `message`, `stack`, and a context object.
- Sweep error-logging sites (startup, internal-api, services) to use it; ensure stacks are included.

**Files:** `server/src/logging/logger.ts`; error-logging call sites.

**How to test:** Unit test the error helper includes message + stack + context. Spot-check key sites via tests where practical.

**Definition of Done:**
- [ ] Error helper exists and is used at the key error sites (startup, internal-api error responses, runtime services).
- [ ] Logged errors include stack + context.
- [ ] Global gates pass.

**Depends on:** Task 1.

---

#### Task 11 — Enrich error responses with `hint` (and optional `docs`)
**Intent:** Turn each Internal API error into a self-contained next step instead of a search. E.g. `RUNTIME_UNAVAILABLE` → `{code, error, hint, runtime}`.

**Actions:**
- Extend the error-response shape to optionally include `hint` (human/agent-actionable next step) and optionally `docs` (a doc anchor). **Additive** — existing fields unchanged.
- Populate hints for the most common/most actionable codes (at minimum `RUNTIME_UNAVAILABLE`, `SESSION_NOT_FOUND`, `PROMPT_INJECTION`, `SESSION_BUSY`, `UNSUPPORTED_OPERATION`).
- Document the enriched shape in `docs/INTERNAL-API-CONTRACT.md`.

**Files:** `server/src/internal-api/` (error helpers + routes), `error-codes.ts` (hints can live alongside the catalog), `docs/INTERNAL-API-CONTRACT.md`.

**How to test:** Unit test that responses for the targeted codes include a non-empty `hint`, and that the base shape (`code`, `error`) is unchanged.

**Definition of Done:**
- [ ] `hint` added to targeted error responses; shape is backward-compatible (additive).
- [ ] Documented in the contract doc.
- [ ] Live-validate: via `pi-web-ui-internal-api-orchestration`, trigger 2 enriched errors and confirm `hint` is present on the wire and `code` is unchanged.
- [ ] Global gates pass.

**Depends on:** Task 9.

---

#### Task 12 — Expose a structured event-type registry
**Intent:** Agents consuming the `/events` SSE stream currently infer event shapes from docs + source. A machine-readable list of event kinds per runtime cuts discovery tokens.

**Actions:**
- Produce a machine-readable registry of SSE event types per runtime (extend the `capabilities` endpoint, or add a dedicated `GET /api/v1/events/types` / similar). Derive it from the actual event taxonomy in `server/src/internal-api/event-filter.ts` / `event-broker.ts` and `docs/EVENT-PIPELINE.md`.
- Keep it in sync with reality (consider generating from a single source of truth to avoid drift).

**Files:** `server/src/internal-api/routes/capabilities.ts` (or new route), `event-filter.ts`/`event-broker.ts`, `docs/EVENT-PIPELINE.md`, contract doc.

**How to test:** Unit test the registry lists the known event kinds and matches what the broker can emit.

**Definition of Done:**
- [ ] Event-type registry exposed over the Internal API, authed like siblings.
- [ ] Matches the actual emitted event taxonomy (test-enforced).
- [ ] Documented.
- [ ] Live-validate: fetch the registry via `pi-web-ui-internal-api-orchestration` and confirm it lists the events actually seen on a live `/events` stream during a prompt.
- [ ] Global gates pass.

---

#### Task 13 — Request-level logging for the Internal API
**Intent:** `internal-api/server.ts` logs almost nothing per-request, so an agent can't see whether its call even arrived. Add method/path/status/duration/requestId at `debug` level.

**Actions:**
- Add request logging in the internal-api dispatch (`server/src/internal-api/server.ts` or `middleware/`) emitting method, path, status code, duration, and the correlation `requestId` (Task 5) at `debug` level.
- Never log secrets/tokens or full request bodies containing sensitive data.

**Files:** `server/src/internal-api/server.ts` (or `internal-api/middleware/`).

**How to test:** Integration test that a request produces a debug log line with method/path/status/duration when `LOG_LEVEL=debug`, and nothing at `info`.

**Definition of Done:**
- [ ] Per-request debug log line implemented with the five fields.
- [ ] No secrets/sensitive bodies logged.
- [ ] Test covers presence at `debug` and absence at `info`.
- [ ] Live-validate: via `pi-web-ui-internal-api-orchestration` at `LOG_LEVEL=debug`, confirm each API call produces a coherent request log line tied to the same `requestId` seen elsewhere.
- [ ] Global gates pass.

**Depends on:** Tasks 1, 5.

---

#### Task 16 — Machine-parseable test reporter
**Intent:** The default reporter is hard for agents to parse. A JSON (or junit) artifact lets an agent jump straight to the failing test + message.

**Actions:**
- Configure Vitest to emit a JSON report to a file (e.g. `reporter: ['default', 'json']` with `outputFile`) for server and client. Ensure the artifact path is git-ignored if it shouldn't be committed.
- Document how to consume it in the fast-loop section (Task 20).

**Files:** `server/vitest.config.ts`, `client/vitest.config.ts`, `.gitignore` if needed, docs.

**How to test:** Run `npm test`, confirm the JSON artifact is produced and is valid JSON containing per-test results.

**Definition of Done:**
- [ ] JSON report produced for server and client runs.
- [ ] Artifact is valid JSON with per-test pass/fail + messages.
- [ ] Output path documented and git-ignored if appropriate (no test artifacts committed).
- [ ] Global gates pass.

---

#### Task 17 — Eliminate real-timer waits in tests
**Intent:** Real `setTimeout`/`sleep` makes tests slow and flaky (the `claude-process-pool` "retries quickly (500ms)" test is the slowest single test). Convert to fake timers.

**Actions:**
- Find the ~14 test files using real waits (grep `await new Promise(.*setTimeout`, `await sleep(`, `setTimeout(resolve`). Convert to `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync()` where the wait is for internal timing. Leave waits that are genuinely waiting on real async I/O that can't be faked, but document why.
- Confirm no loss of coverage and no new flake.

**Files:** the ~14 identified test files.

**How to test:** Run each converted file 3× in isolation; confirm deterministic pass and measurable speedup. Run full suite.

**Definition of Done:**
- [ ] Real-timer waits converted to fake timers wherever the wait is for internal timing.
- [ ] Any remaining real wait has a documented justification.
- [ ] Full suite passes 3× without flake; note the wall-time delta.
- [ ] Global gates pass.

**Depends on:** Task 15 (green baseline) recommended first.

---

#### Task 18 — Reduce test collection time & split oversized test files
**Intent:** ~22.5s of the run is collection (transform+import); the largest test files (e.g. `multi-session-manager.test.ts` ~84KB) are slow to transform and slow for an agent to load into context.

**Actions:**
- Profile collection (`--reporter=verbose` or vitest's timing). Split the largest test files by concern into focused files (preserve all test cases — pure reorganization). Target the top offenders (`multi-session-manager`, `claude-channel-service`, `opencode-routing`, client `sessionStore`).
- Evaluate pool/isolation settings (`pool: 'threads'`, `isolate: false` where safe) for speedup **without** introducing cross-test state leakage. Only apply if tests stay green and deterministic.

**Files:** the largest test files; `server/vitest.config.ts` / `client/vitest.config.ts` if tuning pools.

**How to test:** Compare collection + wall time before/after; run full suite 3×.

**Definition of Done:**
- [ ] Top oversized test files split by concern, all original cases preserved (count unchanged).
- [ ] Any pool/isolation change keeps the suite green and deterministic (3× runs).
- [ ] Measured improvement in collection or wall time recorded in working notes.
- [ ] Global gates pass.

**Depends on:** Task 15.

---

#### Task 19 — Surface per-file test timing
**Intent:** Helps agents know which file to target when iterating, avoiding full-suite reruns.

**Actions:**
- Make per-file timing easily visible (document `--reporter=verbose`, or set a default reporter that shows file durations without excessive noise). Document in the fast-loop section (Task 20).

**Files:** vitest configs and/or docs.

**Definition of Done:**
- [ ] Per-file timing is obtainable via a documented command (or default).
- [ ] Documented in `docs/TROUBLESHOOTING.md` / `docs/OBSERVABILITY.md`.
- [ ] Global gates pass.

---

#### Task 22 — Lint/PR guard against regression of logging hygiene
**Intent:** Prevent the 331-call `console.*` sprawl and empty-catch pattern from regrowing after the migration.

**Actions:**
- Add ESLint rules in `.eslintrc.json`: `no-console` for `server/src` runtime code (allow in `scripts/`, tests, and the logger module via overrides), and `no-empty` (with `allowEmptyCatch: false`) or a targeted rule for empty catches. Tune overrides so the rules are green on the post-migration tree.
- Ensure `npm run lint` enforces these.

**Files:** `.eslintrc.json`.

**How to test:** Run `npm run lint`; confirm green. Add a deliberate `console.log` in a server runtime file and confirm lint fails (then remove it).

**Definition of Done:**
- [ ] ESLint forbids `console.*` in server runtime code and flags empty catches, with justified overrides for scripts/tests/logger.
- [ ] `npm run lint` is green on the full tree.
- [ ] A planted violation is proven to fail lint (then reverted).
- [ ] Global gates pass.

**Depends on:** Tasks 1 and 7 (must be done after the migration, or lint will be red).

---

## 5. Final acceptance / sign-off checklist (the "are we actually done" gate)

Do not declare the overall plan complete until **all** of the following are literally true and evidenced:

- [ ] All 22 tasks meet their individual Definition of Done.
- [ ] `npm run lint` — green.
- [ ] `npm run typecheck` — green.
- [ ] `npm run build` — green.
- [ ] `npm test` — **0 failures**, run 3× without flake (post-Task-15 baseline).
- [ ] `npm run docs:check-agent-guides` — green (`AGENTS.md` ≡ `CLAUDE.md`).
- [ ] Live validation: at least one `pi-web-ui-internal-api-orchestration` scenario passes that exercises the new diagnostics endpoint, the correlation IDs, the enriched error responses, and the event-type registry against a **real** runtime (Pi at minimum; ideally `--runtime all`). PASS verdict captured.
- [ ] `docs/OBSERVABILITY.md` exists, is linked from the agent guide and maintainer index, and accurately describes what was built (no aspirational/false claims).
- [ ] `git status --short` reviewed: no secrets, tokens, cookies, session/transcript dumps, coverage artifacts, or local machine files staged.
- [ ] A short summary of measured improvements (console-call count before/after, test wall/collection time before/after, baseline-failures before/after) recorded.

### What "ready" means when the human pushes back

When the reviewer challenges a "done" claim, you must be able to answer **all three** instantly, with artifacts:
1. **"Show me the test that proves it."** — the specific test + its passing output.
2. **"Show me it works live."** — the `pi-web-ui-internal-api-orchestration` PASS verdict (scenario, runtime, summary) for anything touching the API or a runtime.
3. **"Show me you didn't break or hide anything."** — global gates green, baseline-failure set unchanged-or-improved, no swallowed errors introduced, no contract field removed.

If you cannot produce all three for a task, it is **not done** — say so plainly and finish it. Never round "almost" up to "done."

---

## 6. Commit discipline for the executing agent

- Work on the existing default branch unless the human says otherwise; keep commits scoped per task or per coherent phase with clear messages.
- Never commit secrets or test/coverage artifacts (respect `.gitignore`; add ignores as needed in Task 16).
- Before each commit: `git status --short`, `git diff --stat`, and verify no sensitive files. Run the global gates first.
