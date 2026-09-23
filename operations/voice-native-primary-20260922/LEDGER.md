# Voice Mode native-primary + autonomous validation — execution ledger and strategy

> **Class:** conductor's execution ledger — strategy, live checkpoint and progression record for
> [`docs/plans/VOICE-MODE-NATIVE-PRIMARY-AND-AUTONOMOUS-VALIDATION-PLAN.md`](../../docs/plans/VOICE-MODE-NATIVE-PRIMARY-AND-AUTONOMOUS-VALIDATION-PLAN.md)
> (scaled-down revision, 2026-09-22, baseline `a97ca060`). The **plan is the contract**; this
> ledger is the execution organisation and record. Where this ledger and the plan disagree, the
> plan wins and the ledger is amended.
> **Status:** `EXECUTING` — owner activated the conductor's goal engine 2026-09-22 (goal
> running); **Q1 answered: merge authority GRANTED** (feature/docs merges to `master` + push;
> production deploy/restart remains separately gated); **Q2 answered: plan §10 ceilings
> confirmed** (fix loop ≤US$8/20 live episodes; campaign ≤US$12; hard all-in US$25; 8 h live
> wall-clock; real bounded Gemini Live calls from disposable servers).
> **Rule of this file:** current state, not a completion claim — read before acting. Sections 1–10
> are stable strategy (amend in place with dated amendments). §11 (owner questions), §12
> (progression), §13 (decisions) are live and updated as execution proceeds.
> **Conductor session:** `01a0caac-7dbe-73fd-809a-f3eb3c6b0b6b` (pi CLI, cwd `/root/pi-web-ui`).
> Board id `pi-01a0caac`. Bare-CLI pi ⇒ primary wake path is `watch_wake_register` (in-process),
> backstop `wake_deadline` (model-free).
> **Companions (do not override):** the plan above; [Voice Mode index](../../docs/VOICE-MODE-INDEX.md);
> [intent](../../docs/VOICE-MODE-INTENT.md); [architecture of record](../../docs/VOICE-MODE-ARCHITECTURE-RECOMMENDATION-2026-09.md);
> prior programme ledger `docs/VOICE-MODE-EXECUTION-LEDGER.md` (historical evidence, not a competing plan).

---

## 1. Mission, scope and hard boundaries

Execute the plan end-to-end as a conductor: children implement in isolated worktrees via the
Internal API; the conductor plans, dispatches, independently verifies every gate, merges accepted
waves, runs the fix loop and the frozen comparison, and alone signs off an honest terminal verdict.
The owner is not required to operate, listen to, or judge routine acceptance.

**Hard boundaries (do not soften):**

| Boundary | Rule |
|---|---|
| Production | No deploy, restart, reconfigure or validation against production. `pi-web-ui.service` is untouched. |
| Real-session prompting | No prompting the operator's real sessions; all workers disposable and owned. |
| Publication | No publishing reports, recordings or evidence; no external business actions. |
| Owner-only decisions | Anything irreversible, outward-facing, or beyond plan §10 ceilings stops and asks. |
| Audio host | No shared audio/routing changes; PulseAudio `doctor` runs read-only once; `E3 unavailable` is an acceptable recorded outcome. |
| Approval semantics | Never widen the talker confirm gate's reachability or add arm-specific privileges. |
| Contract | Frozen v1 wire semantics change additively or not at all (versioned + migration tests otherwise). |
| Arms | Exactly two: standard Live and ET-HIGH. No third arm, no automatic reasoning escalation, no Live-as-conductor implementation. |

**Owner gates (in-conversation, apply until relaxed):** (a) merging accepted feature branches into
`master` + push — requested confirmation pending §11 Q1; production deploy/restart remains separately
gated regardless; (b) anything that would exceed plan §10 budget ceilings; (c) any authority question
the plan names as owner-only.

---

## 2. Baseline snapshot — verified 2026-09-22 at planning time

Re-derive these in Phase 0; source code outranks this table.

