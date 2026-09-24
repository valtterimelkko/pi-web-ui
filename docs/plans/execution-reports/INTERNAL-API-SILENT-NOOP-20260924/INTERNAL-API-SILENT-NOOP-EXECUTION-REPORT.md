# Execution Report — Internal API: Silent No-ops and Pi Session Ownership

- Plan: `docs/plans/INTERNAL-API-SILENT-NOOP-AND-SESSION-OWNERSHIP-PLAN.md` (§1a owner decisions binding)
- Executor: pi session `01a0d366-9752-77a9-a336-45cd8427a81a` (board: pi-01a0d366), 2026-09-24
- Contract: **1.45.0** shipped on `master`; production still serves **1.44.0** at revision `c1dedf0`+voice deploys — **no production changes made**
- Verdict: **IMPLEMENTATION COMPLETE — S1–S13 all satisfied with evidence (independent reviewer PASS); CI green on `master` at `e55e288d`. Programme complete (Phase 8) NOT executed — owner-gated.**
- Final commit at report time: `e55e288d` (see the commit table in §Commits)

## S-criteria

| # | Criterion | Status | Evidence |
|---|---|---|---|
| S1 | Swallowed detached + synchronous prompt fails `PROMPT_NOT_EXECUTED` within 5 s, receipt `failed`, cessation not watchdog | **PASS** | Unit: `session-routes-prompt-not-executed.test.ts` (6 tests). Live: `phase1-live-validation.md` — sync HTTP 500 in 2.756 s, receipt `terminalAt−acceptedAt = 2737 ms`; detached `2009 ms` |
| S2 | No misfire on normal/compaction/steer/follow_up/slash; §2a pinned tests unmodified; failure reaches normal terminal fan-out | **PASS** | Guard tests in the same file (slow start, compaction exemption, streaming, waiter); pinned files unmodified (`git diff --stat` per commit; §2a set re-run green: run-receipts 24, steer, submit M3, delivery, voice-live-mount, model-binding, goal suite 145, stall tests). `PROMPT_NOT_EXECUTED` rides `runReceipts.finish(failed)` — the same terminal path as any failed run |
| S2b | Voice relay: swallowed worker prompt reported not-delivered with reason; M3 timing unchanged | **PASS** | `multi-session-manager-submit-honesty.test.ts` (4 tests incl. delivery `refused` mapping); pinned `multi-session-manager-submit.test.ts` + `talker/delivery.test.ts` + `websocket/voice-live-mount.test.ts` green unmodified |
| S3 | Goal start that did not apply → 409 `GOAL_ACTION_NOT_APPLIED` with observed goal + extension warning; receipt failed | **PASS** | Unit: `goal-transition.test.ts` (15) + `goal-action-truth.test.ts` (6, incl. receipt `failed` assertion). Live: `phase2-live-validation.md` — 409 in 0.54 s quoting the goal-engine's read-only warning verbatim |
| S4 | Start on achieved goal replaces it; clear on inactive → 200 `applied:false, reason:"already_inactive"` | **PASS** | Unit: goal-action-truth (achieved replacement, already_inactive); replay step 3 (live): `applied:true`, read-back running on the new objective; replay clear path unit-covered |
| S5 | Control actions lazy-load unloaded registered sessions; create-time thinkingLevel honest | **PASS** | Unit: `pi-control-lazy-load.test.ts` (5). Live: `phase3-live-validation.md` — set_thinking_level 200 in 0.48 s where Phase 0 RED showed 404 in 7 ms; create echoes `thinkingLevel` (`glm-5.3-flash`+`max` → `"max"`; null → `thinkingLevelNote`) |
| S6 | Live foreign owner → 409 `SESSION_OWNED_BY_OTHER_RUNTIME` ≤ 2 s with ownerPid/mode; no run started; lease untouched; session file byte-identical | **PASS** | Unit: `session-ownership-status.test.ts` (15) + `pi-ownership-gate.test.ts` (7). Live: prompt 409 in 5.7 ms, goal 409 in 5.8 ms (`phase4-live-validation.md`); replay step 5: 409 in 5.1/3.4 ms, sha256 `15498881…1081` unchanged |
| S7 | Dead owner + fenced → automatic recovery on next action; extension owned; action proceeds; browser subscribers re-attach | **PASS** | Phase 0 RED baseline (fence persisted with dead owner on master) vs live recovery: replay steps 2–3 (recover → `applied:true`, goal replaced, real goal turns ran) + Phase 4 S7 probe (real turn `"PONG"`, 11.6 s; ownership → `owned`, reason "recovered a lease from a dead runtime"). Pin restoration unit-tested (`pi-ownership-gate.test.ts` pinned case) per the owner's pinned-session decision |
| S8 | `ownership` on GET /sessions/:id + adopt response, display-only; `unknown` when unpublished | **PASS** | Unit: gate test S8 case; live: replay step 2 adopt response `ownership:{status:"conflict",ownerPid:1887054,…}`; GET shows snapshot incl. `leaseState`; adoption does not recover or modify leases (code: gate is never invoked from adopt; S8 field is read-only projection) |
| S9 | Contract 1.45.0; codes in catalogue + `error-codes.ts`; five docs updated; Agent OS mirror updated + suite run | **PASS** | `types.ts` → 1.45.0; `error-codes.ts` adds PROMPT_NOT_EXECUTED, GOAL_ACTION_NOT_APPLIED, SESSION_OWNED_BY_OTHER_RUNTIME, SESSION_FENCED (+ERROR_CODE_INFO); `INTERNAL-API-CONTRACT.md` changelog entry (deliberate 200→409 flagged per correction C2) + version JSON; INTERNAL-API.md goal-truth + receipt sections; ORCHESTRATION runs bullet; SHARP-EDGES fencing entry; TROUBLESHOOTING fence-diagnosis ladder; drift test + capabilities + command-code pins moved. Agent OS mirror `1429bcb` (docs + `CURRENT_PI_WEB_UI_CONTRACT_VERSION` + pin test); agent-os suite 2841/2843 — the 2 failures (eva-harness) verified identical on the pre-change tree |
| S10 | Skill updates landed in `/root/.skills-global/skills-global`, committed and pushed | **PASS** | skills-global commit `c8e271a` (SKILL.md dispatch table, adoption.md ownership section, goals.md truth section, evidence.md ladder step 7, orchestrator-governance.md Claude-conductor note) — pushed |
| S11 | pi-enhancement change committed+pushed with tests; live copy unchanged | **PASS** | pi-enhancement commit `0ba8bcd`: `ownership-status.mjs` + 9 publication points in `index.ts` + `tests/auto-compact-75-ownership-status.test.mjs`; all auto-compact-75 tests green; `diff -rq` store vs `/root/.pi/agent/extensions/auto-compact-75` shows ONLY the new change (index.ts + ownership-status.mjs) |
| S12 | §4 gates pass on final commit; CI on master green | **PASS** | Final local full suite on `e55e288d`: 483 server files / 5925 tests, 147 client / 1655, shared, mcp — exit 0; typecheck 0 errors; lint 0 errors (warnings ≤ baseline); build OK; docs checks OK. CI on `e55e288d`: Docs checks ✓ and Application correctness ✓ (run 36023962466; the first failure was the stale command-code version pin — fixed in `e55e288d` — and the rerun's initial ETXTBSY spawn flake cleared on re-run) |
| S13 | Independent reviewer re-runs the replay + S6 from committed code | **PASS** | Attempt-4 reviewer (fresh session, isolated env, code identity at `e55e288d`): all seven steps PASS — see §S13 verdict below. Attempts 1–3 failed on environment/brief defects and were honestly reported; attempt 4 passed every step |

### S13 reviewer verdict

**PASS — OVERALL: PASS** from the independent reviewer (attempt 4; fresh worker session, own disposable server, own isolated agent dir, code identity proven at `e55e288d`, tracked tree clean):

| Step | Result | Evidence |
|---|---|---|
| Boot | PASS | Health 200, contract 1.45.0 |
| Live-owner fence/load | PASS | Fixture pid 1969296; detached load 202; `ownership.status=conflict` published |
| Adopt (dead owner) | PASS | 200; conflict retained with the dead pid |
| Goal recovery | PASS | Goal start 200 `applied:true`; read-back `running` with the reviewer's own objective |
| Completed prompt receipt | PASS (sanctioned fallback) | Recovered goal session busy/failed on direct prompt (fast RUNTIME_ERROR — the goal-loop collision documented below); fresh clean session in the same env: 200, "REVIEW OK", run completed with `assistantMessages=1` |
| S6 immutability | PASS | Goal + prompt both 409 `SESSION_OWNED_BY_OTHER_RUNTIME` in 5.026 ms / 3.411 ms; session sha256 `23ee9aff…95af9f` unchanged |
| Cleanup | PASS | Server stopped, fixture killed, socket absent, tracked diff clean |

Reviewer evidence: `/tmp/reviewer4-val-Ye3j/evidence/` (transient path; verdict and extracts quoted here and in the hand-back Telegram). Honest history: attempts 1–3 failed on environment/brief defects (missing tsx, npm-install budget, missing load-before-kill + goal-loop collision), each reported honestly; attempt 4 with the corrected brief passed every step. New observation recorded as a known interaction: immediately after dead-owner recovery with an active goal loop, a plain prompt can collide with the loop (fast honest failure, never a hang) — pause the goal or use a fresh session for immediate follow-up prompts.

**Implementation complete: S1–S13 all satisfied. Programme complete (Phase 8) remains owner-gated and NOT executed.**

## Phase 8b groundwork (read-only identification; NO changes made)

The four dead `type:"http"` hooks in `/root/.claude/settings.json` (`http://127.0.0.1:3111/hook/{post-tool-use,stop,session-start,user-prompt}`, matchers `*`) were written by **Pi Web UI's Claude channel-backed mode**: `server/src/claude/claude-channel-hooks-config.ts` `buildHooksConfig()` emits exactly these four shapes from `~/.claude/settings.json`, and `claude-channel-service.ts:153` (`writeHooksConfig()`) registers them when the channel starts. The port comes from `CLAUDE_CHANNEL_HOOK_PORT` (today's default **3101**; the entries carry **3111**, so they were written while a 3111 configuration was in effect). Supporting evidence: the pi-web-ui channel family uses these exact route names (`claude-channel-hooks-config.test.ts`); the claude-channels skill documents the same routes on 3101; Agent OS's command hooks (`agent-os-hook.mjs`, `pre-tool-bash.sh`) are unrelated command-type hooks and work.

