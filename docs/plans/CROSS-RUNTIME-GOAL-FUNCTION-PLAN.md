# Plan: Cross-runtime Goal Function — Internal API + Frontend Parity

_Status: APPROVED — NOT STARTED. Owner go required before any execution.
Prepared 2026-08-27 after a deep, live-validated analysis session. All facts
below were verified against the repos and binaries on that date, and every
live-validated claim is marked [LV] with the model used. Executing agents:
read this file fully before starting; it is deliberately self-contained._

---

## 0. Owner decisions already made (do not re-ask)

| # | Decision (owner, 2026-08-27) |
|---|---|
| D1 | **Scope**: Pi, Claude (SDK backend only), Command Code. OpenCode and Antigravity are deliberately **out of scope** (OpenCode already has a server-side goal bridge; the owner does not use these paths enough to justify work there). |
| D2 | **Contract version 1.27.0** is allocated to THIS plan. The steer-wake plan's old 1.27.0 reservation is void — it was de-reserved in pi-enhancement commit `6a5127c` (2026-08-27) and now takes the next free version if/when it is ever executed. |
| D3 | **Wide functionality** (both "b" and "c" options): the Command Code goal mod ships **both** a deterministic verify-command verifier **and** a model-backed verifier; the Claude path ships a **server-side auto-continue loop** for unmet-but-idle goals (not just "clear only" honesty). |
| D4 | **No execution before owner go.** Production restart and agent-os mirror resync stay owner-gated at the end (Phase 7). |
| D5 | Live validation is authorised with these cheap models: Pi `zai/glm-5.3-flash`, Claude `sonnet` (SDK subscription), Command Code `meta/muse-spark-1.2-contributor`. |

---

## 1. Rationale and intent

