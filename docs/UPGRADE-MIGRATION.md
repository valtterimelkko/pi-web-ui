# Upgrade and migration notes

Short, adopter-facing migration notes for the additive minor bumps that still need operator awareness. Everything here is **compatible** — no breaking `/api/v1` route change — but the behaviours below affect pin capacity, model selection, and goal handling.

## Antigravity goal function (1.38.0, 2026-09-08)

- **What changed:** `capabilities.runtimes.antigravity` gains `supportsGoal`/`goalControls`; `GET/POST /sessions/:id/goal` now work on antigravity sessions; a `/goal …`-prefixed antigravity prompt is intercepted as goal control (never reaches the model; resolves while busy). The goal loop is server-side: sweeper verifies each completed turn (`verifyCommand` exit 0, or the `GOAL_STATUS: ACHIEVED` sentinel self-report) and dispatches continuations while unmet up to `maxTurns` (default/cap 100, `AGY_GOAL_MAX_RUNS`). Sweep/verify knobs: `AGY_GOAL_AUTO_CONTINUE`, `AGY_GOAL_SWEEP_MS`, `AGY_GOAL_VERIFY_TIMEOUT_MS`.
- **Compatibility:** additive. Existing consumers that treated antigravity goals as unsupported should now gate on `supportsGoal`. Goal-control records live under `~/.pi-web-ui/antigravity-sessions/goal-control/`; deleting a record disarms that session's goal.

## Antigravity slug selectors + queueing (1.37.0, 2026-09-08)

- **What changed:** Antigravity `/models` selectors are now canonical agy **slugs** (`gemini-3.6-flash-low`) and each entry carries sibling-derived `thinkingLevels`; `follow_up` on a busy antigravity session **queues** in the live agy process (previously `409`); `steer` on busy antigravity returns `409 SESSION_BUSY` (no mid-run join exists); `set_model` on a busy session is `409`. Turns stream real deltas/tool events and `agent_end` carries real token `usage`.
- **Compatibility:** stored **label** model ids (`"Gemini 3.6 Flash (Low)"`) keep working — `set_model`/create canonicalise labels to slugs against the live catalogue; unknown models fail the turn loudly with agy's own error text. The legacy `agy -p` text-mode path was removed in the same release.
- **Action:** copy the slug `selector` from `/api/v1/models` for new bindings; treat `supportsThinkingLevel: true` as slug-swap semantics (`set_thinking_level` read-back `model` carries the resolved slug). See [`ANTIGRAVITY-INTEGRATION.md`](./ANTIGRAVITY-INTEGRATION.md) and [`INTERNAL-API-CONTRACT.md`](./INTERNAL-API-CONTRACT.md) (1.37.0).

## Five human pins per runtime (2026-09-02, `d617d4b`)

- **What changed:** the browser/UI human residency allowance is now **five sessions per runtime**; a 6th human claim is rejected with `SESSION_PIN_LIMIT` / `RETENTION_RESIDENT_CAPACITY_EXHAUSTED`. Command Code now enforces the same cap server-side instead of accepting unlimited human pins.
- **What did NOT change:** source-owned Internal API retention leases (`retention:{mode:"durable"|"resident", ownerId, ttlSeconds}` → `INTERNAL_API_PIN_DIR`) and watch claims (`watch:<id>` / `watch-target:<id>`) remain **independent** and do not consume human slots. The legacy `internal-api:` control pin is now an expiring `internal-api:` claim as the other runtimes already did.
- **How to diagnose:** `GET /api/v1/sessions/:id/evidence` → `retention.leases[]` / `retention.latestExpiryAt` vs the five human slots; `GET /api/v1/sessions/:id/info` `retention` block; per-runtime counts in `GET /api/v1/sessions`. See [`RUNTIME-OVERVIEW.md`](./RUNTIME-OVERVIEW.md) (persistence table), [`INTERNAL-API.md`](./INTERNAL-API.md) (retention), and [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) (pin-limit symptom).
- **Action:** release or wait for expiry of the oldest human pin; for automation use a source-owned `retention:{…}` or watch claim (released by exact `leaseId`), not a human pin.

## Bare provider/id → copyable selector (1.26.0, 2026-08-25)

- **What changed:** every `GET /api/v1/models` entry now carries a `selector` field whose value is **exactly** what `POST /sessions` accepts for that runtime (`provider/id` for Pi and OpenCode; alias or `profile:<id>` for Claude; native id for Command Code/Antigravity).
- **Bare ids:** a bare Pi `model` (no `/`) that matches exactly one advertised, unblocked model is resolved to its qualified selector and binds with `fallbackApplied:false`; a bare id matching several advertised models now fails with `422 MODEL_NOT_APPLIED` **listing every `provider/id` candidate**; unknown ids fail loudly. Blocked providers are excluded from resolution. This restores pre-`1.25.0` behaviour that `1.25.0` had regressed.
- **Action:** discovery clients should **copy `selector`** rather than constructing `provider/id` strings. Handle `MODEL_NOT_APPLIED` by presenting the candidate list. See [`INTERNAL-API-CONTRACT.md`](./INTERNAL-API-CONTRACT.md) (1.25.0/1.26.0) and [`INTERNAL-API.md`](./INTERNAL-API.md) (create-session).

## Suggested goal status (1.28.0, 2026-08-30, `8d18f41`)

- **What changed:** the canonical goal projection gains a non-terminal `suggested` status. `GET /api/v1/sessions/:id/goal` and `goal_state` broker events report `{ status:"suggested", objective:"<proposed>" }` with `runtimeState.pendingSuggestion` carried verbatim when the Pi extension records a `pendingSuggestion` on an otherwise idle goal — an agent has proposed a goal and is awaiting **explicit owner approval**. No `goal_end` fires.
- **Action:** treat `suggested` as non-terminal — watch `goal_state` where `status=suggested`, not `goal_end` (which fires only for terminal `achieved`/`failed`/`cleared`). An approving owner reply mentioning the goal auto-starts it. The extension's completion parser now also tolerates a trailing `Progress:` annotation after the status marker. See [`INTERNAL-API-CONTRACT.md`](./INTERNAL-API-CONTRACT.md) (1.28.0), [`INTERNAL-API.md`](./INTERNAL-API.md) (§ Goal Function), and [`GOAL-EXTENSION-UI.md`](./GOAL-EXTENSION-UI.md).

## Other recent minors (no action required, just awareness)

- `1.21` truthful Pi create (see above), `1.22` watch `onFire` wake, `1.23` Command Code as a watch subject, `1.24` bounded `?mode=snapshot`/`?timeout` on `/events`, `1.27` cross-runtime goal function, `1.29` Claude SDK `mode:steer` at the next tool boundary + model-aware `max`. See [`INTERNAL-API-CONTRACT.md`](./INTERNAL-API-CONTRACT.md) and [`RECENT-CHANGES.md`](./RECENT-CHANGES.md).

*Remaining `docs/plans/` status-block audit is intentionally sampled (3 plans in this pass); the remaining ~23 plans are left for a follow-up pass to keep blast radius small.*