Production `.env` has no `CLAUDE_CHANNEL_*` entries → `CLAUDE_CHANNEL_ENABLED !== 'true'` → the channel is disabled → nothing serves 3111 → the entries are dead weight producing `ECONNREFUSED` noise on every Claude Code tool/prompt/stop event.

**Recommendation (Phase 8b, owner-gated): REMOVE the four http hook entries.** The owning feature is disabled; if you later enable channel mode, `writeHooksConfig()` re-registers the hooks automatically on the then-current port. Preserve the two Agent OS command-hook groups and everything else in the file. (The alternative — restoring a listener on 3111 — has no current purpose.) A managed removal exists in-code (`removeHooksConfig()`), or a surgical JSON edit removing exactly those four entries.

## Deliberate behaviour changes and corrections honoured

- **C2 recorded**: the contract changelog entry flags the goal `200→409` change as deliberate, not purely additive. Agent OS client audit (`/root/agent-os/src`): `controlSession` throws a typed `PiWebUiError` carrying the server's wire `code` and HTTP status on any ≥400; Agent OS never calls the goal route; its only control verb is `unpin` in dispatch cleanup, whose refusal already routes the lease to manual reconciliation — so the change is safe for the one in-tree consumer. Included here per correction C2.
- **C1 honoured**: owner liveness = pid liveness AND lease `pidStartIdentity` match (`/proc/<pid>/stat` field 19); recycled pid → dead; ambiguous → fail-closed 409 (unit-tested).
- **Pinned sessions**: auto-recover keeping the pin (owner decision), unit-tested.