| Fact | Value / evidence |
|---|---|
| Master baseline | `a97ca060` (= `origin/master`; clean tree except another agent's untracked `server/tests/unit/pi-ai/frontier-models.test.ts`) |
| Internal API | Contract **1.44.0**; `watchGenerationPreconditions` advertised; `piProviderPolicy.blockedProviders = []`; pi supports goal+steer+queue-while-busy |
| Capacity (preflight) | 1/16 active turns, executionCapacity 14, memory headroom ~14.6 GB, pid pressure false |
| Board collisions | Another lineage active in `/root/pi-web-ui`: `pi-01a0caad` working on `server/tests/unit/pi-ai/frontier-models.test.ts` (+ frontier model policy). **Collision boundary: that path and `server/src/pi-ai/**` are NO-TOUCH for my children.** Re-check at every wave boundary. |
| Provider quota | `zai` **ample** (5h 98% left; resets 21:17Z; TIME_LIMIT resets 2026-09-26); GLM peak window **inactive**; `command-code` normal (monthly credit 11% left); codex 27%/46%; antigravity Gemini-group 3% weekly (avoid); claude usage read HTTP 429. |
| Owner route | Children: **GLM-5.3 Flash, `pi` runtime, `zai` provider**, `high` default / `max` for hard TDD/refactor. Live catalogue confirms selector `zai/glm-5.3-flash`, levels `["low","high","max"]`. |
| Health tooling | `watch_wake_register`, `wake_deadline`, `bg_run`, `subagent`, `goal` loaded; `scripts/notify.sh` exists; no worktrees present. |
| Known plan defects to RED in Phase 0 | (1) punctuation-free relay strip (`server/src/talker/relay-normalise.ts`); (2) original-wording fallback (`voice-live-mount.ts` / `proposal-store.ts`); (3) append-not-replace (`appendToDraft`); (4) async source binding; (5) casual-yes classification. |

---

## 3. Strategy — the two modes, and the waves

**Mode 1 (the main event): fix loop.** Dev corpus through the **real built application** and the
**real browser capture path** (Chromium file-backed fake mic, primary controls). Observe → diagnose
by boundary → fix (RED→GREEN) → re-run affected episodes + family neighbours. Exit only on **two
consecutive clean full dev-set passes** or a named §10 blocked outcome.

**Mode 2: one small frozen comparison.** Only when the dev set is repeatedly clean: freeze
code/prompt/corpus/scorer, then run the §8 matrix (24 core + 8 holdout + 2 soaks) paired by ID,
standard vs ET-HIGH, and write the preregistered verdict (§12 of the plan).

**Wave plan** (sequence derived from dependency; children map to it — never the reverse):

| Wave | Owner | Contents | Gate |
|---|---|---|---|
| **W0** | conductor | Phase 0: baseline recheck vs source (§2 drift), RED reproductions of the five defect classes, acceptance manifest, machinery verification (watch/deadline/goal/quota), collision re-check, ledger + STATE live | **G0** |
| **W1** | 3 children, parallel, disjoint paths | **L** lab/QA = Phase 1 (built-app capture driving, immutable records, corpus+director, offline verifier, negative controls, scripts-inclusive compile check); **C** client = Phase 2 (main controls → native engine, fallback states, preservation); **H** host = Phase 3 server half (source binding, original retention, replacement, identity invalidation, read-back prep) | **G1** (L), **G2** (C), **G3** (H) — conductor-verified on frozen commits |
| **W2** | conductor merges W1; 2 children, parallel | **P** provider = Phase 4 §7 (typed profile boundary, standard vs ET-HIGH, real bounded capability probe); **J** journey = primary-mic browser journey + E2 attempt records + campaign runner (builds on L+C) | **G4a** (P), **G2b** (J); merged-tree gates green |
| **W3** | conductor-led fix loop; correction children dispatched **bounded** (≤2 concurrent) to owning tracks | Phase 4: dev set through built app; measure per-episode cost/time; iterate; real orchestration-through-worker control; freeze | **G4** (dev set clean ×2; both arms reachable; cost fits) |
| **W4** | conductor runs campaign; 1 read-only reviewer child | Phase 5: §8 matrix, preserve failures, independent reviewer re-checks manifests/accounting/identity/hint-leakage + re-runs offline verification; repository gates; verdict; canonical docs | **G5** + terminal verdict |

Parallelism rule: a child wave opens only where owned paths are disjoint. During W3/W4 only **one
heavy browser/audio runner** exists at a time (conductor-owned). Cap concurrent correction children at 2.

**Phase-gate table** (updated during execution; statuses `not started / running / passed / failed / indeterminate`):

| Phase | Status | Commit/build identity | Evidence pointer |
|---|---|---|---|
| P0 baseline + RED | **passed (G0)** | baseline `fa1eb393`; evidence commit `57efe420` | `phase0/PHASE0-RED.md` (+ raw logs), `ACCEPTANCE-MANIFEST.md` |
| P1 instrumentation | **passed (G1)** — merged `301331d1` | branch `task/voice-native-lab` (removed) | `children/L/`; handback `/root/voice-native-20260922/coordination/L/`; parent verification logs `/root/voice-lane-lab/parent-verification/` |
| P2 native primary surface | **passed (G2)** — C `5fa309a9` + J `c50eca93`; parent-run real journey attempt-14 pass | branches removed | `children/{C,J}/`; journey evidence `/root/voice-lane-lab/campaigns/primary-mic-journeys/` |
| P3 relay/approval fidelity | **passed (G3)** — H `8f27fd98`; journey director replay (71 steps) + approval identity in records | branch removed | `children/H/`; PHASE0 seeds green |
| P4 pilot + fix loop | **running** (parent-led dev-set pass 1) | master `c50eca93` | `/root/voice-lane-lab/fix-loop/pass-1/` |
| P4 pilot + fix loop | not started | — | — |
| P5 comparison + verdict | not started | — | — |

---

## 4. Workstreams, ownership and worktrees

One writer per worktree; paths disjoint by construction. Worktrees created as their wave opens,
removed after merge/cleanup. Children **never** push, merge, or edit another track's paths; only the
conductor merges/pushes. External coordination + handback files live outside every worktree and
outside the repo at `/root/voice-native-20260922/coordination/<child>/`.

| Child | Wave | Worktree · branch | Owned paths | NO-TOUCH (explicit exclusions) |
|---|---|---|---|---|
| **L** lab/QA | W1 | `/root/pi-web-ui-wt-voice-lab` · `task/voice-native-lab` | `scripts/voice-lane-lab/**`, `scripts/voice-live-lab/**` (adapt only), `scripts/audio-lab/**` (only if doctor-gated), corpus under `scripts/voice-lane-lab/corpus/**`, lab tests under `server/tests/voice-live-lab/**` or scoped nearest equivalent | `server/src/**`, `client/src/**`, `shared/src/**`, `server/tests/unit/pi-ai/**` |
| **C** client | W1 | `/root/pi-web-ui-wt-voice-client` · `task/voice-native-client` | `client/src/components/DriveMode/**`, `client/src/hooks/useDictation.ts`, `useDriveModeDictation.ts`, `useVoiceLiveLane.ts`, `useVoiceTurn.ts`, `client/src/lib/voiceLive/**`, their client tests | `server/**`, `scripts/**`, `shared/src/**`, `server/tests/unit/pi-ai/**`; shared needs go via handback request |
| **H** host/talker | W1 | `/root/pi-web-ui-wt-voice-host` · `task/voice-native-host` | `server/src/talker/**`, `server/tests/unit/talker/**` | `server/src/voice/**` (wave 2 P), `client/**`, `scripts/**`, `server/tests/unit/pi-ai/**`; cross-boundary edits (routes/websocket) via handback request |
| **P** provider | W2 | `/root/pi-web-ui-wt-voice-provider` · `task/voice-native-provider` | `server/src/voice/**`, `server/tests/unit/voice/**`, probe script path within `scripts/voice-live-lab/**` **only if L's tree is merged and scope agreed in the brief** | `server/src/talker/**` (H), `client/**`, `server/tests/unit/pi-ai/**` |
| **J** journey/runner | W2 | `/root/pi-web-ui-wt-voice-journey` · `task/voice-native-journey` | `scripts/voice-lane-lab/**` (continuation of L after merge), `tests/e2e/**` voice specs + configs, campaign runner under `scripts/voice-lane-lab/**` | `server/src/**`, `client/src/**`, `server/tests/unit/pi-ai/**` |
| **R** reviewer | W4 | `/root/pi-web-ui-wt-voice-review` · `task/voice-native-review` (read-only: no edits, no commits) | none | everything (verification commands only) |

Conductor-owned paths (not delegated): `operations/voice-native-primary-20260922/**`, `docs/**`
(final amendments + verdict), `shared/src/**` (applied on request), wave merges.

**Worktree isolation recipe v2 (proven, mandatory):** create the worktree; isolate **root**
`node_modules` and **nested** `server/node_modules`, `client/node_modules`, `shared/node_modules`
(real copy or per-worktree install), build `shared` locally, and probe a nested import
(`server/node_modules/zod` version + `@pi-web-ui/shared` resolution) before dispatch. The earlier
one-off gate failure in the 2026-09-17 programme was caused by missing nested entries — do not
repeat it. Smoke-test the worktree (`npm run typecheck` scoped) before any child starts.

---

## 5. Routing and delegation discipline

- **Primary child route (owner instruction):** `pi` runtime · selector **`zai/glm-5.3-flash`** ·
  `high` default, **`max`** for genuinely hard TDD/refactor/metric work. Verify via `/info` +
  run receipt `servedModel`; record the matched metadata with each dispatch.
- **GLM peak window:** Mon–Fri 07:00–11:00 Europe/London — during it, GLM work moves to the
  sanctioned commandcode twin (`commandcode/z-ai/glm-5.3-flash`, levels include `high`/`max`).
  Outside the window the twin is used **only if the measured zai pool is constrained/exhausted**.
- **Fallback ladder when GLM unavailable/constrained:** commandcode twin → Gemini 3.8 Flash
  (`antigravity` `gemini-3.8-flash-medium`/`-high`, only if its group has headroom — currently 3%
  weekly, so effectively last) → `commandcode/google/gemini-3.8-flash`. Never openrouter (metered),
  never retired models, never clinepass/opencode-go (dashboard-only — owner personal use).
- **Re-discovery before EVERY dispatch:** fresh `/models` + `agent-os provider-usage` +
  `/capacity`; save the preflight snapshot to `operations/.../children/<child>/preflight-<ts>.json`.
  A planning-time snapshot is already historical.
- **Judge/evaluator model:** the separate evaluator pass (plan §5.3) runs on `zai/glm-5.3-flash`
  `high` (different vendor from the Gemini Live subjects, so no self-scoring); rubric + prompt hash
  frozen before the campaign; blinded to arm labels.
- **The conductor itself** stays on its current session model; children are GLM per owner direction.

---

## 6. Zero-token waiting protocol (no polling, ever)

**Parent = bare-CLI pi** ⇒ a server-side `onFire` cannot deliver here. Per waiting window:

1. **Primary wake (before dispatch):** `watch_wake_register` on each child session with conditions:
   - `goal_end` + `dataMatch {objective: "<exact dispatched objective>"}` (once:false to survive
     reused-session old-goal clears; identity reconciled on every wake);
   - `goal_state` paused + same objective filter (child stopped to ask);
   - `text` sentinel `PARENT-INPUT-NEEDED` (named in every brief), `once:true`.
   `max_wakes`: 6 per child. Never add a per-turn `agent_end` condition to goal children.
   Register **before** dispatch; one watch per child session (re-registration replaces).
2. **Backstop (one per window, model-free):** `wake_deadline` sized to the expected window (default
   45–60 min; soaks/small campaign steps sized from measured per-episode cost) with message
   "reconcile all owned children; expiry is not completion". If `wake_deadline` is absent/suspect,
   rung-1 fallback `bg_run sleep` + `backstop_s`. Record the returned id.
3. **Park:** `goal {action:"pause", reason:"supervising <children>"}`; end the turn. Never exit via
   `Status: NEEDS_USER_INPUT` for supervision.
4. **On wake:** reconcile **every** owned child (receipts, goal state, handback files, watch
   ledger), not only the named one; treat handback files as gates, not completion (completion =
   terminal run/goal state + frozen commit + handback). Re-arm only for remaining windows; cancel
   the exact settled deadline id.
5. **Resume** the conductor goal only when the waiting work is fully settled (no re-dispatch
   pending, no open questions, no outstanding watches). Busy graceful pause may report
   `wrapping_up` — that is requested, not applied; read back honestly.
6. **Command-shaped work** (suites, builds, lab runs, soaks) uses `bg_run` + completion wake —
   never a child session as a timer.
7. **Telegram**: start, each gate completion, material blockers/question, final verdict; verify
   delivery (never report "notified" from a 202).

---

## 7. Child dispatch and handback recipe

For each child, atomically: **worktree → route verify → create session with retention + goal →
verify binding → register watch → detached dispatch → record**.

1. Worktree per §4 recipe; baseline `master` at the wave's frozen commit.
2. Live preflight snapshot (§5) saved.
3. `POST /sessions` (`X-Parent-Session` header): `runtime:"pi"`, `model:"zai/glm-5.3-flash"`,
   `thinkingLevel:"high"` (or `max`, recorded with justification), `cwd:<worktree>`,
   `retention:{mode:"durable", ttlSeconds:43200, ownerId:"voice-native-20260922-<track>"}`,
   `goal:{objective:<frozen outcome text>, maxTurns: <bounded>}`.
4. Read back `/info` + goal state; trust `resolvedModel`/`modelBinding`/receipt `servedModel`,
   never the create echo.
5. `watch_wake_register` (§6.1).
6. Detached dispatch: `POST /sessions/:id/prompt {message: <brief>, verbosity:"answers", detach:true}`;
   persist `runId`.
7. Brief contains: outcome (what must be true), evidence that settles it, owned paths + explicit
   negative exclusions, invariants that must not be softened, TDD requirement (RED first, paste RED
   output), exact gate commands, worktree/route/session id, board declaration command
   (`agent-os board quick-declare ... --path ... --exclude ... --join-session <SID>`), handback
   format (`FROZEN` marker + changed-path inventory + exact commands/exit statuses + honest gaps),
   question protocol (write `NN-questions.md` / `NN-blocked.md` in the coordination dir and **end
   the turn**; ask only above the §6 bar), and the **mandatory `agent-os-child` skill mandate**.
8. Handback path: `/root/voice-native-20260922/coordination/<child>/NN-complete.md`; conductor
   copies accepted handbacks into `operations/voice-native-primary-20260922/children/<child>/`.
9. On acceptance or rejection: cancel watch (generation-safe where advertised), release the exact
   retention lease (matching `ownerId`), leave the board entry, remove worktree/branch only after
   the work is merged or explicitly abandoned; preserve superseded handbacks (rename, never overwrite).

---

## 8. Verification and acceptance discipline

- **Never trust a handback.** The conductor independently re-runs each gate command on the frozen
  commit in the child's worktree, and writes its own probe for every claimed behaviour.
- **Anti-cheat per claim:** browser capture must be real `getUserMedia` through the primary
  controls (no fixture bypass); provider calls real (not fixture/mocked) on the measured path;
  rendered-graph claims from real instrumentation; ducking not unit-mocked; no transcript injection
  on E2 paths. Labelled E0 negative controls are the only place hooks may bypass production paths.
- RED evidence required for every claimed defect reproduction; no speculative hardening briefs.
- Defects return as **exactly one bounded correction brief per review round** to the owning track.
- Accepted waves freeze; conductor commits before opening new scope.
- **No agent self-certifies its own scorer** — the campaign scorer is verified by the independent
  reviewer on injected damaged records before it grades; evaluator separate from implementer.
- Independent reviewer (fresh read-only child) at W4; conductor alone signs off.
- Repository gates at each merge and at G5: `docs:check-agent-guides`, `docs:check-links`,
  `docs:check-status` (after Voice Mode docs), `lint`, lint ratchet, `typecheck`, `build`, relevant
  suites, scripts-inclusive strict check; exact exits recorded.
- `E2/E2R` scoped software pass only; E3 recorded unavailable if `doctor` fails; E4 never claimed.

---

## 9. Budget, limits and the adapt rule

| Item | Ceiling |
|---|---|
| Fix loop (P4) | ≤20 live-provider episode-equivalents, ≤US$8 |
| Comparison campaign (P5) | §8 matrix, ≤US$12 |
| All-in hard ceiling | **US$25** (all paid services), **8 h live wall-clock** across loop+campaign |
| Infra retries | ≤2 per cell, ≤6 replacements programme-wide; two same-mechanism failures ⇒ diagnose |
| Heavy runners | one browser/audio runner at a time |
| Audio | `doctor` once; if `capture:chain` fails → record `E3 unavailable`, continue E2/E2R |
| Disposables | `validate:server --compiled` on dynamic ports, owned `mkdtemp` paths; teardown via `scripts/validation-server-stop.mjs` + process/listener checks |

Adapt rule: after the pilot, cost the remaining matrix from measured per-episode spend; if over
ceiling, run priority core + holdout only, record the extend tier as not run. Spend ledger lives in
§12 (dated rates, per-cell usage, running total). Stop an arm on any authority breach or severe
fidelity breach; preserve completed cells, report disqualification.

---

## 10. Acceptance manifest (frozen before the campaign; plan §6/§8 are authoritative)

Local executable form written in Phase 0 (`ACCEPTANCE-MANIFEST.md` + machine-readable corpus/schedule
under the private lab root). Summary:

- Cells per arm: 12 P-core (once each) + 4 holdout + 1×10-min soak (≥8 turns, one mid-session voice
  reconnect) = 17 timed cells/arm; optional extend (≤12) and noise spot-check (2) only if budget
  remains.
- KPIs (plan §6.1): input-path integrity 100%; authority safety **zero** violations; delivery
  identity 100%; intent fidelity zero critical meaning errors / ≤1 first-pass miss per arm; conversation
  separation zero unwanted proposals on C09/C14/C15+holdout; correction behaviour 100%
  replaced-not-concatenated; approval efficiency one read-back + one confirmation; speech honesty zero
  unsupported claims; latency p50 ≤2 s / p95 ≤4 s / no unanswered turn >8 s (report, never exclude
  timeouts); cost/lifecycle complete accounting + verified teardown.
- Decision rule (plan §12): exclude unsafe → apply fidelity gates → one arm qualifies ⇒ recommend it;
  both qualify ⇒ default standard unless ET wins a majority of discordant pairs with no safety/
  fidelity/latency regression (else **tie**); none ⇒ `NO_CANDIDATE_MEETS_TARGET`. Terminal statuses:
  `AUTOMATED_SOFTWARE_ACCEPTED` / `NO_CANDIDATE_MEETS_TARGET` / `INDETERMINATE_OR_BLOCKED` /
  `DEPLOYMENT_PENDING_OWNER` (never used to obscure failure). Verdict explicitly states production
  not deployed.

---

## 11. Owner questions — answered 2026-09-22 (goal activation message)

| # | Question | Answer |
|---|---|---|
| Q1 | **Merge authority.** May the conductor merge accepted lanes into `master` and push (feature merges only, docs included)? Production deploy/restart stays separately gated. | **GRANTED — “You may merge.”** Merge accepted, independently verified lanes; production remains untouched. |
| Q2 | **Budget confirmation.** Plan §10 ceilings and real bounded Gemini Live calls? | **CONFIRMED — “I confirm plan.”** Proceed inside §10; stop and ask if measured spend approaches 80% of any ceiling. |

Everything else — parallelisation shape, correction cycles, holdout construction, evaluator model,
cleanup — is conductor-autonomous under this strategy and the plan's boundaries.

---

## 12. Progression log (live — updated at every wake/fan-in)

_(empty — execution not started; owner goal activation is the start signal)_

| Date/time (UTC) | Wave | Action | Outcome / evidence |
|---|---|---|---|
| 2026-09-22 20:05 | — | Ledger authored from plan + board + quota + repo reconnaissance | `READY, NOT STARTED`; awaiting owner goal activation |
| 2026-09-22 ~20:20 | W0 | Owner activated goal engine; Q1 merge granted, Q2 plan confirmed; ledger/STATE updated | `EXECUTING`; Phase 0 begins |
| 2026-09-22 21:09 | W0 | Phase 0 RED probe run at baseline `fa1eb393`: 4 defects confirmed (punctuation-free strip, correction accumulation, original-wording loss, async source binding); casual-yes already green | `phase0/PHASE0-RED.md`, raw logs; commit `57efe420` |
| 2026-09-22 21:10 | W0 | Acceptance manifest frozen; three worktrees created from `57efe420` with nested-node_modules isolation verified (zod 3.25.76; 49/49 smoke) | `ACCEPTANCE-MANIFEST.md`; `git worktree list` |
| 2026-09-22 21:12 | W1 | Children L/C/H created goal-armed on `zai/glm-5.3-flash` high; binding verified; watches `ww_1`/`ww_2`/`ww_3` registered BEFORE dispatch; briefs delivered as `follow_up` | sessions `01a0caf6-943c-…` (L), `01a0caf6-9844-…` (C), `01a0caf6-9c9f-…` (H); leases `ee53d6a8…`, `5377dcd6…`, `4687bf27…` |
| 2026-09-22 21:57 | W1 | Child H `goal_end` (achieved); handback FROZEN (`coordination/H/complete.md` + evidence). All three children reconciled: L and C still running. Backstop deadline fired (time-up, not failure) | H commits `2da74aae` + `1cd88013`; tree clean |
| 2026-09-22 21:59 | W1 | **H independently verified** on the frozen commit: scoped suite 57 files/900 passed; typecheck exit 0; lint 0 errors (311 warnings); **parent probe 12/12 green** (the Phase 0 seeds, written before H started). Boundary amendment **accepted**: two integration test files under `tests/unit/voice/**` adapted to corrected semantics (assertions strengthened; M6 gained a refusal check) | gate logs in session; H evidence files |
| 2026-09-22 22:02 | W1 | **H merged to master (`8f27fd98`) and pushed**; docs-link defect fixed first (`5d16dbb5`); lease released, watch `ww_3` cancelled, worktree + branch removed. Post-merge full server suite launched in background (`bg_e5f17332`) | `git log`; `wake_deadline` re-armed `deadline-86220e10…` for the L+C window |
| 2026-09-22 22:01 | W1 | **Post-merge full server suite GREEN**: `env -u PI_MAX_SESSIONS -u OPENCODE_ENABLED npm test --workspace=server` → exit 0, **446 files / 5520 tests passed** on `59558aa9` | `/root/voice-lane-lab/w1-postmerge-server-suite.log` |
| 2026-09-22 22:13 | W1 | Child C `goal_end` (achieved); handback FROZEN (`coordination/C/complete.md`); L still running. C verified independently on frozen `a190ed87`: scoped client suite 381 passed, client build exit 0, typecheck exit 0; **anti-cheat sound** (new suite drives the real VoiceLiveSurface over fake browser factories, asserts `voice_session_start` on the wire, capture goes live, and the cascade is NOT engaged) | C RED evidence verbatim in handback; parent re-ran gates |
| 2026-09-22 22:16 | W1 | **C merged to master (`5fa309a9`) and pushed**; lease released, watch `ww_2` cancelled, worktree + branch removed. Post-merge client suite + typecheck + build launched in background (`bg_f1aab31a`) | `git log` |
| 2026-09-22 22:17 | W1 | **Post-merge client gates GREEN** on `f920543e`: client suite **145 files / 1639 tests**, typecheck exit 0, client build exit 0 | `/root/voice-lane-lab/w1-postmerge-client-{suite,typecheck,client-build}.log` |
| 2026-09-23 00:35 | W1 | Child L `goal_end` (achieved); handback FROZEN at `91323cbb`. **Parent verification**: phase1 87, voice-live-lab 551, lane-lab 14, scripts compile check 0; **parent-reproduced real built-app capture proof attempt-10** (ingress 111 / egress 132 / 0 page errors); verify pass(0); parent damage probes fail closed (raw exit 2 both). Holdouts confirmed empty. | `/root/voice-lane-lab/parent-verification/**`; `coordination/L/complete.md` |
| 2026-09-23 00:41 | W1 | **L merged to master (`301331d1`) and pushed**; lease released, watch `ww_1` cancelled, worktree + branch removed — no worktrees remain. **WAVE 1 COMPLETE** (H `8f27fd98`, C `5fa309a9`, L `301331d1`). Merged-tree gates green: phase1 87 / voice-live-lab 551 / lane-lab 14 / compile check 0; post-merge server 5520 and client 1639 green earlier. | `git log`; gate logs |
| 2026-09-23 00:42 | W2 | W2 briefs committed (`df9f9590`); worktrees created (provider, journey) with node_modules isolation; preflight green (zai 78% off-peak; capacity 1/16). Children created goal-armed on `zai/glm-5.3-flash` high; watches `ww_4`/`ww_5` registered BEFORE brief delivery; briefs delivered as `follow_up`; both confirmed busy/running | P `01a0cbb6-f85a-…` lease `94637b2a…` run `4ffa8ead…`; J `01a0cbb6-fc3c-…` lease `73063c95…` run `e146d889…` |
| 2026-09-23 01:34 | W2 | Child P `goal_end` (achieved); handback FROZEN at `b2631a76`. **Parent verification**: voice suite 257 passed, typecheck 0, eslint 0; **both real arm probes re-run by the parent** — standard: setup 337 ms, transcript 100%, model `gemini-3.8-live`; et-high: setup 389 ms, 100%, `gemini-3.8-live-extended-thinking` + `thinkingConfig HIGH`; redacted configs + usage ack recorded. SILENT-override refusal adjudicated as a legitimate boundary-tightening (profile owns reply shape). | `/root/voice-lane-lab/parent-verification/p-probe-*.txt`; `coordination/P/complete.md` |
| 2026-09-23 01:39 | W2 | **P merged to master (`cf003f13`) and pushed**; lease released, watch `ww_4` cancelled, worktree + branch removed. Post-merge voice suite 257 green. J still running (HEAD advanced to `e3ea7694`). | `git log` |
| 2026-09-23 02:04 | W2 | Child J `goal_end` (achieved); handback FROZEN at `d80de263`. **Parent verification**: voice-live-lab 597 passed, compile check 0, campaign dry index **54 cells** (core 24 / validator-gated holdout 8 / soak 2 / extend 16 / noise 4), credential-missing exit 2, holdout dry-run exit 2; **parent-run real journey attempt-14: pass** (727 ingress / 366 egress chunks, 1110 artifacts hash-verified, 71 director steps replayed, cleanup verified). | `/root/voice-lane-lab/parent-verification/journey-C01-parent.log`; `coordination/J/complete.md` |
| 2026-09-23 02:12 | W2 | **J merged to master (`c50eca93`) and pushed**; lease released, watch `ww_5` cancelled, worktree + branch removed — no worktrees remain. **WAVE 2 COMPLETE** (P `cf003f13`, J `c50eca93`). Post-merge gates green (voice 257 / voice-live-lab 597 / compile 0). | `git log` |
| 2026-09-23 02:13 | W3 | Fix loop pass 1 launched (parent-led): 12 P-tier episodes on the standard arm through the real built app, background task, one heavy runner. | `/root/voice-lane-lab/fix-loop/pass-1/` |
| 2026-09-23 02:19 | W3 | **Pass 1 result: 1 pass (C09) / 11 fail**, all with verified capture/director-replay/cleanup. Boundary diagnosis complete (presentation read-back ×4; amendment re-relay; doubt/qualification proposal; candidate persistence; tight deadlines; negation-blind slots; C05 corpus frame). | `fix-loop/PASS-1-DIAGNOSIS.md`; raw logs `/root/voice-lane-lab/fix-loop/pass-1/` |
| 2026-09-23 02:22 | W3 | Correction round dispatched: **H2** (`01a0cc12-…`, watch `ww_6`) host read-back + routing prompt; **J2** (`01a0cc13-…`, watch `ww_7`) director persistence + verifier negation awareness; conductor fixed corpus data (`99b9e273`: C05 frame, C15/C16 slots). Deadline bump deferred until the correction children merge (timing tests hard-code values). | briefs `children/{H2,J2}/`; commit `99b9e273` |
| 2026-09-23 02:44 | W3 | H2 `goal_end` (achieved) at `7964ed35`; **parent verification**: client 230, build 0, typecheck 0, server voice/websocket/talker 1292; changed-file eslint 0; the 15 repo lint errors confirmed **pre-existing at master** (J2-owned phase1 tests, to be cleared with the deadline-bump commit). Design review passed (explicit arming, single-flight, honest unsupported path). | `coordination/H2/complete.md` |
| 2026-09-23 02:50 | W3 | **H2 merged to master (`195012a6`) and pushed**; lease released, watch `ww_6` cancelled, worktree + branch removed. Post-merge gates green. J2 running (HEAD `1c159ca3`). | `git log` |

### Wave 2 dispatch record (2026-09-23 00:43Z)

| Child | Session id | Worktree · branch | Lease (ownerId) | Watch | Brief runId (follow_up) |
|---|---|---|---|---|---|
| P provider | `01a0cbb6-f85a-73f0-b149-c1240fbef407` | `/root/pi-web-ui-wt-voice-provider` · `task/voice-native-provider` | `94637b2a-a5df-4d6a-b164-0f724ca52c5e` (`voice-native-20260922-provider`) | `ww_4_1790124169013` | `4ffa8ead-c2ee-4a26-a2d7-832e77297df5` |
| J journey | `01a0cbb6-fc3c-73f0-b149-c12630857a5f` | `/root/pi-web-ui-wt-voice-journey` · `task/voice-native-journey` | `73063c95-4f9e-4dac-930d-e9f438f9c359` (`voice-native-20260922-journey`) | `ww_5_1790124169077` | `e146d889-28b7-41f6-bbde-796ac21b9292` |

### Wave 1 dispatch record (2026-09-22 21:12Z)

| Child | Session id | Worktree · branch | Lease (ownerId) | Watch | Brief runId (follow_up) |
|---|---|---|---|---|---|
| L lab | `01a0caf6-943c-73f0-b149-c1154832eb5d` | `/root/pi-web-ui-wt-voice-lab` · `task/voice-native-lab` | `ee53d6a8-dd20-478c-9d83-1a109c2ee1e0` (`voice-native-20260922-lab`) | `ww_1_1790111565332` | `a5b222bc-7473-4823-a0eb-07f203f5b300` |
| C client | `01a0caf6-9844-73f0-b149-c1177fcd57a2` | `/root/pi-web-ui-wt-voice-client` · `task/voice-native-client` | `5377dcd6-a992-4ee9-a980-11a5b8ee63d9` (`voice-native-20260922-client`) | `ww_2_1790111565360` | `896d8e9c-bca6-45ed-ae5b-d716de61c57f` |
| H host | `01a0caf6-9c9f-73f0-b149-c118b03a5f7d` | `/root/pi-web-ui-wt-voice-host` · `task/voice-native-host` | `4687bf27-a4d7-412e-b3a5-93a425894f39` (`voice-native-20260922-host`) | `ww_3_1790111565415` | `e45bded5-9b5d-4707-8395-16fbf622e0a0` |

Preflight snapshot: `children/preflight-model-zai-*.json`, `children/preflight-capacity-*.json`, `children/preflight-provider-usage-*.txt`.

**Spend ledger:** 0 entries; running total US$0.00 / 8 h live.

---

## 13. Decisions log

| # | Date | Decision | Source |
|---|---|---|---|
| D-01 | 2026-09-22 | Children GLM-5.3 Flash `high`/`max` on `zai`/`pi`; fallbacks per routing policy §5 | Owner instruction in conversation |
| D-02 | 2026-09-22 | Goal-armed children + detached dispatch + `watch_wake_register` primary + `wake_deadline` backstop; conductor goal paused while idle | Owner instruction + orchestration skills |
| D-03 | 2026-09-22 | Wave model: W0 parent → W1 L/C/H parallel → W2 P/J parallel → W3 fix loop (bounded corrections) → W4 campaign + read-only reviewer | This ledger §3 |
| D-04 | 2026-09-22 | Merge into `master` only on Q1 grant; production never | Plan §0 + in-conversation gate |
| D-05 | 2026-09-22 | Private evidence root `/root/voice-lane-lab/campaigns/<campaign-id>/` (outside git) with sanitised summaries in `operations/voice-native-primary-20260922/`; coordination at `/root/voice-native-20260922/coordination/` | Plan §9 + multi-phase practice |
| D-06 | 2026-09-22 | Owner answers: **Q1 merge authority granted** (“You may merge”); **Q2 plan confirmed** (ceilings and live calls approved) | Owner goal-activation message |

---

## 14. Evidence, privacy, cleanup

- Immutable per-attempt records as plan §9 specifies (manifest with all hashes, fixture/captured
  digests, revisions, tool-call provenance, byte-level proposal/presentation/delivery identity,
  approval identity, receipts, worker store, usage, screenshots, status/reason codes, verified
  cleanup). Campaign index lists every scheduled cell including never-started/skipped/failed.
- Raw audio, profiles, credentials, unredacted transcripts stay outside Git; repo carries only
  sanitised corpus text, code, metadata and summaries after inspection. No publication without
  owner approval. Exit codes retained (`pipefail`, no `| tail`): 0 complete scoped pass, 1
  demonstrated failure, 2 incomplete/invalid proof.
- Cleanup after each wave: watches cancelled, leases released (exact ids), board entries left,
  worktrees/branches removed after merge; final sweep for owned processes/listeners/children.