The goal function — a durable objective the harness keeps re-injecting and
keeps working toward across turns — is the strongest tool we have against
context rot on long-horizon agent tasks. In all three in-scope harnesses the
original goal survives **compaction** by design (re-injection / transcript
attachments / per-round system-prompt injection), which ordinary steering
text does not. Today that power is only usable by a human in the browser,
and only for Pi (plus OpenCode's server bridge). Agents orchestrating
children through the Internal API — the primary long-horizon dispatch
surface — cannot start, read, control, or observe goals on any runtime.

**Intent**: make the goal function a first-class, programmatic Internal API
capability across all three in-scope runtimes, with frontend parity for the
two that lack it, and teach the orchestration skills how to use it.

**Why this matters specifically for orchestration**: a goal-driven child
needs fewer parent check-ins (the objective keeps itself alive through
compaction), and a parent can watch for the goal's *terminal* event instead
of reacting to every `agent_end` churn of an auto-continuing loop.

---

## 2. What each harness actually has (verified 2026-08-27)

### 2.1 Pi — our goal-engine extension (operational, the reference model)

Extension source: `/root/pi-enhancement/goal-engine/` (live copy at
`~/.pi/agent/extensions/goal-engine/`; the extension itself is **NOT
modified by this plan** — everything needed is already observable
server-side).

- Command surface: `/goal "<objective>" [--max-turns N] [--min-reviews N]
  [--budget-tokens N] [--budget-usd N] [--verify "command"]`, plus
  subcommands `pause`, `pause-now`, `resume`, `resume-last`, `clear`,
  `status`, `report`, `list`, `limit`, `budget`, `budget-usd`
  (`goal-engine/commands.ts`).
- Internal API prompt path **already resolves Pi slash commands**: a
  `POST /api/v1/sessions/:id/prompt` whose message starts with `/` runs the
  extension command synchronously and the run receipt completes with
  cessation basis `documented_handler_return`
  (`server/src/internal-api/routes/sessions.ts`, the `/^\s*\//` branch in
  `executePrompt`, ~line 3805). [LV] `/goal "create /tmp/x …" --max-turns 3
  --verify "…"` returned 200 in 0.2s, then the goal loop ran autonomously and
  achieved the goal with verification passed (zai/glm-5.3-flash).
- Goal state is **machine-readable on disk**, per session:
  `~/.pi/agent/goal-engine/<slug>.<hash16>.goal.json` where `slug` is the
  session-file basename (sanitised, ≤80 chars) and `hash16` is the first 16
  hex chars of sha256 of the **full session file path** — replicate exactly
  via `getSessionGoalStatePath()` in `pi-enhancement/goal-engine/state.ts`.
  `status === 'idle' && completedAt != null` ⇒ achieved;
  `running`/`wrapping-up`/`paused` ⇒ active. Rich fields: `objective`,
  `turnCount`, `verifyCommand`, `lastVerificationStatus`
  (not-run|passed|failed|self-reported), `spentInputTokens`, `spentUsd`,
  `budgetTokens`/`budgetUsd`, `maxTurns`, `compactionCount`,
  `progressCurrent/Total/Label`, `planItems/planDone`, `pendingQuestion`,
  `lastErrorMessage`, `reviewCyclesCompleted/minReviewCycles`, timestamps.
  The same state is ALSO persisted as custom entries (`customType:
  'goal_engine'`) inside the session JSONL — a fallback read path.
- Goal continuation turns emit ordinary agent events
  (`message_update` … `agent_end`, `agent_settled`) into the Internal API
  event broker, so watches on `agent_end` already fire per goal run. [LV]

**Gaps to fix (Pi)**:
1. **Busy-409**: while a goal run is streaming, `POST /prompt` with
   `/goal pause-now` is refused `409 SESSION_BUSY` — `chooseDispatchMode()`
   (`sessions.ts` ~2296-2313) has no slash-command exemption. The browser
   WebSocket path DOES exempt slash commands (`server/src/websocket/connection.ts`
   ~1128, `isSlashCommand`) precisely so goal controls work mid-run.
2. **No read endpoint**: goal state is not exposed via the Internal API.
3. **No goal events on the broker**: the extension's widget/status updates
   (`extension_status` with key `goal-engine`, `widget_content` with the
   goal widget lines) go only to WebSocket clients. The server already
   snapshots them per session path in
   `MultiSessionManager.recordExtensionUiSnapshot` /
   `extensionUiSnapshots` (`server/src/pi/multi-session-manager.ts` ~186-215)
   — tap that, or subscribe where they are broadcast, and republish as
   NormalizedEvents.

### 2.2 Claude Code 2.1.245 — native `/goal`, SDK path (external harness; observe, don't modify)

- `/goal <condition>` ("Set a goal — keep working until the condition is
  met"), `argumentHint "[<condition> | clear]"`, `supportsNonInteractive:
  true` — **works in print mode and through the Agent SDK**. [LV] Raw
  `claude -p --output-format stream-json` and `query({prompt: '/goal …'})`
  via `@anthropic-ai/claude-agent-sdk` 0.3.185 both set the goal and drive
  it to `met` (Sonnet 5). pi-web-ui spawns the **system** claude
  (`resolveClaudeBinary()` → `which claude`) via `pathToClaudeCodeExecutable`.
- Mechanism: the CLI keeps `activeGoal = {condition, iterations, setAt,
  tokensAtStart, lastReason}`. Setting a goal writes a **sentinel
  `goal_status` attachment** into the Claude transcript JSONL
  (`~/.claude/projects/<slugified-cwd>/<claudeSessionId>.jsonl`):
  `{type:"attachment", attachment:{type:"goal_status", met:false,
  sentinel:true, condition}}`. After each model Stop, a CLI-internal
  Stop-hook verifier produces an evidence-based verdict and appends
  `{type:"goal_status", met:<bool>, condition, reason:"<evidence-based
  verdict>"}`. Not-met ⇒ the run CONTINUES inside the same `query()` call
  (synthetic user message "Stop hook feedback: [condition]: <verdict>");
  the SDK `result` frame arrives only after the goal settles (met /
  impossible / cleared). [LV] Transcripts confirmed both the sentinel and
  the `met:true` attachment with reasoning.
- **Persistence across processes**: `findGoalToRestore` restores an unmet
  goal from the last non-terminal `goal_status` attachment on resume.
  pi-web-ui's Claude SDK service opens a fresh `query()` per prompt with
  `resume: claudeSessionId` on follow-ups — so a goal set in one web-UI
  prompt persists into the next process. The loop, however, only ADVANCES
  while a `query()` call is open: an unmet goal + idle server-side session
  sits still until the next prompt (⇒ D3 auto-continue loop).
- `active_goal` stream frames exist in the CLI but the SDK message adapter
  **drops them** (`case "active_goal": return {type:"ignored"}`); pi-web-ui
  would never see them via `query()` regardless. **The transcript
  attachments are the reliable read path.**
- `/goal clear` clears. **No pause/resume upstream.** A "Stop hook error"
  notification can occasionally appear even when the goal resolves
  correctly [LV] — treat as non-fatal noise.
- Caveat: `CLAUDE_CONFIG_DIR` may differ per profile (cli-direct /
  channel backends). For the default `sdk-subscription` profiles the
  transcript root is `~/.claude/projects/…`. The reader must resolve the
  transcript root from the profile/session record, not hard-code it.

**Claude gap summary**: no state read (parse attachments), no start/clear
via API semantics, no auto-continue when unmet+idle (D3 wide: build it), no
goal events to browser or broker.

### 2.3 Command Code v1.33 — native goal is TUI-only (external harness; extend via its official mod surface)

- Upstream goal (TUI): `/goal [<objective>|clear|status]`; `pause`/`resume`
  print "isn't available yet". Goal state persists in the session-meta
  store under the `.commandcode` bridge (per native home); verification is
  model-backed (`verifyGoalCompletion` builds evidence from tool results);
  the continuation supervisor lives in an **in-memory arm store** (per
  process); default turn cap 100, rejection cap 3.
- **Headless `-p` does NOT intercept slash commands**: [LV]
  `cmdc -p --output-format json --model meta/muse-spark-1.2-contributor
  "/goal create a file named marker.txt …"` passed the text straight to the
  model as a user message — no goal arming, no goal notices.
- Goal activity surfaces as NDJSON **`notice` events**
  (`{type:'notice', notice:{message, metadata:{isGoalNotice:true,
  goalNoticeKind:'none'|'cleared'|'paused'|…}}}`) and completion metadata
  (`{isGoalComplete:true, goalElapsed, goalTurns, goalText}`). pi-web-ui's
  `command-code-event-adapter.ts` currently **drops** `notice` events
  (unknown type → no normalized event).
- pi-web-ui launcher: `buildCommandCodeArgs()`
  (`server/src/command-code/command-code-config.ts`) has a **fixed,
  server-owned argv policy** (`-p --output-format json --model X
  --max-turns N --trust --skip-onboarding --no-auto-update --yolo
  [--effort e] [--resume <nativeSessionId>]`) with a private per-session
  native home under the state dir (`nativeHomeDir`). cmdc supports
  `--mod <path>` and `--mod-option <name=value>` (repeatable).
- The mod API (verified against the bundled mod-builder reference in the
  cmdc dist and the deployed watch-wake mod precedent
  `/root/cmd-enhancement/watch-wake/watch-wake.ts`):
  - `appendSystemPrompt({state}) → string` — appended to the system prompt
    every round; **must be byte-stable across rounds for the same durable
    inputs** (prompt-prefix cache keys off these bytes — compute once,
    store in modState, read it back). This is the compaction-surviving
    goal-injection channel.
  - `transformContext({messages, state})` — per-model-call message rewrite
    (not written back to the durable transcript).
  - `onStop({state, stopReason, turnNumber, lastAssistantText}) →
    {continue?, reason?} | undefined` — the Stop-hook force-continue
    channel; returning `{continue:true}` appends an automated
    `source:'stop_hook'` user turn; the loop caps consecutive stop-hook
    continuations at **8**; does not fire on hard stops (max_turns,
    terminate, permission_denied, interrupted).
  - `shouldStopAfterTurn` (early stop), `onTurnStart/onTurnEnd/onRunEnd`,
    notice events via the notification channel, `cmd.session`
    (`appendCustomEntry`/`getCustomEntries`) for persistence,
    `queueMessage({deliverAs})`, and `mod_error` fallbacks (hooks never
    throw upward).
  - Mod store repo: `/root/cmd-enhancement` (sibling of pi-enhancement;
  NOT yet vault-indexed). Mods are plain TS loaded via `--mod`.

**Command Code gap summary**: headless goals need a goal-runner **mod**
(D3 wide: verify-command AND model verifier), a server-owned argv extension
to load it with options, notice/completion parsing in the event adapter,
and a goal-state channel back to the server (state file in the session's
native home — the server owns that directory tree).

### 2.4 Shared surfaces to build on

- **OpenCode server bridge = the in-repo pattern to replicate** for Claude
  and Command Code state→browser projection:
  `server/src/opencode/opencode-service.ts` reads the plugin's per-session
  goal JSON from `~/.opencode/goal-engine/<id>.goal.json`, emits normalized
  `extension_status` (key `goal-engine`) and `widget_content` (key
  `goal-engine-status`) events, and implements `pauseGoal`/`resumeGoal`/
  `clearGoal` + a resume continuation prompt. The browser goal surface is
  already runtime-neutral and keyed off exactly these events.
- **Frontend (already neutral)**:
  - `client/src/components/Chat/GoalPanel.tsx` — collapsible goal card
    (status/runs/spend/verification/plan/history); control buttons gated by
    `controlsEnabled = isLive && (sdkType==='pi' || sdkType==='opencode')`.
  - `client/src/lib/piExtensionControls.ts` — `getGoalControlCommand()`
    (Pi: `/goal pause-now|resume|clear` slash commands), `goal_control`
    WebSocket message (OpenCode-only server-side today,
    `connection.ts handleGoalControl`), `deriveGoalTag`.
  - `client/src/store/goalStore.ts` — per-session projection + history,
    archives on status-clear; `client/src/lib/goalModel.ts` — widget-line
    parser; `client/src/store/draftStore.ts` — lets Pi slash drafts send
    while streaming.
- **Internal API structure**: routes registered in the segment switch of
  `server/src/internal-api/server.ts` (~line 575+) delegating to handlers
  in `server/src/internal-api/routes/sessions.ts`; control actions today:
  `set_model | set_thinking_level | set_effort | pin | unpin |
  acquire_retention | renew_retention | release_retention`
  (`SessionControlRequest`, `server/src/internal-api/types.ts` ~525).
  Contract pin: `INTERNAL_API_CONTRACT_VERSION = '1.26.0'` at
  `types.ts:75` → **bump once to 1.27.0 in Phase 1 and carry it through**
  (two test pins assert the version string — update them).
  Capabilities route advertises per-runtime flags — add goal flags there.
- **Watch system**: `WatchManager`
  (`server/src/internal-api/watch/watch-manager.ts`), registered via
  `POST /sessions/:id/watch`, long-poll `GET /api/v1/watches/wait`;
  conditions are `event_type`/`tool`/`text` matched against NormalizedEvents
  flowing through the broker. If registration validates event-type names
  against an allow-list, extend it (check `WatchValidationError` paths).
- **Broker**: `InternalApiEventBroker.publish(sessionId, event)` — goal
  events must be NormalizedEvents published here (then `/events` SSE,
  `/events?mode=snapshot`, and watches all see them for free).

---

## 3. Scope

**In scope**
- New runtime-neutral Internal API goal surface (read + control + events +
  watch condition + create-with-goal), contract 1.27.0.
- Pi: busy-409 slash exemption, state read, broker events. No extension
  changes.
- Claude (SDK backend only): transcript attachment reader, start/clear,
  auto-continue loop (D3), state + events.
- Command Code: goal-runner mod in cmd-enhancement (both verifiers), argv
  extension, adapter notice parsing, state file channel.
- Frontend: enable goal surface for `claude` and `commandcode` sdkTypes;
  per-runtime control routing.
- Skills (canonical copies only): `pi-web-ui-internal-api-orchestration`,
  `long-horizon-waiting-strategies`.
- Canonical docs: INTERNAL-API.md (+CONTRACT changelog), capabilities,
  GOAL-EXTENSION-UI.md cross-runtime section, COMMAND-CODE-INTEGRATION.md
  (mod + argv policy), EVENT-PIPELINE.md (goal events), RECENT-CHANGES.

**Out of scope**
- Any change to the Pi goal-engine extension itself (v1 is zero-touch; a
  future v2 may add structured events).
- OpenCode and Antigravity anything.
- Claude CLI-direct/channel backends (SDK path only; readers must not
  break if a session was created on another backend — return
  `supported:false` there).
- Upstream changes to Claude Code or cmdc binaries (external products).
- Production restart / agent-os resync (Phase 7, owner-gated).
- The steer-wake plan (parked, de-reserved, separate).

---

## 4. What victory looks like

1. **Programmatic, runtime-neutral**: via the Internal API alone, an agent
   can (a) create a session on pi/claude/commandcode with an optional goal,
   (b) start/read/control a goal (`start|pause|resume|clear` with honest
   per-runtime semantics), (c) poll `GET /sessions/:id/goal` for structured
   state, (d) receive goal state transitions on `/events`, and (e) register
   a watch on the goal's terminal event so the parent wakes when the goal
   ends — not on every continuation `agent_end`.
2. **Frontend parity**: Claude SDK and Command Code sessions show the same
   GoalPanel/goal-tag surface Pi has today, driven by the same
   widget/status event shape, with controls that route to the right
   runtime path and honest disabling where a control genuinely does not
   exist.
3. **Compaction-proof long-horizon children**: goal text survives
   compaction on all three runtimes (re-injection / attachments /
   appendSystemPrompt). Documented and live-validated.
4. **Skills teach it**: both orchestration skills contain comprehensive,
   example-driven guidance on when to prefer goal-driven children over
   plain prompts, per-runtime semantics, polling/watching patterns, and
   failure modes.
5. **Quality gates**: every phase RED→GREEN TDD; workspace suites green
   (`npm test`, lint, typecheck, build); live-validated per phase on a
   disposable validation server with the D5 models; production untouched
   until Phase 7 owner approval; agent-os mirror resynced before any
   production restart (Command Code creation fails closed otherwise).

---

## 5. Runtime-neutral goal state projection (canonical vocabulary)

All read paths map into this shape (undefined beats guessing — omit what a
runtime cannot know):

```jsonc
// GET /api/v1/sessions/:id/goal → 200
{
  "supported": true,                  // false when runtime/backend cannot do goals
  "status": "idle|running|paused|wrapping_up|achieved|cleared|failed|unknown",
  "objective": "…",                   // condition text
  "runs": 3,                          // harness turns/runs consumed (best effort)
  "verification": { "status": "passed|failed|self_reported|not_run", "command": "…", "message": "…" },
  "lastReason": "…",                  // verifier verdict / governor note
  "spend": { "inputTokens": 123, "usd": 0.4 },
  "budget": { "tokens": 5000000, "usd": null },
  "startedAt": 1690000000000, "completedAt": null,
  "pausedReason": "budget|user|error|null",
  "runtime": { /* verbatim native state: Pi GoalState / Claude goal_status derivation / cmdc mod state */ }
}
```

Status mapping (implement as a pure, unit-tested function per runtime):

| Canonical | Pi (`status`+`completedAt`) | Claude (latest `goal_status` attachment) | cmdc (mod state file) |
|---|---|---|---|
| `running` | `running` | sentinel/unmet + query open or auto-continue armed | `active` + running |
| `wrapping_up` | `wrapping-up` | — | — |
| `paused` | `paused` (pausedReason from fields; auto-continue off = `user`) | `paused` (server-side: auto-continue disabled on an unmet goal) | `paused` (pausedReason from file) |
| `achieved` | `idle` && `completedAt` | `met:true` | `completed` |
| `failed` | governor-paused after errors (`lastErrorMessage` set + paused) | verifier `impossible`/`failed:true` if exposed | `rejection-cap`/error-paused |
| `cleared` | idle tombstone with no completedAt after a clear | no attachments after a `met` terminal… treat absence of goal + prior-achieved as `cleared` is **not** knowable — use `idle` | `cleared` marker in file |
| `idle` | `idle`, no completedAt | no goal_status attachments | no state file |

Event shape (published to the broker AND bridged to the browser widget/
status keys, mirroring the OpenCode bridge):

```jsonc
{ "type": "goal_state", "sessionId": "…", "timestamp": 0,
  "data": { /* the projection above minus `supported` */ } }
```

Terminal-ish transition (`achieved|cleared|failed`) additionally publishes
`{ "type": "goal_end", "data": { "status": "achieved", … } }` — the
watchable event.

---

## 6. Execution plan

Order is deliberate: Pi first (pure win, everything exists), Claude second
(plumbing), Command Code third (the only real build), then frontend parity
falls out of the shared event shape, then orchestration integration, docs,
skills, gated deploy. Commit and push after each phase (current branch, no
new branches; path-limited staging — the tree may carry other agents'
work). Keep diffs minimal.

### Phase 0 — groundwork (small)

1. Bump `INTERNAL_API_CONTRACT_VERSION` to `1.27.0` + the version test
   pins + a changelog entry in `docs/INTERNAL-API-CONTRACT.md` (TDD: update
   the pinning tests first, watch them fail, then bump).
2. Add the shared projection types + per-runtime status-mapping pure
   functions with unit tests (canonical vocabulary table above). Suggested
   home: `server/src/internal-api/goal/` (new small module:
   `types.ts`, `projection.ts`).
3. Capabilities: extend the per-runtime capability objects with
   `supportsGoal` + `goalControls: string[]` (e.g. pi: all; claude:
   start/clear/pause(server-side)/resume(nudge); cmdc: per mod). Tests.

### Phase 1 — Pi runtime (≈0.5 day)

**1a. Slash-command busy exemption.**
- RED: Internal API prompt tests — `POST /prompt` with a message starting
  `/` on a busy Pi session is dispatched (not 409); non-slash busy prompts
  still 409; non-Pi runtimes never get the exemption.
- GREEN: in `handleSendPrompt`/`chooseDispatchMode` (sessions.ts ~2296),
  mirror the WebSocket path's `isSlashCommand` allowance
  (connection.ts ~1128) for runtime `pi` only: a busy session accepts a
  slash-command prompt because `AgentSession.prompt()` resolves extension
  commands before its streaming guard. The `/^\s*\//` documented-handler-
  return branch in `executePrompt` already handles the receipt.
- Live check [LV-model: zai/glm-5.3-flash]: start a goal with a long-ish
  objective, and while it runs, `POST /prompt` `/goal status` then
  `/goal pause-now` — expect 200s and the goal to pause.

**1b. GET /sessions/:id/goal.**
- RED: route test — reads
  `~/.pi/agent/goal-engine/<slug>.<hash16>.goal.json` for the registry
  entry's `path` (replicate `getSessionGoalStatePath` exactly; fall back to
  the newest `goal_engine` custom entry in the session JSONL when the disk
  file is missing); no goal ⇒ `{supported:true, status:'idle', …}` minimal;
  missing session ⇒ 404.
- GREEN: implement; wire into the server.ts segment switch.

**1c. POST /sessions/:id/goal (control).**
- Actions `start|pause|resume|clear`, body
  `{action, objective?, maxTurns?, verifyCommand?, minReviews?, budgetTokens?, budgetUsd?}`.
  Server composes the `/goal …` slash command (quote the objective;
  objective text still passes `detectPromptInjection` like any prompt) and
  dispatches via the existing prompt path (which is now busy-exempt).
  `pause` maps to `pause-now`. Response: the command's synchronous
  completion + `{goal: <fresh projection>}`. RED-first route tests with a
  stubbed agent session asserting the composed command strings.

**1d. Goal events onto the broker.**
- Where the server fans out `extension_status`/`widget_content`
  (extension-ui-adapter via `webUI.sendToClient`; snapshots recorded in
  `MultiSessionManager.recordExtensionUiSnapshot`), add a parallel
  NormalizedEvent `goal_state` publish (parse the widget lines with the
  same grammar as `client/src/lib/goalModel.ts` — port it server-side or
  move the parser to `shared/`; prefer `shared/` and have the client import
  it from there in Phase 4) and a `goal_end` publish on terminal
  transitions (achieved via status key cleared + notification match, or
  directly from the projection's status transition).
- RED-first: unit tests on the translator (sample real widget payloads);
  integration test that a prompt-subscriber on `/events` receives
  `goal_state` during a goal run.
- Live check [zai/glm-5.3-flash]: full loop — create → POST goal start →
  poll GET goal → observe `goal_state`/`goal_end` on
  `/events?mode=snapshot` → assert `achieved` + verification passed.

### Phase 2 — Claude SDK runtime (≈0.5–1 day)

**2a. Transcript goal reader.**
- Locate the claude transcript: session record → `claudeSessionId` →
  `~/.claude/projects/<slugified-cwd>/<claudeSessionId>.jsonl` (slug: cwd
  path with `/`→`-`; resolve the config dir from the profile — default
  `~/.claude`). Parse the LAST `goal_status` attachment line-wise (cheap:
  read the tail of the file in bounded chunks; transcripts can be large).
  Map to the projection (§5 table). No attachments ⇒ idle.
- RED: fixture transcripts (sentinel-only; met; cleared-after-met;
  malformed tail) → expected projections.

**2b. Control semantics.**
- `start` ⇒ send prompt `/goal <objective>` through the existing
  `claudeService.sendPrompt` path. IMPORTANT semantics to document: the
  POST /prompt (and thus the goal action) **blocks until the goal settles**
  because the CLI loop iterates inside one `query()` call [LV] — for
  long goals callers should use the goal action with detach-style
  behaviour or start via prompt + poll GET goal. Prefer: goal `start`
  dispatches detached (202-style: kick the turn, return immediately, let
  the client poll `/goal`) — mirror the existing `detach` prompt option.
- `clear` ⇒ prompt `/goal clear`.
- `pause` (server-side, D3): mark the session's goal auto-continue OFF
  (in-memory + persisted server-side marker, e.g. in the session store
  record) and abort an in-flight goal turn if requested; honest note in
  the response that Claude has no native pause.
- `resume` ⇒ auto-continue ON + send a continuation prompt ("Continue
  working toward the active goal.").
- Skills/tools the goal needs must be permitted — the goal loop only
  progresses if the model's tools actually work under the profile's
  permission settings (validation note, not a code change).

**2c. Auto-continue loop (D3 wide).**
- Server-side watcher per Claude session with an unmet goal and
  auto-continue ON: when the session goes idle (turn ended, no query open)
  and latest attachment says unmet, send the continuation prompt (bounded:
  max N nudges — default 20 — with exponential backoff 30s→10m, reset on
  progress = new attachments; all bounds configurable via env
  `CLAUDE_GOAL_AUTO_CONTINUE_*`; hard-off switch). Persist the nudge count
  with the session so restarts don't reset the budget silently.
- RED-first with a fake claude service (idle + unmet ⇒ prompt sent once;
  met ⇒ no nudge; paused ⇒ no nudge; cap reached ⇒ stop + status
  `paused`/`pausedReason:'budget'`-equivalent + `goal_end{failed}`-ish
  event or `paused` event).

**2d. Events + browser bridge.**
- After each turn (and after each nudge decision), re-read the transcript
  and if the projection changed, publish `goal_state`/`goal_end` to the
  broker AND emit the OpenCode-bridge-shaped widget/status WebSocket
  events (status key `goal-engine`, widget key `goal-engine-status`) —
  this is what makes the existing frontend work in Phase 4 with zero new
  UI components.
- Live check [sonnet]: create Claude SDK session → POST goal start
  (detached) → poll GET goal (`running`) → watch `goal_end{achieved}`
  (trivial marker-file goal); then a deliberately-unmet goal with
  auto-continue ON → observe ≥1 nudge turn; pause → no further nudges.

### Phase 3 — Command Code runtime (≈1–1.5 days)

**3a. Build the goal-runner mod** (`/root/cmd-enhancement/goal-runner/`,
sibling of watch-wake; TS, no build step; README + unit tests for the pure
policy parts; commit & push cmd-enhancement).
- Inputs: `--mod-option` values `goal.objective`, `goal.maxTurns`,
  `goal.verifyCommand`, `goal.verifier=command|model|both`,
  `goal.modelVerifier=<modelId>` (optional override), plus a state file
  path option `goal.stateFile` pointing INSIDE the session's native home
  (server writes the absolute path; the mod never guesses).
- Behaviour:
  - Round 0: inject a `<goal-bootstrap>`-style first user-turn context via
    `transformContext` (bootstrap prompt: objective + completion protocol
    "end your final message with a line `GOAL: DONE` / verification
    claim"), and the objective via `appendSystemPrompt` — **byte-stable**
    (compute once from modState; never vary per round).
  - Each Stop (`onStop`): decide continue/stop.
    - `verifier=command` (default when `goal.verifyCommand` set): run the
      command via the runtime shell; exit 0 ⇒ complete; non-zero ⇒
      `{continue:true, reason:'verification failed: …'}` (respect the
      8-consecutive cap; when the cap is hit, write
      `status:'paused', pausedReason:'stop-hook-cap'` and stop).
    - `verifier=model` (D3): replicate upstream's evidence-based check —
      build evidence from the last N tool results (mirror
      `buildGoalEvidence`: cap blocks ~5, chars per block) +
      `lastAssistantText`, call the model verifier via the harness model
      client (or a `--mod-option` designated verifier model), parse
      done/not-done with a strict prompt; same continue semantics.
    - `both`: command must pass AND model must agree.
  - Completion: write terminal state to the state file
    (`{status:'completed', completedAt, turns, verify…}`), emit a
    completion notice (metadata `{isGoalComplete:true, goalText,
    goalTurns, goalElapsed}` — same shape as upstream), and do NOT
      continue.
  - Every state change (bootstrap, each turn counted, paused, completed,
    cleared) is appended to the state file (JSON lines or rewrite; keep it
    small) — this is the server's read channel.
  - Turn budget: mirror upstream caps (maxTurns default 100) via
    `shouldStopAfterTurn` + state; pause with `pausedReason:'budget'`.
  - Clear signal: the server deletes/rewrites the state file with
    `{status:'cleared'}` before spawning the next run without goal mod
    options; the mod also supports `goal.controlFile` polling if simpler.
- Unit-test the pure decision functions (command verdict → continue/stop;
  cap accounting; evidence trimming; state transitions) RED-first.

**3b. pi-web-ui argv extension.**
- RED: `buildCommandCodeArgs` tests — when a goal is active for the
  session, args gain `--mod <server-owned path to goal-runner mod>` +
  `--mod-option` set (objective length-capped; options escaped); when no
  goal, argv is byte-identical to today. The mods source path is
  server-owned config (`COMMAND_CODE_MODS_DIR`, default
  `<stateDir>/mods/`, populated from cmd-enhancement by an install script
  or a checked-in copy — decide at execution; keep it server-controlled,
  callers never choose argv).
- GREEN: implement + config plumbing + document the policy exception in
  `docs/COMMAND-CODE-INTEGRATION.md` (fixed-argv policy now has one
  server-owned, feature-gated addition).
- Server-side goal store for cmdc sessions: per-session goal record
  (objective/options/auto-continue/pause flags) persisted under the
  session's state dir; written by POST goal; read by the launcher and
  GET goal (combined with the mod's state file).

**3c. Event adapter.**
- RED: `notice` events with `isGoalNotice` metadata and completion
  metadata map to normalized `goal_state` events (and `goal_end` on
  terminal); other notices become a neutral `notice`-ish normalized event
  or stay dropped — pick the minimal honest mapping and test it.
- GREEN: extend `command-code-event-adapter.ts`; publish via broker; emit
  browser widget/status bridge events.

**3d. Control semantics.**
- `start`: persist goal record; if session idle, kick a run (existing
  prompt dispatch) whose argv carries the mod; if busy, mark the goal to
  arm on the next run (cmdc runs are per-prompt processes — document this
  honestly: a goal started mid-run arms at the next prompt).
- `pause`: set pause flag in the goal record (launcher stops passing
  continue-inducing options; if the mod is mid-run it stops at the cap or
  `shouldStopAfterTurn` on next round — accept the coarseness, document).
- `resume`: clear pause + kick a continuation run.
- `clear`: write cleared state + kick nothing.
- Live check [meta/muse-spark-1.2-contributor]: full loop — POST goal
  start with `verifyCommand` (marker file test) → run completes →
  GET goal `achieved` → `goal_end` on `/events` snapshot; then a
  model-verifier goal; then pause/clear paths.

### Phase 4 — Frontend parity (≈0.25 day)

- `piExtensionControls.ts`: extend `getGoalControlCommand`/control routing
  with per-runtime paths: pi (slash prompt), opencode (existing
  `goal_control`), claude + commandcode (new server route — prefer
  extending the WebSocket `goal_control` message server-side to route to
  the new goal handlers rather than new message types; keep the client
  dumb).
- Enable `controlsEnabled` + `shouldPauseGoalOnStop` for `claude` and
  `commandcode`; GoalPanel/goalStore need zero changes (events already
  bridge-shaped from Phases 1–3).
- If the widget grammar moved to `shared/` in Phase 1d, switch
  `goalModel.ts` to the shared parser (no behaviour change; narrowing
  tests already exist).
- Browser validation per repo workflow: `webapp-testing` for localhost UI
  checks (goal card appears for a claude session with an active goal;
  controls call the right path; pi/opencode regressions none).
- `npm run lint && npm run typecheck && npm run build` + client tests.

### Phase 5 — Orchestration integration (≈0.5 day)

- Watch support: ensure `event_type` condition accepts `goal_state` and
  `goal_end` (extend any allow-list in WatchManager validation); the
  long-poll `/watches/wait` then works for free. RED-first.
- Create-with-goal: optional `goal` object on `POST /sessions` and
  `POST /sessions/batch` entries (`{objective, maxTurns?, verifyCommand?,
  verifier?, autoContinue?}`) — create then start atomically (per Phase
  1c/2b/3d paths). Tests + docs.
- `GET /sessions/:id/info` gains a `goal` summary field (projection) so
  parents polling info see goal status without a second call. Tests.

### Phase 6 — Docs + skills (≈0.5 day)

- Canonical docs (single sources, no duplication):
  - `docs/INTERNAL-API.md`: goal endpoints, event types, watch usage,
    per-runtime semantics table + honesty matrix (what pause/resume/clear
    really mean per runtime), create-with-goal, examples (curl + script).
  - `docs/INTERNAL-API-CONTRACT.md`: 1.27.0 changelog entry.
  - `docs/GOAL-EXTENSION-UI.md`: add the cross-runtime section (browser
    surface now runtime-neutral for pi/claude/commandcode; state the
    companion/core ownership boundary still holds for Pi).
  - `docs/COMMAND-CODE-INTEGRATION.md`: goal-runner mod, argv policy
    exception, state file channel.
  - `docs/EVENT-PIPELINE.md`: `goal_state`/`goal_end` normalized events.
  - `docs/RECENT-CHANGES.md` + `docs/CODEBASE-MAP.md` touch-ups.
- Skills — edit ONLY the canonical copies in
  `/root/.skills-global/skills-global` (deployed via symlinks; follow the
  skill-creator workflow; commit & push that repo):
  - `pi-web-ui-internal-api-orchestration`: new section "Goal-driven
    children" — what it is, why (compaction survival, sharper long tasks),
    when to use vs plain prompt vs watch-only (decision table), exact API
    calls per runtime, polling vs `goal_end` watch patterns, per-runtime
    caveats (Claude blocking-start + auto-continue; cmdc per-prompt runs;
    Pi slash busy-exemption), failure modes and honest-unsupported matrix.
  - `long-horizon-waiting-strategies`: goal-as-liveness — prefer
    `goal_end` watches over per-run `agent_end` churn for goal-driven
    children; auto-continue + pause semantics; combining goals with
    watch-wake parents.
- `npm run docs:check-agent-guides` (only if AGENTS.md was touched — it
  should not need to be).

### Phase 7 — Deployment (OWNER-GATED, both steps)

1. **agent-os contract mirror resync** to 1.27.0 (constant + test pins +
   contract mirror doc in `/root/agent-os`) — REQUIRED before production
   restart; Command Code session creation fails closed until the mirror
   matches. Coordinate with whoever owns agent-os that week; do not touch
   it mid-run.
2. **Production restart** with the usual pre-checks (activeTurns 0, no
   nonterminal run receipts) — only with fresh owner approval, then
   verify `/capabilities` serves 1.27.0 + goal flags, and run a smoke goal
   on one runtime.

---

## 7. Validation plan (per phase, disposable server)

Use the repo's standard flow (`docs/LIVE-VALIDATION.md` /
pi-web-ui-live-validation skill):

```bash
VALIDATION_DIR="$(mktemp -d /tmp/pi-validation-goal-XXXXXX)"
npm run validate:server -- --dir "$VALIDATION_DIR" --port 0 \
  >"$VALIDATION_DIR/server.log" 2>&1 &
PI_WEB_UI_WAIT_SOCKET="$VALIDATION_DIR/internal-api.sock" npm run internal-api:wait
# … exercise the API over "$VALIDATION_DIR/internal-api.sock" with the
# token from "$VALIDATION_DIR/internal-api-token" …
node scripts/validation-server-stop.mjs --dir "$VALIDATION_DIR" && rm -rf "$VALIDATION_DIR"
```

Models: D5. Scenarios per phase are listed inline above; each live check
must show the actual wire evidence (response bodies + `/events` frames),
not just a 200. Full workspace gates before every commit:
`npm run lint && npm run typecheck && npm run build && npm test`.

---

## 8. Risks, unknowns, and honest limits

- **Pi receipt semantics**: a `/goal start` completes its run receipt at
  the command boundary while the goal turn runs detached — this is
  correct-by-design (the goal loop owns subsequent agent_end events) but
  MUST be documented so parents don't treat the receipt as "goal done".
- **Claude blocking start**: the CLI goal loop holds the query open until
  the goal settles; long goals need detached dispatch (2b). Stop-hook
  errors can appear [LV] — non-fatal, log and continue.
- **cmdc coarseness**: runs are per-prompt processes; pause is
  between-runs at best; the 8-consecutive onStop cap bounds each run's
  goal loop. The mod's state file is the truth channel — the server must
  never guess cmdc goal state from model text.
- **Prompt-injection detector** runs on goal objective text (by design);
  if a legitimate objective is ever blocked, that's a detector-tuning
  conversation, not a bypass.
- **Claude transcript location** depends on profile backend/config-dir;
  the reader resolves per session and returns `supported:false` when it
  cannot (never crash on a missing transcript).
- **Effort**: ≈3–4 focused days total across all phases (1: 0.5, 2:
  0.5–1, 3: 1–1.5, 4: 0.25, 5: 0.5, 6: 0.5).
- **Sequencing with other agents**: pi-web-ui's tree may carry other
  agents' uncommitted work — path-limited staging only. agent-os and
  production are hard-gated (Phase 7).

## 9. Completion checklist

- [ ] Phase 0–6 committed & pushed (pi-web-ui; cmd-enhancement Phase 3a;
      skills-global Phase 6), all gates green, live evidence recorded per
      phase.
- [ ] Contract 1.27.0 in repo with changelog + capabilities flags.
- [ ] Both skills updated (canonical copies only).
- [ ] Phase 7 executed only after owner approvals; production verified.
- [ ] Agent OS capture of durable outcomes after the work lands.
