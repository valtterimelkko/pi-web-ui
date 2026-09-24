# Internal API: Silent No-ops and Pi Session Ownership — Plan

Status: **IMPLEMENTATION COMPLETE (Phases 0–7 executed and independently verified, 2026-09-24; S1–S13 all PASS;
round 2 owner-review fixes complete — S7 browser re-attach corrected and verified over a real WebSocket,
single-flight recovery, non-interactive goal flags in pi-enhancement+API, submitPrompt late-start grace,
Phase 8 restart runbook written; round 3 second-review fixes complete — recovery subscriber release
(eviction leak), runbook backup location + pre-restart clean-build gate, submitPrompt error-path waiter
cancel, client history reload on session_recovered; see
docs/plans/execution-reports/INTERNAL-API-SILENT-NOOP-20260924/INTERNAL-API-SILENT-NOOP-EXECUTION-REPORT.md).
Phase 8 (production rollout) NOT executed — owner-gated; runbook:
docs/plans/execution-reports/INTERNAL-API-SILENT-NOOP-20260924/PHASE-8-RESTART-RUNBOOK.md.**
Written 2026-09-24; regression-checked against commit
history the same day — see §2a; execution decisions in §1a.
Target contract: **1.45.0** (additive, with one deliberate behaviour change —
see §1a correction C2). Production deploy and live-extension deploy are
**owner-gated** (Phase 8).

---

## 1a. Owner execution decisions (2026-09-24, binding)

Recorded verbatim-in-substance from the owner at execution start; these govern
the run and must not be softened by the executor.

- **Ownership.** `/root/pi-web-ui` master and `/root/pi-enhancement` are
  exclusively the executor's for the execution window. The plan's author
  (`claude-3d8ea7dc`) wrote the plan only, changed no code, and will make no
  further edits; `pi-01a0cfeb` is an idle analysis session that makes no
  writes. The executor still declares on the Agent OS board and re-checks
  `agent-os board who` before **each phase commit**. If anyone else shows up
  writing to either repo, the executor stops and notifies the owner.
- **Scope.** Phases 0–7 run fully to "Implementation complete" (S1–S13) with
  **no production changes**. Then the executor stops hard at the Phase 8 gate
  with everything prepared and a Telegram to the owner. Phase 8 happens only
  on the owner's explicit approval in that conversation.
- **Phase 8b groundwork.** The owner of the dead `127.0.0.1:3111` hooks is
  identified **read-only** during Phases 0–7, using bounded searches only
  (never recursing from `/` because of `/mnt/gdrive`), and a restore-or-remove
  recommendation goes into the report. No changes to `/root/.claude/settings.json`.
- **Commit cadence.** Commit per phase with path-limited staging; push once
  each phase's gate is green.
- **Pinned sessions (Phase 4b).** A fenced pinned session with a dead owner is
  **auto-recovered like any fenced session, keeping the pin** (dispose→
  rehydrate, re-attach subscribers). This must be tested and recorded in the
  report.
- **Correction C1 (Phase 4b owner check).** Do not rely on
  `process.kill(pid, 0)` alone. Also compare the lease's recorded process-start
  identity (`processStartIdentity` in pi-enhancement `session-ownership.mjs`).
  If the pid was reused by a different process, treat the owner as **dead**. If
  the check is uncertain, **fail closed with a 409**.
- **Correction C2 (Phase 5 changelog; goal 409).** The change of a goal action
  that did not apply from `200 accepted` to `409 GOAL_ACTION_NOT_APPLIED` is a
  **deliberate behaviour change, not purely additive** — the contract changelog
  must say so explicitly. Before Phase 5 closes, the executor checks how the
  Agent OS client (`/root/agent-os/src`, including `controlSession`) handles a
  409 on goal calls and records the result in the report.

