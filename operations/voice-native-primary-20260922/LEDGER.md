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
| P0 baseline + RED | **passed (G0)** | baseline `fa1eb393`; evidence commit `57efe420` | `phase0/PHASE0-RED.md` (+ raw logs), `ACCEPTANCE-MANIFEST.md` |
| P1 instrumentation | **passed (G1)** — merged `301331d1` | branch removed | `children/L/`; `/root/voice-lane-lab/parent-verification/` |
| P2 native primary surface | **passed (G2)** — C `5fa309a9` + J `c50eca93`; parent-run journey attempt-14 pass | branches removed | `children/{C,J}/` |
| P3 relay/approval fidelity | **passed (G3)** — H `8f27fd98`; journeys audit the full chain | branch removed | `children/H/` |
| P4 pilot + fix loop | **passed (G4)** — 11 passes; **pass 10 + pass 11 clean 12/12**; freeze at `f7c43bc9` | freeze `fix-loop/freeze.json` + `FREEZE.md` | `fix-loop/pass-10/`, `pass-11/` |
| P5 comparison + verdict | **running (W4)** | frozen `f7c43bc9` | campaign ledger (to be created) |

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
| 2026-09-23 02:49 | W3 | J2 `goal_end` (achieved) at `1c159ca3`; **parent verification**: voice-live-lab 608, compile 0; director `pendingCandidate` consumed on wait entry with strict grading and amend invalidation preserved; verifier clause-level negation awareness. **J2 merged `933b706f`**, lease released, worktree + branch removed. | `coordination/J2/complete.md` |
| 2026-09-23 02:57 | W3 | Post-correction integration (`20eb75f1`): deadlines bumped (25/15/20/20 s), four timing tests now derive from episode data, 15 pre-existing lint errors cleared (**repo lint 0 errors**), C15 fixture reconciled with the new slot. phase1 144 / voice-live-lab 608 green; **full server suite 461 files / 5714 tests green** (one transient 2-test failure on a first run did not reproduce — monitor at the freeze gate). | `/root/voice-lane-lab/parent-verification/post-correction-server-suite.log` |
| 2026-09-23 02:57 | W3 | **Fix-loop pass 2 launched** (12 P-tier episodes, standard arm, `bg_bc65df93`). | `/root/voice-lane-lab/fix-loop/pass-2/` |
| 2026-09-23 03:07 | W3 | **Pass 2 result: 3 pass (C09/C15/C17) / 9 fail — INVALIDATED as current-code evidence.** Diagnosis: the journey runner built only when a dist was MISSING, so it served `client/dist` from 22:17 and `server/dist` from 20:06 — H2's host read-back and prompt hardening were never in the served bundle (C01/C03/C05/C18/C19/C20 still stalled at presentation; C21's forbidden proposal persisted). C17 passed only via the model's stochastic read-back. | `fix-loop/pass-2/`; attempt manifests (`clientBuildSha256 cd092dd1…`) |
| 2026-09-23 03:12 | W3 | **Harness defect fixed by the conductor (`d23cbac5`)**: the runner now rebuilds via the root build whenever any source/manifest is newer than the older dist (shared → server → client); pure staleness predicate + unit tests. voice-live-lab 612 green; compile 0. | `scripts/voice-lane-lab/lib/built-app.ts`, `journey-run.ts`, `built-app-freshness.test.ts` |
| 2026-09-23 03:12 | W3 | **Fix-loop pass 3 launched** (`bg_f750d169`) — first true run against the current code (fresh build enforced). | `/root/voice-lane-lab/fix-loop/pass-3/` |
| 2026-09-23 03:26 | W3 | **Pass 3 result: 5 pass / 7 fail** (C09, C15, C16, C17, C21 pass — C16 negation and C21 prompt fixes confirmed in the served build). Boundary diagnosis: **source-binding transcription race** — `relay_tool_call_refused {reason:"unbound_source", candidateCount:0}` in C03/C19/C20 (and one repeat in C01) because the model's tool call lands before the operator's final transcript; **no TTS in journey Chromium** — client sends `proposal_presentation {completed:false}` (C01/C18), so presentation cannot complete; C05 model did not relay (variance); C14 response slot missed. | `fix-loop/pass-3/`; server-evidence jsonl; wire frames |
| 2026-09-23 03:28 | W3 | **Correction round 3 dispatched**: **H3** (`01a0cc4e-9210-…`, watch `ww_8`) bounded transcription-grace before `unbound_source`; **J3** (`01a0cc4e-95e1-…`, watch `ww_9`) labelled `--tts synthetic` journey seam with verifier byte-equality assertions. | briefs `children/{H3,J3}/` |
| 2026-09-23 03:51 | W3 | H3 `goal_end` (achieved) at `90cbb1ed`; **parent verification**: websocket+talker+voice 1296 passed, typecheck 0; design review passed (grace only on an empty window, generation-safe, duplicate re-checked after wait, ambiguity untouched, `relay_binding_waited` evidence). **H3 merged `ee32b5e0`**; lease released, watch `ww_8` cancelled, worktree + branch removed. J3 still running. | `coordination/H3/complete.md` |
| 2026-09-23 04:08 | W3 | J3 `goal_end` (achieved) at `f09aa3be`; **parent verification**: lab 633, compile 0, `--tts bogus` exit 2; shim uses defineProperty over the getter-only Window accessor (the first live confirmation run caught the plain-assignment no-op; fix proven in real Chromium provider-free); verifier enforces declaration, honest tts block, E2 level only, byte equality, attribution. **J3 merged `299276b1`**; lease released, watch `ww_9` cancelled, worktree + branch removed. | `coordination/J3/complete.md` |
| 2026-09-23 04:12 | W3 | **Fix-loop pass 4 launched** (`bg_89145ea9`) — first run with both corrections and the labelled `--tts synthetic` seam; the first episode rebuilds (H3's server change is newer than the dists). No children, worktrees or leases remain. | `/root/voice-lane-lab/fix-loop/pass-4/` |
| 2026-09-23 04:21 | W3 | **Pass 4 result: 4 clean (C01, C03, C17, C19) / 8 not** — the binding grace and read-back seam worked (candidate + presentation complete + approval in C01/C03/C19; C17 too). Remaining, boundary-labelled: **C20** presentation observed during a speak phase not consumed (lab: presentation persistence); **C16/C21** verifier flags declared-seam + zero-speech proposalless runs as incomplete (lab edge); **C09/C14/C15** over-tight deterministic word slots on open conversation (lab: `openResponse` design per plan §5.3); **C05** confirm wording outside the closed vocabulary (conductor data fix `d9baaa9d`: "Yes, send it."); **C18** amendment acknowledged but never re-relayed (prompt hardening). | `fix-loop/pass-4/` |
| 2026-09-23 04:22 | W3 | **Correction child K dispatched** (`01a0cc7f-bb75-…`, watch `ww_10`) covering the pass-4 lab semantics + C18 prompt hardening. C05 data fix committed (`d9baaa9d`). | brief `children/K/` |
| 2026-09-23 04:51 | W3 | K `goal_end` (achieved) at `cada56f8`; **parent verification**: lab 647 + voice 261 = **908 passed**, compile 0, typecheck clean; design review passed (pendingPresentation mirrors the candidate fix with revised-candidate clearing; openResponse exclusivity in the schema; seam completeness only for proposalless runs; C18 exact live example + false-cancellation prohibition). **K merged `71e739dd`**. | `coordination/K/complete.md` |
| 2026-09-23 04:57 | W3 | Data follow-through: **C09/C14/C15 `openResponse: true`** (`4e1fa3e9`) and the two verifier boundary tests re-pinned with a required-words corpus clone (`51604ee4`); lab 647 green. K lease released, watch `ww_10` cancelled, worktree + branch removed — no children remain. | `git log` |
| 2026-09-23 04:58 | W3 | **Fix-loop pass 5 launched** (`bg_9e828e06`) — all 12 P-tier episodes with every correction in the served build. | `/root/voice-lane-lab/fix-loop/pass-5/` |
| 2026-09-23 05:08 | W3 | **Pass 5 result: 9 clean / 3 not** (C01, C03, C09, C14, C15, C16, C17, C19, C20). Remaining: **C05** the operator HEARD THE OLD SENTENCE — the fixture manifest is keyed by fixture id, so the audio still said "Yes, send that exactly as written."; **C18** the model relayed only the restriction clause ("Do not deploy anything…"), losing the deploy instruction; **C21** still carried a required word (missed in the openResponse round). | `fix-loop/pass-5/`; C05 attempt-05 operator_utterance text |
| 2026-09-23 05:25 | W3 | **Conductor corrections (`d53a0a2d`)**: C05-t2 **re-frozen for both voices** against the corrected wording (WER 0, requiredWords yes|send) with `journeyPlan` now **failing closed on fixture text drift**; the C18 amendment bullet names the FULL corrected instruction (with the pass-5 failure quoted); **C21 joins openResponse**. Lab 909 passed; compile 0; lint 0 errors. | `scripts/voice-lane-lab/corpus/voices/*.json`; `journey-plan.ts`; `voice-session.ts` |
| 2026-09-23 05:26 | W3 | **Fix-loop pass 6 launched** (`bg_8ffe47aa`) — verification of the pass-5 corrections. | `/root/voice-lane-lab/fix-loop/pass-6/` |
| 2026-09-23 05:35 | W3 | **Pass 7: 11/12** (only C18: its confirm "Yes, send the amended version." is outside the closed confirmation vocabulary → statement → no release). The new fixture text-drift guard also exposed pre-existing drift: C05-t1 (both voices) and C17-t1 (voice-a) were re-frozen (WER 0); C18-t3 re-frozen after the wording fix to "Yes, send it.". | `fix-loop/pass-7/`; `regen-fixtures.mts` |
| 2026-09-23 05:50 | W3 | **Pass 8: 11/12** (C18 passes; C01 flaked: the operator's confirm landed in the talker audio window and was dropped as `talker_audio_window` echo-suspect). Fix: confirm turns now wait for **talker quiescence** (lab egress counter quiet 1.2 s, bounded 8 s) before speaking. | `fix-loop/pass-8/`; `journey-run.ts` |
| 2026-09-23 06:00 | W3 | **Pass 9: 10/12** (C16 honest answer lacked the literal slot word → openResponse; C18 relayed only the correction clause → **state-aware correction hint** added to the relay tool response, plus the full-instruction prompt rule). | `fix-loop/pass-9/` |
| 2026-09-23 06:05 | W3 | **Pass 10: 12/12 CLEAN.** | `fix-loop/pass-10/` |
| 2026-09-23 06:10 | W3 | **Pass 11: 12/12 CLEAN — two consecutive clean full passes. GATE G4 ACHIEVED.** Both arms reachable (P's real probes); measured cost far inside §10 (~90 min live journeys total). | `fix-loop/pass-11/` |
| 2026-09-23 06:15 | W3 | **Freeze recorded at `f7c43bc9`** (corpus, voice manifests, prompt, scorer, runner hashes) in `fix-loop/freeze.json` + `FREEZE.md`. | `fix-loop/FREEZE.md` |
| 2026-09-23 06:18 | W4 | **L4 harness child dispatched** (`01a0ccea-8c88-…`, watch `ww_11`): soak runner (10 min, ≥8 turns, mid-session reconnect, pending-work survival), busy-parking support, attachment-switch support; holdout-overlay mechanism added by steer (`corpus/holdout/<ID>.validator.json` merged for holdout cells; corpus files stay empty). | brief `children/L4/` |
| 2026-09-23 06:22 | W4 | **Validator overlays authored** for C10 (token discussion) and C11 (self-correction replaces the candidate, completed with a confirm turn for runnability). | `corpus/holdout/C10/C11.validator.json` |
| 2026-09-23 08:07 | W4 | **L4 merged (`2ed17321`)**: overlays, soak runner, parking/attachment mechanisms (lab 688, compile 0, lint 0 errors); one real soak run recorded honestly as FAIL (16.7 min + real reconnect proven; 6/8 turns, pending work unresolved — L5 closing). | `coordination/L4/` |
| 2026-09-23 08:08 | W4 | **L5 dispatched** (`01a0cd4e-d532-…`, watch `ww_12`) for the remaining seams: soak debug to a passing real run, worker-busy drive (C22), two-session prep (C24). **C22/C24 validator overlays authored** (promote/confirm; switch) and **all holdout fixtures frozen** (C10/C11/C22/C24, both voices, WER 0) after instrument fixes: compound join ("back off"→"backoff") and the missing tens in the number fold; C22's systematically misheard "auth" replaced with "sign-in module". Drift scan: zero mismatches. Commit `8c4ed67e`. | `corpus/holdout/*.validator.json`; `fixtures.ts` |
| 2026-09-23 08:35 | W4 | Campaign runner script prepared (paired by ID, arm order alternated per ID with recorded seed, one heavy runner): `/root/voice-lane-lab/campaigns/native-primary-20260922/run-campaign.sh`. The full 34-cell window opens after L5 lands (its real runs must not overlap the campaign). | script path above |
| 2026-09-23 10:36 | W4 | **L5 handback + two conductor questions.** Delivered (commits `b144f8e7`, `6acfa0cc`, `88dd4f4a`, `8c617288`): busy-drive hold hardening, collapse diagnostics, C24 switch-aware director tail + multi-page wire-evidence union, C22/C24 seams + holdout voice fixtures; 702 tests green, tsc clean, lint 0 errors. Blockers: (Q1) worker provider cannot complete a turn; (Q2) no switch retirement frame. | `coordination/L5/{complete.md,01-questions.md}` |
| 2026-09-23 10:40 | W4 | **Conductor grounded both blockers in code and answered** (`02-conductor-answers.md`). Q1 root cause: the child server DOES inherit env (`run()` merges `process.env`) but `boot-disposable-server.sh` points `PI_CODING_AGENT_DIR` at a fresh empty dir, so the worker's `kimi-coding` provider has no auth store entry (host `~/.pi/agent/auth.json` has it) → ~1 s empty turns. Authorised: seed the isolated agent dir from the host auth store (mode 600, honest when absent) + unit test, then +1 real C22 run and +1 real soak run. Q2: keep C24's check unchanged; the picker switch (`handleSwitchLane`→`beginLaneReplace`→`replaceVoiceLane`) never re-registers the lane, so the product path never fires — a product child (M) owns it; the campaign's own C24 cells are the confirmation run. | `coordination/L5/02-conductor-answers.md` |
| 2026-09-23 11:16 | W4 | **M verified + MERGED** (`e3e9e0b5`): the picker's worker switch now sends `voice_session_stop {reason: worker_switch}` at the picker commit (client) and the mount resolves the live proposal on that stop (server, `proposal_resolved {replaced}` before the session closes) — contract §3.2. Conductor verification: diff reviewed; server ws+voice 647/647 and client C24 suites 48/48 re-run; **RED independently reproduced at the parent commit** (server: no frame + stale confirm accepted; client: missing method + wiring); the "85 pre-existing client failures" claim corroborated at baseline. Merged-tree typecheck/build/lint all exit 0. | `coordination/M/complete.md` |
| 2026-09-23 11:20 | W4 | **L5 reconciled: C22 CLOSED with a real PASS** (`C22-standard/attempt-09`: parking_updated → promoted → presented → confirmed → released → delivered → worker store; verifier pass, director replay 40/40). Its fixes: auth-store seeding of the isolated agent dir (`b7a08e1c`), a worker model that completes in the disposable env (`0c9da7bb`, `73abe2bf`), 40 s busy hold (`c326639e`). **Soak attempt-02 = honest FAIL with a NEW product finding**: reconnect v2 revived the lane in ~3.6 s and the provider transcribed post-revive speech, but the server-side kernel emitted ZERO utterance events → confirm never released (kernel utterance pipeline does not re-bind after a same-lane provider restart). | `coordination/L5/complete.md` |
| 2026-09-23 11:25 | W4 | **L5 verified + MERGED** (`a8ccf2ed`); conductor re-ran its gates (lab 705/705, voice-lab tsc 0, typecheck 0). Merge resolution: the manifests needed care — L5's branch predated the holdout freeze and carried only C22/C24 fixtures (C10/C11 absent; C22-t1 stale wording). Root cause of the freeze gap: the regen script only *updated* existing ids and silently skipped absent ones. Script fixed to append; **all nine holdout turns frozen for both voices** (`9eaaf891`; 49 fixtures each, zero drift, ASR green). The obsolete voice-a C22-t1 homophone skip removed (`e8724669`) — the wording fix removed the homophone, so the fixture now exists for both voices. Stray `.bak` files dropped (`fe5f7231`). | `corpus/voices/*.manifest.json` |
| 2026-09-23 12:05 | W4 | **M2 verified + MERGED** (`958d9370`): utterance finalisation now also runs on the host `speech_end` boundary (`voice-session.ts`, 11 lines) — the client-VAD boundary that survives a same-lane restart — so a revived session's transcripts finalise and reach the kernel even when the provider never sends its turn boundary; idempotent when the provider boundary does arrive; gate untouched. Conductor verification: ws+voice 652/652 re-run; **RED independently reproduced at the parent** (1 failed | 3 passed, "expected 1 to be 2" — exactly the recorded symptom); merged-tree typecheck/build/lint all exit 0. | `coordination/M2/complete.md` |
| 2026-09-23 12:15 | W4 | **Campaign chunk 1 (C01, C03, C05, C09 × both arms): C09 PASS, six cells FAIL — CAMPAIGN HALTED for diagnosis.** Failures were all "deadline exceeded waiting for delivery/candidate". Diagnosis from `C01-standard/attempt-28` evidence: `delivery_attempt` t+17.4 s → worker busy t+18.0 s → **no `delivery_receipt` ever**. Root cause: the Pi delivery adapter awaits `MultiSessionManager.prompt()/steer()`, which await the WHOLE worker turn (`multi-session-manager.ts:1500`); the mount emits `receipt_event` only after that settles. The fix loop never hit this because worker sessions had no provider credentials and their turns failed in ~1 s — L5's (correct) auth seeding made workers genuinely run, so every receipt now waits out a full turn. The contract (§4.4/§4.6: *bytes delivered*; chime fires on `delivered`) makes this a product defect, not a harness deadline problem. | `C01-standard/attempt-28` evidence; contract §4.4 |
| 2026-09-23 13:00 | W4 | **M3 verified + MERGED** (`fcef1718`): receipts now resolve at SUBMISSION — new `submitPrompt`/`submitSteer` on the manager (existing `prompt()`/`steer()` semantics pinned unchanged), Pi adapter returns `delivered`/`prompt` at turn start for an idle worker, `delivered`/`steer` when a steer joins a running turn, **`queued`/`steer`** when it cannot, refusals/`unknown` unchanged; mount passes the adapter's mechanism through instead of hardcoding `follow_up`. Conductor verification: 112 files / 1750 tests green re-run; **RED independently reproduced at the parent** (`manager.submitPrompt/submitSteer is not a function`); merged-tree typecheck/build/lint all exit 0. | `coordination/M3/complete.md` |
| 2026-09-23 13:05 | W4 | **Six halted cells re-run: standard 3/3 PASS, et-high 3/3 FAIL — second confound found and diagnosed.** C01/C03/C05 standard now pass (the receipt fix worked). Every et-high cell fails the same way: `operator_utterance_echo_suspect {reason: 'talker_audio_window'}` → `relay_binding_waited {arrived: false}` → `relay_tool_call_refused {unbound_source, candidateCount: 0}`. The et-high model speaks early (12.47 s), the operator's final transcript lands at 14.87 s inside the talker's audio window, the guard discards it, so the relay has no binding candidate. Standard has ZERO echo-suspect events; every et-high cell has 1–2. Without a fix the et-high arm would measure the guard, not the model. | `C01/C03/C05-et-high` attempts |
| 2026-09-23 14:02 | W4 | **M4 verified + MERGED** (`9987ebb1`): the echo guard now consults the operator's own speech window (`voice_activity_state`) — a final whose completed window ended before any talker output was in the room is accepted as genuine (`operator_utterance_late_final_accepted`), while overlap/unknown stays conservatively suppressed; content backstop stays armed; gate untouched. Conductor verification: 46 files / 658 tests green re-run; **RED independently reproduced at the parent** (5 failures, M4's exact assertions); tree integrity checked after its disclosed stash incident (zero net change; the other task's stash untouched); merged-tree typecheck/build/lint all exit 0. | `coordination/M4/complete.md` |
| 2026-09-23 14:10 | W4 | **et-high re-run: failure mode moved from 'waiting for candidate' to 'waiting for release'** — M4's fix works (t1 accepted at 10.8 s, proposal at 13.4 s), but the **confirm** is dropped as echo. Root cause localised from the egress record: talker audio ran 11.90–13.07 s and then went silent; the director spoke the confirm at 14.6 s; the talker's *transcript* final at 14.2 s had armed `talkerAudioUntilMs` (+1 s) because line 1514 arms the window on **both** `audio_out` and talker transcripts — so the operator's speech window was flagged `overlappedTalkerAudio` by text alone and suppressed at 21.9 s. Echo is acoustic: only playing audio can be picked up by the mic. | `C01-et-high/attempt-03` |
| 2026-09-23 14:45 | W4 | **M5 verified + MERGED** (`9b4fa18d`): the echo window is now armed by talker **audio** only (the transcript-arming false positive is gone; no fallback needed — M5 proved every engine path emits `audio_out` before anything is audible). Conductor verification: 46 files / 661 tests green; **RED reproduced at the parent** (3 failures). | `coordination/M5/complete.md` |
| 2026-09-23 14:50 | W4 | **et-high re-run still failed at 'waiting for release'; conductor harness fix (conductor-owned, `bb61cc1f`).** The et-high model emits whole **text turns with no audio** (C01-et-high/attempt-04: talker transcripts 17.7–25.1 s, zero egress chunks 12.4–34.1 s), so the egress-only quiescence counter said "quiet" while the model was mid-turn. New `talker-quiescence.ts` counts the talker's **text + audio** (inbound transcript deltas, audio frames, egress chunks) with a 2 s quiet window and a 25 s bound; lab tests 709/709, tsc 0, lint 0. | `scripts/voice-lane-lab/lib/talker-quiescence.ts` |
| 2026-09-23 15:45 | W4 | **Campaign complete on revision `5fc3f1bb`: 34 cells run, 29 pass.** Harness/product fixes merged along the way: M5 (`9b4fa18d`, echo window armed by audio), the conductor's talker-**text** quiescence (`bb61cc1f`), the C24 switch tail + verifier ack retirement (`79c0daed`, `5fc3f1bb`). Index: `campaign/CAMPAIGN-INDEX.json`. Failures, all diagnosed: C05-et-high (flaky: 1 pass of 3 — the chatty model talks over the confirm), C11-standard (the amendment "Actually no — …" is classified `cancel`, cancelling the amendment's own proposal — a product finding), C24-et-high (the model never produced the first candidate in either attempt), SOAK ×2 (post-reconnect repeat relay produced no candidate within the deadline; the duration/turn bars then failed on the early termination). | `campaign/CAMPAIGN-INDEX.json`, `campaign-summary.txt` |
| 2026-09-23 16:06 | W4 | **Evaluator pass complete and folded in.** 10 blinded packs graded with the frozen prompt (hash verified; packs carry no arm labels): **7 pass, 2 fail, 1 indeterminate**. Findings: **C21 fails Q1 in BOTH arms** — the operator's "check the version number before anything" precondition is never addressed (the reply substitutes monitoring talk); **C16-et-high indeterminate** — the reply promises a check and the record ends before the answer. Per the plan an evaluator fail/indeterminate is never an auto-pass, so C21 (both) and C16-et-high are **not accepted**; the verdict's matrix and discordant-pair table were updated accordingly (standard 14/17, ET 12/17; discordant pairs 3:1 for standard). | `coordination/EV/`; `campaign/VERDICT.md` |
| 2026-09-23 15:51 | W4 | **Evaluator + reviewer dispatched in parallel.** EV (`01a0cef7-1a11-…`, watch `ww_19`): the frozen prompt (`EVALUATOR-PROMPT-v1.md`, sha256 `7f5d09f6…`) over 10 blinded packs (`/root/voice-lane-lab/evaluator/packs/`), forbidden from reading the arm mapping → `coordination/EV/{evaluator.json,report.md}`. RV (`01a0cef7-49aa-…`, worktree `wt-voice-rv`, watch `ww_20`): read-only falsification of all 34 cells (manifest integrity, offline `verify`, arm identity, holdout leakage, accounting, blinding) → `coordination/RV/review.{md,json}`. | `children/RV/brief.md` |
| 2026-09-23 15:05 | W4 | **Campaign under revision `bb61cc1f`: 11 of 12 cells pass** (C01, C03, C09, C14–C17 × both arms; C05 standard). **C05 et-high is FLAKY** — pass (attempt-06), fail 'waiting for candidate' (attempt-07), fail 'waiting for release' (attempt-05): the chatty et-high model keeps talking over the operator's confirm, so the echo guard suppresses it. All attempts stay in the record; the flakiness is a finding, not a hidden retry. | `campaign-summary.txt` |
| 2026-09-23 14:13 | W4 | **Child M5 dispatched** (session `01a0ce9c-ca8c-…`, worktree `wt-voice-m5`, branch `task/voice-native-m5`, lease `49bd1c70…`, watch `ww_18`): arm the echo window from audio, not text (or a strictly weaker fallback only for a proven transcript-without-audio engine path); keep the first check, M4's speech-window decision against the audio-armed window, the content backstop and the gate unchanged. RED-first; et-high cells re-run after it lands. | brief `children/M5/` |
| 2026-09-23 13:11 | W4 | **Child M4 dispatched** (session `01a0ce64-ddc7-…`, worktree `wt-voice-m4`, branch `task/voice-native-m4`, lease `0907388c…`, watch `ww_17`): make the echo guard principled — `talker_audio_window` may suppress only when the operator's own speech window (client `voice_activity_state`, already handled by the mount) overlaps the talker's audio; a late final whose speech ended before the talker began is genuine gate input; unknown window keeps today's conservative suppression; `operator_speech_active` + content-overlap backstop unchanged; gate untouched. RED-first; the et-high cells re-run after it lands. | brief `children/M4/` |
| 2026-09-23 12:21 | W4 | **Child M3 dispatched** (session `01a0ce36-5eb3-…`, worktree `wt-voice-m3`, branch `task/voice-native-m3`, lease `1a7424af…`, watch `ww_16`): receipt at submission — idle worker → `delivered`/`prompt` once the turn has started, busy worker → `queued`/`steer`, refusals still refused, `unknown` unchanged; prefer a submission-shaped manager method over weakening `prompt()`/`steer()` for existing callers. RED-first; no heavy harness runs. The campaign stays halted until it lands, then the failed cells are re-run and the remaining cells follow. | brief `children/M3/` |
| 2026-09-23 12:10 | W4 | **Campaign window opens.** All three product/harness fixes are on master (`e3e9e0b5` M, `a8ccf2ed` L5, `958d9370` M2); holdout freeze complete; 34 required cells to run foreground in chunks (background cap saturated with un-reapable terminal tasks). | master `958d9370` |
| 2026-09-23 11:27 | W4 | **Child M2 dispatched** (session `01a0ce05-110f-…`, worktree `wt-voice-m2`, branch `task/voice-native-m2`, lease `45087040…`, watch `ww_15`): product fix for the soak seam — the kernel utterance pipeline must re-bind after a same-lane capture-mode restart; RED-first mount/kernel repro; NO-TOUCH L5's lab paths. The campaign's soak cells become the end-to-end confirmation. | brief `children/M2/` |
| 2026-09-23 10:41 | W4 | **Child M dispatched** (product fix, session `01a0cddb-1612-…`, worktree `wt-voice-m`, branch `task/voice-native-m`, lease `9b1b21a7…`, watch `ww_14`): RED-first repro + minimal contract-correct fix so a worker switch resolves the live proposal with a delivered `proposal_resolved {replaced|cancelled}` frame; no heavy harness runs; NO-TOUCH L5's paths. | brief `children/M/` |
| 2026-09-23 08:30 | W4 | **L5 round 1 FAILED — hang, nothing on disk.** L5 stalled mid-turn for ~30 min (goal `failed`, no commits, no edits, no handback; ~50 min of reconnaissance lost). Recovered: abort (idle), then a **new tighter goal on the same session** (`349ca0c3`, running) ordered C22 → C24 → soak, with the soak seam diagnosis included (startLane no-ops on stale-live wireState), incremental commits and a ~30-min per-seam stop rule. | `goal_end` record; new goal receipt |

### W4 plan (Phase 5, opening)

1. **Holdout validator (parent):** author + freeze the 4 holdout surface forms (C10/C11/C22/C24), synthesise/validate their fixtures for both voices, and record the freeze. The implementer lineage never saw this wording.
2. **Cost the matrix** from measured per-episode spend (11 passes ≈ 90 min live journeys, ~7–10 min/pass; provider usage small) — comfortably inside §10; run the full §8 matrix.
3. **Campaign:** 34 required cells — 12 core × 2 arms, 4 holdout × 2 arms, 2×10-min soak — one heavy runner, paired by episode ID, alternating arm order with recorded seed. Cells run via `primary-mic --episode <id> --arm <standard|et-high>` (campaign runner's live mode is conductor-gated by design; the soak needs a driver — check/extend).
4. **Evaluator pass** for open-response episodes (C09/C14/C15/C16/C21 + holdout conversation), fixed rubric, blinded to arm labels.
5. **Independent reviewer child** (read-only): manifests, accounting, model identity, no hint leakage, offline re-verification of every cell.
6. **Verdict + repository gates + canonical docs + Agent OS capture.**

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