## Known limits (documented, not silently skipped)

- Goal-transition verification applies to **idle** sessions; busy-session queued commands keep the contract-1.27.0 accepted shape because the goal state may legitimately lag mid-run (pinned busy pass-through test left unmodified). A queued-command lifecycle tracking is a possible follow-up.
- `clear` on an **active** goal runs the extension's interactive confirm; headless dispatch times it out (~30 s) and the action then answers 409 honestly (state unchanged). Rare path; noted for expectations.
- Pre-load race (unfenced-but-lease-held, nothing published yet): first action proceeds (plan: unknown never gates), the extension fences at load, and Phase 1 fails the prompt fast — the plan's own accepted mitigation (§Risks).

## Commits (all pushed)

| Repo | Commit | Content |
|---|---|---|
| pi-web-ui | `cf2fb579` | Owner decisions §1a + Phase 0 RED evidence |
| pi-web-ui | `0caed4a3` | Phases 1–3 code + tests |
| pi-web-ui | `d1c0ef99` | Phase 0–3 evidence |
| pi-web-ui | `25d9505d` | Phase 4b gate/recovery/status + Phase 5 contract 1.45.0 + docs |
| pi-web-ui | `e55e288d` | Command-code contract pin → 1.45.0 + Phase 7 replay evidence |
| pi-enhancement | `0ba8bcd` | Phase 4a ownership status publication |
| agent-os | `1429bcb` | Contract mirror 1.45.0 + client constant + pin test |
| skills-global | `c8e271a` | Orchestration skill updates (Phase 6) |

## Owner actions outside the executor's remit (unchanged from plan §7)

- Agent OS review queue: reject or correct `cand-1r0sqqv3d9`, `cand-27b47fgzfp`, `cand-34mdd3zmg7` (superseded diagnosis).
- Phase 8 gate: extension live-copy + service restart + Phase 8b settings fix — only on explicit owner approval in-conversation.
