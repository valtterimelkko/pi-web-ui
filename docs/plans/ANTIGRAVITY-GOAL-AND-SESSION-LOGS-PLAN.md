# Antigravity /goal integration + session-log findability plan

> **Status:** IN EXECUTION (2026-09-08). Operator brief: (1) docs must make it easy to find
> antigravity session logs from a frontend session ID, like other runtimes; (2) `/goal` for
> antigravity working like the other runtimes, in the Internal API and the frontend;
> (3) Agent OS capture at the end. **No production restart without explicit owner permission**
> (another agent is actively using the production Internal API).

## Problem

Contract 1.27.0 shipped the cross-runtime goal function for pi/claude/commandcode
(`docs/plans/CROSS-RUNTIME-GOAL-FUNCTION-PLAN.md`). Antigravity was out of scope then
(D1: legacy batch runtime). Contract 1.37.0 made antigravity a first-class streaming
runtime with native follow-up queueing — the missing precondition for a server-side goal
loop. Capabilities today report `supportsGoal` only for pi/claude/commandcode; antigravity
goal requests fall through to `unsupportedGoalProjection()` / the Pi slash-composition
rejection.

## Findings (session-log task)

The 1.37.0 docs pass already wired most of the findability surface:
`scripts/debug-where.mjs` has a full antigravity branch (store JSONL, conversation DB,
`agy` CLI logs, journalctl); `docs/TROUBLESHOOTING.md` has the session-file table rows and
a dedicated `## Antigravity (agy)` section; `docs/ANTIGRAVITY-INTEGRATION.md` documents the
store. Remaining work is **verification-first**: exercise `npm run debug:where` with a real
frontend session ID, verify the transcript endpoint and files it names exist, and patch any
gap found.

## Design decisions

- **D1 — server-side goal manager.** `agy` has no native `/goal`; antigravity follows the
  Command Code "wide" pattern but fully server-owned (no mod): a per-session control store
  under `<antigravitySessionDir>/goal-control/<sessionId>.json` plus a turn-driven sweeper
  (mirrors `claude-auto-continue.ts` but advances on **completed turns**, not time backoff).
- **D2 — verification.** `verifyCommand` → server runs it (cwd = session cwd, bounded
  timeout); exit 0 = achieved (`passed`), else unmet (`failed`). Without `verifyCommand`,
  the goal prompts instruct the model to end its reply with exactly
  `GOAL_STATUS: ACHIEVED`; the sweeper scans the last turn's stored response
  (`self_reported`). Bounds: `maxRuns` default/cap 100 (`AGY_GOAL_MAX_RUNS`), verify
  timeout `AGY_GOAL_VERIFY_TIMEOUT_MS` (60s), sweep `AGY_GOAL_SWEEP_MS` (15s), master
  switch `AGY_GOAL_AUTO_CONTINUE` (default on). Budget exhaustion → `failed`/`budget` +
  exactly one `goal_end`.
- **D3 — surfaces.** Internal API: `GET/POST /sessions/:id/goal` (start/pause/resume/clear),
  `goal` in create-with-goal, and `/goal …` text interception in `POST /sessions/:id/prompt`
  for antigravity (resolves even while busy — goal control never needs the runtime process).
  WebSocket: `goal_control` routes antigravity to the same Internal API handler;
  `/goal …` typed in the chat box is intercepted in `handleAntigravityPrompt`. Frontend:
  GoalPanel is already runtime-neutral via the browser bridge; antigravity joins
  pi/opencode in getting live pause/resume/clear buttons (server-owned state, no native
  semantics to conflict).
- **D4 — contract 1.38.0.** Wire-visible: capabilities `supportsGoal`/`goalControls` for
  antigravity, goal endpoints accepted on antigravity sessions, `/goal` prompt
  interception. Changelog + pin tests + Agent OS mirror (established additive chore).
- **D5 — validation.** TDD; live validation on a disposable server (real `agy`,
  `gemini-3.6-flash-low`): sentinel goal reaches `achieved`; verify-command goal reaches
  `achieved`; pause halts the loop; `goal_state`/`goal_end` observable via
  `GET /sessions/:id/events`; `/goal …` via `POST /prompt` works while busy. Production
  restart explicitly out of scope (owner-gated).

## Phases

1. **Contract pins** — RED: pin tests expect 1.38.0; GREEN: bump `INTERNAL_API_CONTRACT_VERSION`, changelog.
2. **`goal/antigravity-goal.ts` module TDD** — parser (`/goal <objective>`, `--verify`, pause/pause-now/resume/clear/status), control store, projection, sentinel + command verification, prompt builders, turn-driven sweeper state machine (fake deps).
3. **Wiring TDD** — capabilities flags; `readGoalProjection`/`handleSessionGoalControl` antigravity branches; `armGoalAfterCreate`; prompt interception; sweeper start/stop in route lifecycle; WS `goal_control` + prompt interception; frontend GoalPanel controls for antigravity.
4. **Docs + mirror** — INTERNAL-API.md § Goal, contract changelog, UPGRADE-MIGRATION, RECENT-CHANGES, ANTIGRAVITY-INTEGRATION, capabilities examples; skills orchestration note; agent-os mirror 1.38.0.
5. **Session-log verification pass** — debug:where with a real ID; transcript endpoint; gap patches.
6. **Live validation** — disposable server scenarios L-G1…L-G5.
7. **Gates, commit, push, CI, capture** — full gates; Telegram milestones; Agent OS capture; report + production-restart question.