Discovery path: this file → [`../INTERNAL-API.md`](../INTERNAL-API.md) →
[`../INTERNAL-API-CONTRACT.md`](../INTERNAL-API-CONTRACT.md) (see "Required
workflow for API changes") → [`SESSION-ADOPTION-PLAN.md`](./SESSION-ADOPTION-PLAN.md)
(contract 1.40.0, which this plan extends).

---

## 1. Intent

The owner wants Claude Code agents (and any other orchestrator) to be able to
rely on Internal API orchestration. On 2026-09-23 a Claude Code conductor
(session `19856bbe`) adopted a finished Pi executor session (`01a0caac`) and
lost more than an hour because the API **reported success for things that did
not happen**. Fix the API so that every such case either works or fails loudly
within seconds, without over-engineering.

### What actually happened (verified 2026-09-24)

1. The pi-web-ui server loaded `01a0caac` (a browser opened it) while a tmux
   `pi` CLI (pid 1584977) owned it. The `auto-compact-75` extension fenced the
   server's copy. The journal line was
   `2026-09-23 07:54:37 [auto-compact-75] Ownership: conflict (pid 1584977, tui) … This runtime is fenced`.
   A `conflict` fence never auto-recovers, even after the owner exits
   (`auto-compact-75/index.ts` `attemptFenceRecovery`, around line 525).
2. **Goal start/clear were silent no-ops.** `/goal` stops at goal-engine
   `ensureMutable()` (`goal-engine/commands.ts` around line 167) and only
   calls `ctx.ui.notify(...)`. The API returned `accepted:true` and a receipt of
   `completed` / `documented_handler_return` 16 ms later, with zero output.
   (Separately, `/goal clear` on an `achieved` goal is a no-op by design: "No
   active goal to clear".)
3. **Prompts were silently swallowed.** The fenced extension's `input` hook
   returns `{action:"handled"}` (`auto-compact-75/index.ts` around line 1143).
   The Pi SDK `prompt()` then resolves without starting a turn
   (`@earendil-works/pi-coding-agent/dist/core/agent-session.js`
   `_runInputHandlers`, around line 1171). `server/src/internal-api/routes/sessions.ts`
   (around line 5640) waits for `agent_end`, which never comes. The watchdog
   then records `TURN_STALLED "never executed"` after 15 min.
4. **Control actions don't lazy-load.** The fresh child `01a0cf5d` was unloaded
   after 31 min idle (`Unloading idle session after 31min`) despite a durable
   retention lease. `set_thinking_level` then returned
   `404 SESSION_NOT_FOUND "Pi session not loaded"` (sessions.ts around line
   4201), while `GET /sessions/:id` showed it idle. Dispatch lazy-loads through
   `multiSessionManager.subscribeClient`; control actions do not.

An earlier postmortem (Pi session `01a0cfeb`) blamed context-window overflow.
**That diagnosis is wrong**; do not build a context-size pre-flight.

Sources: `/root/.claude/projects/-root-pi-web-ui/19856bbe-a700-4c6c-9266-4ece9f32179f.jsonl`,
`journalctl -u pi-web-ui.service` for 2026-09-23, the extension sources under
`/root/pi-enhancement/{auto-compact-75,goal-engine}` (live copies in
`/root/.pi/agent/extensions/`), and Agent OS candidates `cand-b0kbt30zpo`,
`cand-bhs4gcte51`, `cand-by0tgoi1yy`.

### Design principles

- **Generic first.** Phase 1 catches *any* extension that swallows input, not
  only this fence. Ownership awareness (Phase 4) adds the precise diagnosis and
  the recovery on top.
- **Never steal from a live owner.** Automatic recovery applies only when the
  recorded owner process is dead. A live foreign owner always gets a 409 with
  its pid.
- **Additive contract.** Add new error codes and fields only; no existing
  success shape changes meaning, except that a goal action which did not apply
  stops claiming success.

## 2. Non-goals

- Dispatch context-size pre-flight or model-window metadata (targets a
  non-cause).
- Changing goal-engine or auto-compact-75 *semantics* (fencing rules,
  goal-state machine). The only extension change is publishing read-only status
  (Phase 4a).
- Anthropic safety-classifier behaviour (not fixable from here). Phase 6 adds
  only a guidance note.
- Moving conductor duty off Claude. The owner explicitly wants Claude
  conductors to work.
- Model-routing drift (the executor ran on DeepSeek, which the skill retired on
  2026-09-09). This is an observation only.

## 2a. Regression guardrails from commit history (read before Phase 1)

A history review on 2026-09-24 found earlier fixes this plan must not undo.
Each row names the prior fix, the risk, and the rule the phases follow. The
listed tests must pass **without modification**. Changing one of them is a
regression unless the owner approves it.

| Prior fix (repo, commit) | What it settled | Risk from this plan | Rule |
|---|---|---|---|
| pi-web-ui `eb4d3463` *await Pi agent end after compaction* (contract 1.10.1) | `prompt()` may resolve at an auto-compaction boundary **before** the resumed `agent_start` arrives. The receipt must stay non-terminal until `agent_end`. | Phase 1's "resolved without `agent_start`" rule would fail exactly this case. | Phase 1 never fails a run that saw any compaction event in its window, and waits a short grace period for a late `agent_start`. `session-routes-run-receipts.test.ts` ("keeps a Pi receipt nonterminal when prompt returns at compaction…" and "completes a Pi slash command…") stays green. |
| pi-enhancement `5f757a7` *resume after mid-run 75% compaction* | auto-compact-75 aborts the run to compact, then resumes it with `sendMessage({triggerTurn:true})`. | The same false positive via extension-driven compaction. | Covered by the same compaction rule. Live-validate one mid-run 75% compaction on a Phase 1 build (S2). |
| pi-web-ui `2cd7a411` *route mid-run operator input through the extension input event* | Busy steer joins the running turn; **idle steer queues without starting a turn** (pinned behaviour). | Treating an idle steer as "not executed". | Phase 1 applies to `mode:'prompt'` only, never to steer or follow_up. `server/tests/unit/pi/pi-input-event-steer.test.ts` stays green. |
| pi-web-ui `28c6d644` *voice M3: delivery receipts resolve at SUBMISSION* | `MultiSessionManager.submitPrompt()` resolves on `agent_start` **or when the prompt settles first**, and never waits for turn end. | The same silent-swallow bug exists here: a fenced worker shows green "Sent". Changing it carelessly breaks M3 receipt timing. | Phase 1b (below). `multi-session-manager-submit.test.ts`, `talker/delivery.test.ts` and `websocket/voice-live-mount.test.ts` stay green. |
| pi-web-ui `d27e75cd` *relayed instruction survives an idle or restarted worker* | Pi sessions load lazily by path. The relay rehydrates through `subscribeClient`, delivers, then hands the load back, and never touches an already-loaded session. | Phase 3 inventing a second load path. | Phase 3 reuses that exact pattern. |
| pi-web-ui `379211d6` *Pi model binding durability across rehydration* (contract 1.33.0) | After rehydration the stored model binding must be re-applied **before** taking the shared model lock; doing it inside the lock self-deadlocks. | Phase 3 lazy-load and Phase 4b reload skipping the re-bind: thinking level would clamp against the wrong default model. A re-bind inside the lock would deadlock. | Both call `ensurePiModelBinding` outside `withPiModelLock`, exactly as the dispatch path does. `session-routes-model-binding.test.ts` stays green. |
| pi-web-ui `6d784a75` *headless sessions record extension UI snapshots* | Internal-API sessions get a no-op UI sink so `recordExtensionUiMessage` and goal events reach the broker. | Phase 2 building a parallel notify-capture path, or disturbing the goal bridge. | Phase 2 hooks notify capture into that existing sink. Browser delivery and the goal event bridge stay unchanged. The `multi-session-manager.test.ts` goal-bridge cases stay green. |
| pi-web-ui `c55b1a08` *stale session recovery* and `91effe69` *canonical per-session reference release* | Recovery disposes the AgentSession and rehydrates a fresh one. **Pinned sessions** are status-reset, not disposed. Unload must release every PiService-owned map. | Phase 4b reload leaking references, or silently disposing a pinned session. | Phase 4b uses the existing dispose→rehydrate path, including `releaseSessionRefs`. A fenced **pinned** session gets an explicit decision plus a test; it is never skipped silently. `pi-service-release.test.ts` stays green. |
| pi-enhancement `5764604` / `46982c0` *release disposed SDK session leases; keep disposed owners fail-closed* | Disposing a session releases its lease; a disposed owner stays fenced. | Phase 4b re-subscribing before the old session's shutdown finished, so the new instance meets its own un-released lease or process-owner entry. | Reload awaits full disposal (`session_shutdown` has run) before rehydrating. Test the same-pid reclamation path (`reclaimInactiveProcessOwner`). |
| pi-enhancement `302fdfa` / `8eb9e01` *adopt the append-only tail instead of fencing* | Startup must not hard-fence on the benign disk-ahead tail, because a fenced runtime can't run its own remedy. | Phase 4a changing startup or fence behaviour. | Phase 4a only **publishes** status. It adds no new fence and doesn't change startup. The auto-compact-75 suite stays green. |
| pi-web-ui `2924596f` goal function (contract 1.27.0), `afe4af4a` status labelling | Pi goal start receipt ends at the command boundary. The goal state file is written synchronously (`saveState`) before `/goal` returns. Canonical statuses must not be mislabelled. | Phase 2 read-back racing, or mapping `achieved`, `suggested` or `failed` wrongly. | Read back through `readPiGoalStateFile` / `projectPiGoalState` (the same projection as `GET /goal`). If the disk write failed, the result is a loud 409, never a fake success. Existing goal tests under `server/tests/unit/internal-api/goal/` stay green. |
| pi-web-ui SESSION-ADOPTION-PLAN (contract 1.40.0) | Adoption is display-only and never changes runtime ownership. | Phase 4 making adopt recover or modify leases. | Adopt only **reports** `ownership` (S8). Recovery happens at dispatch or goal time. `session-routes-adopt.test.ts` stays green. |
| pi-web-ui `27d14637` / `60251d0c` truthful run liveness; `stall-notification.ts` | Genuinely never-executed runs end `TURN_STALLED` and send a parent "Wake lost (never executed)" notification. | Phase 1 bypassing the wake, so a parent watching for the terminal event is never woken. | A `PROMPT_NOT_EXECUTED` failure must reach the same terminal fan-out (receipt terminal plus `child_turn_ended`/watch firing) as any failed run. `stall-notification.test.ts` and `run-stall-classification.test.ts` stay green. |

## 3. Definition of success

The executor may report **"Implementation complete"** only when **every** item
in 3.1 holds, with the named evidence written into the execution report
(§7). **"Programme complete"** additionally requires 3.2, which needs explicit
owner approval. Claiming either state without its evidence is a failure of this
plan.

### 3.1 Implementation complete (no production changes)

| # | Criterion | Required evidence |
|---|---|---|
| S1 | A detached **and** a synchronous `prompt` into a session whose input is swallowed fails with `PROMPT_NOT_EXECUTED` within **5 s**. The receipt is `failed`, `errorCode: PROMPT_NOT_EXECUTED`, cessation not `watchdog`. | RED→GREEN unit tests; live-validation receipt JSON showing `terminalAt - acceptedAt < 5000 ms`. |
| S2 | S1 does **not** misfire on: a normal turn; a turn whose `prompt()` resolves at an auto-compaction boundary and then resumes (including the resumed `agent_start` arriving after `prompt()` resolves); an auto-compact-75 mid-run 75% compaction plus resume; `follow_up` into a busy session; `steer` joined to a busy turn; **idle steer** (queues, no turn); Pi slash commands. Every test named in §2a passes **unmodified**. A `PROMPT_NOT_EXECUTED` failure fires the same terminal fan-out and watch wake as other failed runs. | One unit test per case, all green. Before/after output of the §2a test files, plus `git diff --stat` showing none of them edited. Live validation of the normal, slash-command and mid-run 75% compaction cases. |
| S2b | Voice relay: a fenced or swallowed worker prompt is reported as **not delivered** with a reason, never as green "Sent". M3 receipt timing for real deliveries is unchanged. | RED→GREEN test in `talker/delivery.test.ts` or `multi-session-manager-submit.test.ts`; existing M3 tests unchanged and green. |
| S3 | `POST /sessions/:id/goal {action:"start"}` on a Pi session where the goal did not change returns **409 `GOAL_ACTION_NOT_APPLIED`**. The body includes the observed goal state and any extension warning text captured during the command. The receipt is `failed` with the same code. | Unit tests (fenced start, malformed/blocked start). Live-validation response body quoting the goal-engine "read-only" warning. |
| S4 | `start` on a session whose goal is `achieved` (unfenced) **replaces** it: read-back shows the new objective with status `running` or `wrapping_up`. `clear` on an already-inactive goal returns 200 with `applied:false, reason:"already_inactive"` rather than a fake `completed`. | Unit tests plus live-validation read-back. |
| S5 | Pi control actions (at least `set_thinking_level`; audit every `getAgentSession` → 404 `"Pi session not loaded"` path in control routes and create) lazy-load an unloaded registered session and succeed. Create-time `thinkingLevel` reads back non-null when the model supports it, or the response says why not. | Unit tests; live validation that unloads a session (or waits for eviction) and then sets the thinking level successfully. |
| S6 | With a **live** foreign owner holding the lease, prompt, goal and control actions return **409 `SESSION_OWNED_BY_OTHER_RUNTIME`** within 2 s, with `ownerPid` and owner mode. No run is left `started`, no lease is modified, and the owner's session file is byte-identical before and after. | Unit tests; live validation using a real foreign owner (a `pi` CLI on the session, or a fixture process holding a valid lease), with a sha256 of the session file before and after. |
| S7 | With a **dead** recorded owner and a fenced server copy (the exact 23 Sep shape), the next prompt or goal action recovers automatically. The server reloads the session, the extension reports `owned`, and the action proceeds. Browser subscribers stay attached or are re-attached. | Unit tests for the recovery path; **the incident replay (§6) passes end to end.** |
| S8 | `GET /sessions/:id` and the `adopt` response expose `ownership: {status, reason?, ownerPid?, ownerAlive?}` for Pi sessions (`unknown` when the extension does not publish). Adoption stays display-only and does not recover or modify leases. | Unit tests; live-validation read of both. |
| S9 | Contract bumped to **1.45.0**. The new codes are in the error catalogue and `server/src/internal-api/error-codes.ts`. `INTERNAL-API.md`, `INTERNAL-API-CONTRACT.md`, `INTERNAL-API-ORCHESTRATION.md`, `SHARP-EDGES.md` and `TROUBLESHOOTING.md` (fence diagnosis) are updated. The Agent OS mirror `/root/agent-os/docs/PI-WEB-UI-INTERNAL-API-CONTRACT.md` is updated and the Agent OS test suite passes. | Diff plus command output for each. |
| S10 | Skill updates (§5 Phase 6) are landed in the canonical source `/root/.skills-global/skills-global`, committed and pushed. | Commit hashes. |
| S11 | pi-enhancement change (Phase 4a) is committed and pushed, with its own tests passing. The live `/root/.pi/agent/extensions/auto-compact-75` is **not** yet changed (that is Phase 8). | Commit hash, test output, and a `diff -rq` showing live ≠ store only in the new change. |
| S12 | All gates in §4 pass on the final commit, and CI on `master` is green for it. | Command outputs and `gh run list` output. |
| S13 | An **independent verification** runs: a fresh reviewer session (not the implementer) re-runs the incident replay and S6 on a disposable server from the committed code and reports PASS. | Reviewer's report path and verdict. |

**Not done if any of these is true:** a criterion is "covered" only by unit
tests where live evidence is required; a test was weakened or deleted to go
green; a RED phase was not observed; the replay was run against production; the
S6 file hash changed; or any timing bound was met only by raising a timeout.

### 3.2 Programme complete (owner-gated)

| # | Criterion | Evidence |
|---|---|---|
| P1 | Owner approved deploying the Phase 4a extension change to `/root/.pi/agent/extensions/auto-compact-75` and restarting `pi-web-ui.service`. | Quoted approval. |
| P2 | Production is serving the new build (`/api/v1/capabilities` shows contract 1.45.0) and the extension publishes status. A read-only `GET /sessions/:id` on a real Pi session shows `ownership.status`. | API output. |
| P3 | Dead Claude Code hooks resolved per Phase 8b, if the owner approves. | Before/after settings diff, and a fresh Claude session transcript with no `ECONNREFUSED 127.0.0.1:3111`. |

## 4. Quality gates

Run from `/root/pi-web-ui` unless noted:

- `npm run lint`, `npm run typecheck`, `npm run build`
- `npm test` (server suite baseline is 0 failures; any new failure blocks)
- `npm run docs:check-agent-guides`, `npm run docs:check-links`
- pi-enhancement: its test runner for `auto-compact-75` (see that repo's
  `AGENTS.md`)
- agent-os: `npm test` after the mirror update
- Live validation on a **disposable** server only (`npm run validate:server`;
  see [`../LIVE-VALIDATION.md`](../LIVE-VALIDATION.md)). Isolate
  `PI_CODING_AGENT_DIR` / prefs so nothing touches production `~/.pi/agent`
  (see `docs/TROUBLESHOOTING.md` and the shared-env isolation notes).

## 5. Phases (strict TDD: write the test, **observe it fail**, then implement)

### Phase 0: Baseline and fence reproduction (no product code)

1. Declare on the Agent OS board. Check for other agents in `/root/pi-web-ui`
   (`agent-os board who`) and coordinate before editing.
2. Build a reproducible fence fixture for the disposable server:
   - **Live-owner case:** start a real `pi` CLI (or a small fixture process)
     that acquires the session lease via `session-ownership.mjs`
     `acquireSessionLease` in the *isolated* lease dir, then load the same
     session in the disposable server.
   - **Dead-owner case:** same, then kill the owner process. The server copy
     must stay fenced; confirm "Ownership: conflict" in the disposable server
     log.
3. On unmodified `master`, record the three symptoms as RED evidence: goal
   start "completed" without change, prompt with no turn (stop observing
   after 60 s, since the watchdog is 15 min), and control 404 after unload.
   Save the evidence under `docs/plans/execution-reports/`.

### Phase 1: `PROMPT_NOT_EXECUTED` fail-fast (pi-web-ui)

- Where: the Pi branch of `executePrompt` in
  `server/src/internal-api/routes/sessions.ts` (around line 5540–5670), next to
  the existing `documented_handler_return` slash-command branch.
- Rule: for `mode === 'prompt'` **only** (idle steer queues by design, see
  §2a `2cd7a411`): once `agentSession.prompt()` resolves, if **no
  `agent_start`** and **no compaction event** (`session_compaction` or any
  compaction start/end the observers see) were observed in the run's window,
  and the session is not streaming or compacting, wait a short bounded grace
  (≈2 s, a named constant) for a late `agent_start`. If none arrives, fail
  the run with `PROMPT_NOT_EXECUTED`. Include any captured extension notify
  text (Phase 2 capture) in the error detail.
- Reuse the turn-start detection `MultiSessionManager` already has
  (`armTurnStartWaiter`, from `28c6d644`) rather than writing a second
  detector. Arm it before calling `prompt()`.
- The existing compaction-boundary behaviour (`eb4d3463`) is untouched: any
  observed compaction means "keep waiting for `agent_end`" as today.
- The failure goes through the normal receipt-terminal path, so watches,
  `child_turn_ended` and stall/wake notifications fire (§2a).
- Add `PROMPT_NOT_EXECUTED` to `error-codes.ts` and types.

### Phase 1b: Voice relay honesty for swallowed prompts (pi-web-ui)

- `MultiSessionManager.submitPrompt()` treats "prompt settled before any
  `agent_start`" as delivered. For a fenced worker, that means a green "Sent"
  for an instruction that never ran.
- Expose whether a turn actually started (for example, return
  `{ turnStarted }` or throw a typed not-executed error, applying the same
  compaction exemption and grace as Phase 1). The Pi delivery adapter then
  reports `refused` with the reason, using the amber "NOT sent" path from
  `d27e75cd`.
- M3 timing for genuine deliveries must not change (S2b). Voice rule: this
  changes delivery *honesty* only, and must never widen the talker gate's
  reachability (see `server/src/talker/policy-core.ts` and
  [`../VOICE-MODE-INDEX.md`](../VOICE-MODE-INDEX.md)).

### Phase 2: Goal actions tell the truth (pi-web-ui)

- Capture extension `notify` messages emitted on the session during a
  slash-command window. The server's UI adapter is
  `server/src/pi/extension-ui-adapter.ts` `notify()`, and headless sessions use
  the no-op sink from `6d784a75`. Hook a bounded per-session capture into
  those existing sinks (don't add a parallel path), leaving browser delivery
  and the goal event bridge unchanged.
- Read back through `readPiGoalStateFile` / `projectPiGoalState`, the same
  projection `GET /goal` uses. goal-engine writes it synchronously before the
  handler returns, so no polling is needed.
- After a Pi `/goal start|clear|pause|resume` command returns, read back the
  goal projection and compare it with the requested transition:
  - start: objective equals the requested one and status is running or
    wrapping_up, otherwise `409 GOAL_ACTION_NOT_APPLIED`
  - clear: if the goal was already inactive, return 200 with `applied:false`
  - pause and resume: equivalent checks
- The receipt for a not-applied action ends `failed` with the same code, never
  `completed`.
- Composition lives in `server/src/internal-api/goal/goal-actions.ts`; tests go
  in `server/tests/unit/internal-api/goal/`.

### Phase 3: Control actions lazy-load (pi-web-ui)

- Replace `getAgentSession → 404 "Pi session not loaded"` in control and
  create paths (sessions.ts around lines 1637 and 4201; audit the rest) with
  the same load path dispatch and the voice relay use (`subscribeClient` on an
  internal client, act, then hand the load back; a session already loaded is
  left as it is, per `d27e75cd`).
- After loading, re-apply the stored model binding with `ensurePiModelBinding`
  **outside** `withPiModelLock`, before setting the thinking level (§2a
  `379211d6`). Thinking level clamps per model.
- A genuinely unknown session stays `404 SESSION_NOT_FOUND`.
- Investigate why create-time `thinkingLevel:"max"` read back `null` for
  `zai/glm-5.3-flash`. Fix it, or return an honest reason (S5).

### Phase 4: Ownership awareness

**4a. pi-enhancement (`/root/pi-enhancement/auto-compact-75`)**, TDD in that
repo:

- Publish a read-only in-process snapshot:
  `globalThis[Symbol.for("auto-compact-75:ownership-status")]` →
  `Map<canonicalSessionPath, {status, reason, ownerPid?, ownerMode?, updatedAt}>`.
  Update it on every ownership transition and delete the entry on session
  shutdown. This mirrors the existing `PROCESS_SESSION_OWNERS_SYMBOL` pattern.
  Don't change fencing behaviour.
- Commit and push the store repo. **Don't** copy to
  `/root/.pi/agent/extensions` (production) until Phase 8.
- For the disposable server, load the updated extension from an isolated agent
  dir.

**4b. pi-web-ui server:**

- Add a small reader module, for example `server/src/pi/session-ownership-status.ts`,
  that looks up by canonical (realpath) session path. If the map is absent, the
  result is `unknown` and no gating applies.
- Before Pi prompt, goal and control actions:
  - status `owned` or `unmanaged`: proceed
  - `conflict` or `uncertain` with a live owner pid (`process.kill(pid,0)`), or
    owner state `handing_off`: return `409 SESSION_OWNED_BY_OTHER_RUNTIME`
    with `ownerPid`, `ownerMode`, `reason` and a hint
  - fenced with a dead or absent owner: reload the session with the existing
    dispose→rehydrate recovery (`c55b1a08`, including `releaseSessionRefs`
    from `91effe69`). **Await full disposal** (the extension's
    `session_shutdown` has released its lease and process-owner entry) before
    rehydrating. Keep or re-attach browser subscribers, and re-apply the model
    binding outside the model lock. The extension's startup path re-acquires
    the stale lease. Re-read the status and proceed if `owned`, otherwise
    return `409 SESSION_FENCED` with the reason.
  - For a **pinned** fenced session, make an explicit decision (reload anyway,
    or 409 with a hint), record it in the report, and cover it with a test.
    Never skip it silently.
- Expose `ownership` on `GET /sessions/:id` and in the `adopt` response (S8).
- Log every refusal and recovery with the session id, so the journal answers
  "why" directly.

### Phase 5: Contract and documentation

Follow the "Required workflow for API changes" in
`docs/INTERNAL-API-CONTRACT.md`:

- Bump `INTERNAL_API_CONTRACT_VERSION` to `1.45.0` and add a changelog entry.
- Add the new codes to the error catalogue.
- Update `INTERNAL-API.md` for the new fields and responses.
- Update `INTERNAL-API-ORCHESTRATION.md` (adoption now reports ownership;
  never-executed runs fail fast).
- `SHARP-EDGES.md`: the browser opening a CLI-owned session fences the server
  copy.
- `TROUBLESHOOTING.md`: to diagnose a fence, search the journal for
  `Ownership: conflict` over the session's **whole lifetime**, not just the
  incident window.
- Agent OS mirror `/root/agent-os/docs/PI-WEB-UI-INTERNAL-API-CONTRACT.md`:
  coordinate on the board first, since agent-os is often active.

### Phase 6: Skills (canonical source only; use the `skill-creator` skill)

In `/root/.skills-global/skills-global/pi-web-ui-internal-api-orchestration/`:

- `references/adoption.md`: a session the web UI loaded while a CLI owned it
  stays fenced. From 1.45.0 the API recovers when the owner is dead and returns
  `SESSION_OWNED_BY_OTHER_RUNTIME` when it is alive. Read `ownership` from the
  adopt response. For brand-new long work on a big finished session, prefer a
  fresh child with a file handoff brief.
- `references/goals.md`: `GOAL_ACTION_NOT_APPLIED`, `applied:false` on clear,
  and that start replaces an achieved goal.
- `references/evidence.md` and the SKILL.md error table: `PROMPT_NOT_EXECUTED`
  and the ownership codes.
- `references/orchestrator-governance.md` (short note): for Claude conductors,
  keep child briefs in files and dispatch with short neutral prompts. Don't
  write owner-authority claims ("owner-authorised …") into text sent to another
  agent; this is a suspected, unverified safety-classifier trigger.

### Phase 7: Live validation and independent verification

**Incident replay** (disposable server, isolated dirs). This is the S7 gate:

1. Create a Pi session, give it an achieved goal, and have a fixture CLI own
   its lease. Open it in the disposable server so it becomes fenced. Kill the
   owner.
2. Create a parent and adopt the session. `ownership` shows fenced with a dead
   owner.
3. `goal start` with a new objective returns success after recovery, and
   read-back shows the new objective `running`.
4. A detached prompt produces a real turn: assistant output > 0 and the receipt
   is `completed` with `outputEvidence.assistantMessages ≥ 1`.
5. Repeat steps 1–3 with the owner **alive**: every action returns 409 within
   2 s, and the session-file sha256 is unchanged (S6).
6. Unload an idle session, then `set_thinking_level` succeeds (S5).

Use a cheap live model for the turn in step 4 (see the orchestration skill's
`routing.md`). Then commission a fresh reviewer session to repeat steps 1–5
from the committed code (S13).

### Phase 8: Owner-gated rollout

**8a.** With owner approval: copy `auto-compact-75` from pi-enhancement into
`/root/.pi/agent/extensions/auto-compact-75`, build, and run
`sudo systemctl restart pi-web-ui.service`. Verify P2 with read-only calls. Any
already-loaded sessions pick up the new extension only when reloaded; say so
in the report.

**8b.** With owner approval: `/root/.claude/settings.json` has four `type:
http` hooks pointing at `http://127.0.0.1:3111/hook/*` (PostToolUse, Stop,
SessionStart, UserPromptSubmit). Nothing listens there (verified 2026-09-24).
First identify the owning project, using bounded searches only (never recurse
from `/`, because `/mnt/gdrive` hangs). Then either restore the service or
remove the four entries, following the `update-config` skill.

## 6. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Phase 1 false positives around auto-compaction or queued turns | S2 tests for each case; condition requires no `agent_start` **and** not streaming or compacting. |
| Reload in Phase 4b disrupts browser viewers | Re-attach subscribers; unit test with an attached browser client; reload only when fenced **and** owner dead. |
| Extension map absent (older deploy) | `ownership: unknown`, no gating; Phase 1 still catches the swallow. |
| Racing a CLI that starts between check and dispatch | The extension's own fence still blocks the turn, and Phase 1 turns it into `PROMPT_NOT_EXECUTED`, never a 15-min stall. |
| Touching production during validation | Disposable server with isolated `PI_CODING_AGENT_DIR`, prefs and lease dir; the replay must never use `/root/.pi/agent`. |

## 7. Hand-back

Write `docs/plans/execution-reports/INTERNAL-API-SILENT-NOOP-AND-SESSION-OWNERSHIP-REPORT.md`
with one row per S-criterion (and P-criterion if reached): status, evidence
pointer (test name, file, command output, receipt JSON), and commit hash. List
anything deferred, and why. Update this plan's `Status:` line. Commit on
`master` with path-limited staging, push, and send a Telegram completion
notification (check its delivery status).

Owner actions outside the executor's remit: in the Agent OS review queue,
reject or correct `cand-1r0sqqv3d9`, `cand-27b47fgzfp` and `cand-34mdd3zmg7`.
They record the superseded diagnosis.
