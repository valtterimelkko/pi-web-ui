# Voice Mode — multi-agent execution ledger (live)

> **Class:** conductor's live execution ledger — strategy, checkpoint and progression
> record for the multi-agent execution of
> [`VOICE-MODE-EXECUTION-PLAN.md`](./VOICE-MODE-EXECUTION-PLAN.md).
> **Status:** Waves 0–3 COMPLETE and merged (contract, kernel, audit, bridge, client,
> regression, mount, rollout, server/client corrections, receipt UI). **Gate 5 re-proven
> through the corrected code** (`2900997`, loophole found by the independent verifier and
> closed in `b9e7fb4`). **PRODUCTION IS DEPLOYED** (`b9e7fb4`, contract 1.44.0, live engine
> enabled) under the owner's 2026-09-18 authorisation for their Phase 7 real-ear test;
> rollback = `VOICE_MODE_ENGINE=cascade` + restart. CI green on master. No other production
> change is authorised — a further restart needs the owner.
> See §12 for the live progression log.
> **Rule of this file:** current state, not a completion claim — read before acting.
> **Owner start signal:** received 2026-09-17 (goal engine activated); owner decisions in §11.
>
> **Companions** (do not override them): the execution plan (authoritative plan and
> gates), [`VOICE-MODE-INTENT.md`](./VOICE-MODE-INTENT.md) (intent, N1–N9) and
> [`VOICE-MODE-ARCHITECTURE-RECOMMENDATION-2026-09.md`](./VOICE-MODE-ARCHITECTURE-RECOMMENDATION-2026-09.md)
> (architecture of record, D1–D7; where plan and recommendation differ on
> sequencing, the recommendation governs the decision and the plan governs
> execution).
>
> Conductor session: `01a0b0ef-ab27-7359-867b-6aa4a17a6d11` (pi CLI, cwd
> `/root/pi-web-ui`). Last updated: 2026-09-18 (production deployed for the owner's Phase 7
> test; CI green on master; independent verification of the Gate-5 harness completed and its
> finding closed).

---

## 1. Mission, scope and hard boundaries

Execute Phases 0–8 of the execution plan **end-to-end** as a conductor: children
implement in isolated worktrees via the Internal API; the conductor plans,
dispatches, independently verifies every gate, merges, cleans up and reports.

**Hard boundaries (do not soften):**

| Boundary | Rule |
|---|---|
| Production | No restart, deploy, reconfiguration or production validation of `pi-web-ui.service` without an explicit, in-conversation owner approval. Phase 8 *activation* is owner-gated; only its implementation runs here. |
| Phase 7 | Real-ear acceptance is the operator's alone. No agent self-sign-off. The conductor prepares the disposable slice and steps back. |
| Gate 7/second-opinion | A child's `goal_end`/verdict is never acceptance. The conductor independently re-runs every exit-gate command and writes its own probes. |
| N1–N9 | No child may widen the confirmation gate's reachability, add a send path, or move authority from code into the prompt. D6's standing instruction applies: no speculative escalation machinery. |
| Repos | Children commit only to their own worktree branch. No child pushes, merges, or edits another track's paths. Conductor alone merges/pushes. |
| Evidence | No mocks masquerading as live runs; no hard-coded report literals; a suite with 0 executed tests or skips fails the gate. Anti-cheat rules of the plan §2 apply to every phase. |
| Secrets | `GEMINI_API_KEY` stays server-side; never in a client bundle, log, commit or child prompt. |

**Interpretation of "no execution yet":** planning artefacts (this ledger, briefs)
may be written; worktrees, dispatches, edits and merges wait for the goal-engine
start signal.

---

## 2. Role split

| Conductor (this session) | Children (Internal API sessions) |
|---|---|
| Worktrees, briefs, board registration, dispatches | Implement their bounded outcome under TDD inside their own worktree |
| Watch registration, backstops, wake reconciliation, steering | Write their own red/green evidence; commit to their branch |
| Independent gate verification (re-run commands + own probes) | Never merge, never push, never self-sign-off, never touch production |
| Merges, cleanup, ledgers/index updates, Telegram milestones | Hand back: `complete.md` + changed-path inventory + evidence logs |
| Correction briefs (`parent-review-NN`) when a gate fails | One bounded correction per round; same owned paths |
| Owner reporting / Phase 7 handover | Stop and ask via the handback protocol when blocked |

---

## 3. Verified ground truth (conductor's pre-planning baseline, 2026-09-17)

Established directly, not from memory:

1. **Repo:** `pi-web-ui` master = `f46d5b1`, clean tree, in sync with
   `origin/master`. Only worktree: `/root/pi-web-ui` (master).
2. **Phase 0 appears already delivered** — by the prior lineage (board entries
   `pi-01a0b022`/`pi-01a0af87`): agent-benchmarks `678724b`/`d551ff9` (report
   derived from manifests; published claims corrected; `site/` removed) and
   pi-web-ui voice-docs spine commits. A conductor-observed run of
   `node generate_reports.mjs --test-manifest-audit` exits 0 and reports
   `Verdict: not measured`. **Treat as unverified until Gate 0 is re-run** (§7).
3. **Phase 1 defect reproduced by the conductor** (`classifyOperatorUtterance`):
   `"not sure"` → `confirm`; `"sure, but wait"` → `confirm`;
   `"yes, hold phase three"` → `confirm`; `"yes"` → `confirm`;
   `"I am not sure"` → `statement`; `"I said yes earlier"` → `statement`;
   `"why did you say yes"` → `question`. The defect is live; Phase 1 is real work.
4. **Live catalogue** (pi runtime): `deepseek-v4.1-flash` resolves through four
   providers — `commandcode/deepseek/deepseek-v4.1-flash` (low/high/max),
   `opencode-go/deepseek-v4.1-flash` (off/high/max),
   `clinepass/cline-pass/deepseek-v4.1-flash` (high only),
   `openrouter/deepseek/deepseek-v4.1-flash` (off…high). Quota snapshot in
   Appendix A. **Routing conflict flagged** — see OQ-1/OQ-2 (§11).
5. **`GEMINI_API_KEY` is present** in the server environment (value never read);
   Phase 3's live handshake and Phase 5's slice can run real provider calls,
   subject to OQ-4.
6. **Lab tooling exists and is the base to productise:** `scripts/voice-live-lab/`
   (cli commands: verify, handshake, baseline/tier1/tier2/tier3 dryrun+run, freeze;
   `lib/providers/gemini-live.ts`, `lib/harness/tier2-lean.ts`), but **no
   `test-vertical-slice` command and no `server/src/voice/`** yet — those are
   Wave-1/2 deliverables.
7. **No other live agents** on `/root/pi-web-ui` or `/root/agent-benchmarks` (board
   check). Collision boundary is currently clear; re-check at every wave boundary.
8. **Health tooling available:** `watch_wake_register` / `wake_deadline` / `bg_run` /
   `subagent` / `goal` tools are loaded in this session; `scripts/notify.sh`
   exists; Internal API contract 1.44.0; `/capacity` healthy (0/16 turns, memory
   headroom 19 GB) at planning time.

---

## 4. Workstreams, ownership and worktrees

Follows the plan §3 (Tracks A–D) plus conductor-defined E (contract), F
(integration), G (regression) and H (rollout). One writer per worktree; paths
disjoint by construction. Worktrees are created as their wave opens (not all in
advance) and deleted after merge.

| Child | Wave | Worktree / branch | Owned paths | NO-TOUCH |
|---|---|---|---|---|
| **E** contract | 0 | `/root/pi-web-ui-wt-contract` · `feat/voice-contract` | `docs/plans/VOICE-LIVE-WIRE-CONTRACT.md` (new), `shared/src/types/voice-messages.ts` (new) | everything else |
| **A** kernel | 1 | `/root/pi-web-ui-track-a` · `feat/voice-kernel` | `server/src/talker/*` (types, policy-core, utterance-classifier, pending-proposal→proposal-store, thread-store, parking-lot, release-store), `server/tests/unit/talker/*` | `server/src/voice/*`, `shared/*`, `client/*` |
| **B** bridge | 1 | `/root/pi-web-ui-track-b` · `feat/voice-bridge` | `server/src/voice/*` (new), `server/tests/unit/voice/*` (new), `server/package.json` (only to add the `test:voice-handshake` script) | `server/src/talker/*`, `shared/*`, `client/*`, `server/src/websocket/*`, `server/src/index.ts` |
| **C** client | 1 | `/root/pi-web-ui-track-c` · `feat/voice-client` | `shared/src/types/voice-messages.ts` (from E), `client/src/lib/voiceWorklet/*` (new), `client/src/lib/speechArbiter.ts`, `client/src/lib/soundEffects.ts` (new), `client/src/components/DriveMode/{DriveModeVoiceLive,ProposalCard,ParkingLotDrawer}.tsx` (new), plus their tests | `server/*`, other `client/*` beyond those files |
| **D** audit | 1 | `/root/pi-web-ui-track-d` · `feat/voice-audit` + `/root/agent-benchmarks` direct | `docs/*` evidence annotations only if a Gate-0 gap is found, `server/tests/fixtures/fidelity-corpus.json` (new), `server/tests/regression/harness/*` (new, non-kernel scaffolding), `agent-benchmarks` Phase-0 paths | `server/src/*`, `client/*`, `shared/*` |
| **F** integration | 2 | `/root/pi-web-ui-wt-integration` · `feat/voice-integration` | `scripts/voice-live-lab/**` (new `test-vertical-slice` command + slice runner), `server/src/index.ts` / `server/src/websocket/*` mount wiring only, `operations/voice-live-20260917/**` evidence | track code once frozen |
| **G** regression | 2 | `/root/pi-web-ui-wt-regression` · `feat/voice-regression` | `server/tests/regression/**`, `server/tests/fixtures/fidelity-corpus.json` | `server/src/*` (tests only; a real defect becomes a correction brief to A, not a G edit) |
| **H** rollout | 3 | `/root/pi-web-ui-wt-rollout` · `feat/voice-rollout` | `server/src/config.ts` (flag), `server/src/talker/session-registry.ts` (fallback wiring), `server/src/diagnostics/*` metrics, their tests | everything else |
| **R** reviewer | 3 | read-only, no worktree | none | none |

`operations/voice-live-20260917/` (in the repo, conductor-owned) holds briefs,
preflight snapshots, handback copies, wake records and review records; it is
committed by the conductor at wave boundaries. External coordination/handback
files live at `/root/voice-exec-20260917/coordination/<child>/` — outside every
worktree and outside the repo, per the hand-back protocol.

---

## 5. Child routing and delegation discipline

Owner direction in-conversation: **DeepSeek v4.1 Flash children, always via the
`pi` runtime, spread across the model's providers to even out quota** —
**confirmed by the owner on 2026-09-17** (§11): rotation approved across
`commandcode`, `opencode-go` and `clinepass`; `openrouter` (metered) is not part
of the approved rotation.

### 5.1 Route table for this programme (final provider chosen at dispatch)

| Child class | Model | Runtime | Providers (rotation) | Thinking | Notes |
|---|---|---|---|---|---|
| Track implementation (A–D, F–H) | DeepSeek v4.1 Flash | `pi` | `commandcode`, `opencode-go`, `clinepass` (one child per pool per wave where quota allows) | `high` default; `max` for A's kernel and F's integration (both advertise max on their pool) | Exact live selector copied at dispatch; `clinepass` advertises `high` only — never route a `max` task there |
| Contract E | DeepSeek v4.1 Flash | `pi` | `commandcode` | `high` | Single bounded artefact |
| Reviewer R | GLM 5.3 Flash (independence: different model family) | `pi` | `zai` (`zai/glm-5.3-flash`) | `high` | Off-peak per window check; fallback Gemini 3.8 Flash (`antigravity`, medium) |
| Documented fallback if a deepseek pool is constrained/exhausted | GLM 5.3 Flash `zai` (off-peak) → Gemini 3.8 Flash `antigravity` medium → GLM twins on `commandcode` (peak window only) | — | — | per routing policy | **Never a silent substitution**: record the switch + reason in §12/§13, and update the receiving child brief explicitly |

### 5.2 Dispatch discipline (every dispatch, no exceptions)

1. Fresh `GET /capabilities`, `GET /capacity`, `GET /models` and
   `agent-os provider-usage` immediately before dispatch; pick the exact
   `selector` from the live response (never from memory or this file).
2. Record the preflight snapshot to
   `operations/voice-live-20260917/preflight/<child>.json` plus the route tuple,
   session id, retention lease id, watch identity and wake-delivery path.
3. Create the session atomically with `retention: durable` (ownerId
   `voice-exec-20260917-<child>`) and `goal` armed at creation; goal objective =
   the aim (outcome + evidence + record path + invariants), never a step list.
   *(Owner recommendation, 2026-09-17: children run under goals.)*
4. Register on the board: `agent-os board register --source dispatcher --name
   voice-live-<child> --harness pi --join-session <id> --parent pi-01a0b0ef
   --task "<one line>" --repo /root/pi-web-ui`; tell the child to declare on the
   board and to leave the board entry on completion; conductor leaves it on
   acceptance.
5. Arm the child watch **before** the first prompt (one watch per session;
   re-registration replaces ledgers — never refresh mid-flight).
6. Dispatch with `detach:true`, `verbosity:answers`, and an `idempotencyKey`;
   persist the `runId`.

### 5.3 What children may ask (calibration)

A child stops and asks only for: a contradiction/impossibility in its brief; a
scope or authority boundary; anything irreversible or touching real data; a
premise proven false. Everything else is engineering judgement — record it and
proceed. A child never edits outside its owned paths out of convenience; it asks.

### 5.4 Question/handback protocol (imposed in every brief)

- Blocking question: write `/root/voice-exec-20260917/coordination/<child>/NN-questions.md`,
  print `PARENT-INPUT-NEEDED` as a standalone line, **end the turn**. Never hold
  the turn open, never poll.
- Completion: commit on the child branch; write `NN-complete.md` (outcome,
  changed-path inventory, gate command + observed result, evidence locations,
  `FROZEN` marker); end the turn.
- Status/heartbeat file: `00-status.md`, rewritten freely — it is context read on
  wake, **never** a liveness or completion signal.

---

## 6. Wave plan and sequencing

Derived from the plan's dependency chain; parallel only where owned paths are
disjoint. Each wave ends with conductor gate verification, merge and cleanup
before the next wave's dispatches.

| Wave | Children (parallel) | Depends on | Gate(s) closed by the wave |
|---|---|---|---|
| **0** | E (contract) **+ A (kernel: plan Phases 1–2, pulled forward) + D (audit + Phase 6 assets, pulled forward)** | owner start signal; A and D verified to have no dependency on the contract | Contract conduction review; Gate 1 → 2 (A); Gate 0 + Phase 6 assets (D); merge accepted branches |
| **1** | B (bridge), C (client) | E merged (contract frozen) | Gate 3 (B), Gate 4 (C) |
| **2** | F (integration), G (regression) | Wave-1 merges: A+B+C in master (D's assets too) | Gate 5 (F), Gate 6 (G) |
| **3** | H (rollout implementation), R (read-only review), conductor final checks | Wave-2 merges | Gate 8 implementation + plan §2 anti-cheat review |
| **4** | Operator handover | all merged, checks green | Gate 7 preparation (disposable slice + runbook); Gate 7 itself = operator; Phase 8 activation = owner decision |

**Concurrency cap:** 4 implementation children maximum in a wave; if quota or
capacity is tight at dispatch time, split a wave into two dispatches rather than
substituting routes silently. Heavy validation (disposable servers) is
serialised: one at a time.

**Operational note (observed 2026-09-17):** children created with the goal armed
at creation **auto-start** their first goal turn immediately — dispatching a
prompt at them returns `SESSION_BUSY` and is unnecessary. Dispatch = create
(with `goal`) → read back the goal → watch. Child session ids, leases, board
entries and wake ids are recorded in the wave log (§12).

**Inter-wave un-gating is conductor-autonomous** (never an owner question): when
a wave's gates pass and master is clean, the next wave is dispatched immediately.

---

## 7. Gate verification (conductor-owned)

For every gate: re-run the plan's exact command on the child's branch/worktree
(or the merged tree), then run the conductor's own probe(s). Record command,
exit code and observed output in §12 and the evidence directory.

| Gate | Plan's command (conductor re-runs) | Conductor's independent probes (anti-cheat) |
|---|---|---|
| 0 | `node /root/agent-benchmarks/benchmarks/04-voice-live-lab/generate_reports.mjs --test-manifest-audit` | Empty-dir run reports 0 runs / `not measured`; grep reporting scripts for hard-coded verdicts; site files gone from git |
| 1 | `npm --prefix server test -- tests/unit/talker/utterance-classifier.test.ts tests/unit/talker/talker-gate.test.ts` then all `tests/unit/talker/` | Conductor's own utterance table (§3.3): `not sure`, `sure, but wait`, `yes, hold phase three` must never classify `confirm`; `yes`/`send it` must; ≥25 classifier tests actually executed (count in output) |
| 2 | `npm --prefix server test -- tests/unit/talker/four-objects.test.ts` | Mutation probe: disabling a guard must make the suite fail (proves tests test); thread→release negative path; duplicate-confirm no-op; SHA mismatch refusal |
| 3 | `npm --prefix server test -- tests/unit/voice/` + `npm --prefix server run test:voice-handshake` | Live handshake evidence carries real provider usage (no dry-run flags); key absent from any client bundle/build output; disconnect/resume unit tests present |
| 4 | `npm run build --workspace=shared && npm run build --workspace=client` + `npm --prefix client test -- src/lib/speechArbiter.test.ts` | Browser (Playwright) ducking check; proposal card shows presented vs stale; chime is local asset, not model-generated |
| 5 | `npx tsx scripts/voice-live-lab/cli.ts test-vertical-slice` | Log inspection: every worker-received instruction matches a released proposal id + SHA byte-for-byte; 3/3 scenarios real (no fixture stubs); disposable server only |
| 6 | `npm --prefix server test -- tests/regression/` | Suite <20 s; inject one violation (e.g. perturb a veto) and confirm the suite fails closed; 100% negation/conditional retention on the corpus |
| 7 | Operator only | Conductor prepares disposable slice + runbook; **no self-sign-off** |
| 8 | `npm run typecheck && npm run test` | Fallback drill on disposable server: kill Live bridge mid-session → cascade continues, drafts intact, audible announcement; metric fields present in `/diagnostics` |

---

## 8. Zero-token waiting protocol (this conductor is a bare-CLI Pi session)

**Primary wake (must exist per child):** `watch_wake_register` pointed at the
child — a local in-process extension that polls the durable watch ledger and
starts/steers *this* session. Server-side `onFire` is **not** the delivery path
here: this interactive CLI session is the runtime owner, so server-side prompts
would defer (`deferred-follow-up`) and never arrive.

Conditions per goal-armed child (per the goals reference):

```json
[
  { "type": "event_type", "eventType": "goal_end",
    "dataMatch": { "objective": "<exact dispatched objective>" }, "once": false },
  { "type": "event_type", "eventType": "goal_state",
    "dataMatch": { "objective": "<exact dispatched objective>", "status": "paused" }, "once": false },
  { "type": "text", "contains": "PARENT-INPUT-NEEDED", "once": false }
]
```

`max_wakes` sized to the genuine wake outcomes expected (4–6 per track child).
Never add a per-turn `agent_end` condition as belt-and-braces — it burns budget
with false wakes.

**Backstop (per waiting window, model-free):** `wake_deadline` armed for the wave
window (≈90 min; shorter re-arms for known-bounded steps), verified by reading
back id/status/`durable`. If `wake_deadline` is absent or suspect, use rung 1
`bg_run sleep <N>` with `backstop_s`; the rung-3 model dead-man only if both are
unavailable. Exactly one appropriate backstop per window; cancel the exact owned
handle when the window settles.

**Parent goal discipline:** before idling, `goal pause` with reason
`"supervising children"` (never the `Status: NEEDS_USER_INPUT` exit); while
paused, wake processing consumes no goal turns. Resume only when the window's
work is fully settled (all children terminal + reconciled + no outstanding
questions). *(Owner delegated autonomous management of this session's goal
engine, 2026-09-17: pause while watching/waiting, resume when settled, per the
orchestration and long-horizon waiting skills.)*

**On every wake (mandatory, regardless of which child fired):**

1. Reconcile **all** children: `GET /runs/:runId`, `GET /sessions/:id`,
   `GET /sessions/:id/goal`, `GET /sessions/:id/watch` (check `wakeAttempts[]`),
   handback/coordination files.
2. Identify what fired (sentinel vs deadline vs terminal) — a firing is not a
   verdict; a deadline is not failure.
3. Route the outcome: verify a finished child's gate; answer a question with a
   correction brief or decision; steer a stuck child; re-arm only if dependent
   work remains.
4. Update §12/§13 here before doing anything else when a decision is made.

**Notifications:** `scripts/notify.sh` (Telegram) at wave dispatch, gate
outcomes, blockers/questions, and final completion — meaningful milestones only.
`202` is queue acceptance, not delivery; check delivery status.
*(Owner, 2026-09-17: standard practice for communication.)*

**Command-shaped work** (test suites, builds, disposable servers) runs in
`bg_run` in this session when the conductor must run it itself — no child, no
watch, completion wake carries the exit code.

---

## 9. Merge, evidence and cleanup

1. A wave's children are accepted only after: gate re-run green + conductor
   probes + (for waves ≥2) reviewer child findings addressed.
2. Merge order into master: E → (Wave 1) A, then C (consumes A's kernel interfaces
   if needed), then B, then D (docs/fixtures; no code overlap). Wave 2: F, then G.
   Wave 3: H. Conflicts are resolved by the conductor; a semantic conflict goes
   back to the owning child as a correction brief rather than being papered over.
3. `--no-ff` merges with the track name in the message; push to `origin/master`
   after each accepted wave (feature-merge only — **no production action, no
   deployment**). **Owner-approved 2026-09-17**: accepted waves may be merged to
   master and pushed; production deployment/restart remains a separate owner gate.
4. After merge: `git branch -d` the track branch (only when clean + merged),
   `git worktree remove` its directory, cancel its watch, `board leave` its entry,
   release its exact retention lease (`POST /sessions/:id/control`
   `release_retention`) — confirm 200 — and delete the session only if it was
   disposable and its evidence is preserved in `operations/`.
5. Evidence retention: children's red/green logs + handbacks live on their
   branches (they merge with it); conductor copies the handback to
   `operations/voice-live-20260917/handbacks/` before deleting a worktree.
6. Update [`VOICE-MODE-INDEX.md`](./VOICE-MODE-INDEX.md) whenever a voice document
   is added/changed; run `npm run docs:check-status`, `docs:check-links`,
   `docs:check-agent-guides` after every docs-touching merge.

---

## 10. Risk register and stop conditions

| Risk | Mitigation |
|---|---|
| DeepSeek child quality on the safety kernel | TDD briefs with RED evidence; conductor re-runs gates; one bounded correction per defect with the same route; capability escalation (GLM 5.3 / Gemini 3.8) only if a correction round fails twice |
| Quota/pool constraints at dispatch | Live preflight each dispatch; rotation across three pools; documented fallback routes; split waves rather than silent substitution |
| Contract drift between B and C | E's frozen contract is authoritative; both briefs point at it; a needed divergence is a `PARENT-INPUT-NEEDED` question, not a silent change |
| Watch/wake chain failure (historical: silent strand) | Primary + model-free backstop every window; on-wake reconciliation of all children; handback files; board presence |
| Validation-server leaks → `ADMISSION_CAPACITY_EXHAUSTED` | Serialise heavy validation; `pkill -9 -f validation-server` allowed (kills leaked children, never the service) as documented in the skill; re-check `/capacity` |
| Another lineage starts on pi-web-ui mid-programme | Board check at every wave boundary; if a sibling owns overlapping scope, postpone the seam and continue independent work; never edit their files |
| An external actor restarts the service mid-run (observed 2026-09-15) | Watches rehydrate, but goal+watch state is reconciled from ledger after any restart; no work depends on a single wake |
| Cost surprise on live Gemini calls | Gate 3 probe 1 s of audio; Gate 5 scenarios bounded; no synthetic treadmill; owner confirmed real bounded calls and set **no maximum budget** (2026-09-17) — calls stay bounded by design |

**Stop and ask the operator** (not a child question) when: the plan's premise is
contradicted by ground truth; an owner gate is reached (Phase 7, production, a
merge-authority boundary); an irreversible action is required; or the same defect
fails two correction rounds.

---

## 11. Owner decisions (recorded 2026-09-17)

All pre-dispatch questions are resolved. Recorded verbatim in substance:

| # | Question | Owner answer (2026-09-17) |
|---|---|---|
| OQ-1 | DeepSeek v4.1 Flash as the programme's primary child model? | **Confirmed.** |
| OQ-2 | Approved to rotate across `commandcode`, `opencode-go` and `clinepass`? `openrouter` excluded? | **Rotating approved** across the three pools; `openrouter` (metered) is not part of the approved rotation. |
| OQ-3 | Merge authority for accepted waves? | **You may merge** — accepted waves merge to master and push; feature merges only, no production action. |
| OQ-4 | Real bounded Gemini Live calls acceptable? | **Confirmed acceptable**; **no maximum budget**. Usage stays bounded by design. |
| OQ-5 | Supervision level | Not separately answered; the recorded default is active — autonomy within each track, conductor checkpoints at gates, children ask only at genuine blockers (§5.3). |

Additional operating instructions (owner, 2026-09-17):

1. **Children run under goals** — use the goal function for every track child
   (armed at creation; see §5.2).
2. **Conductor manages its own goal engine autonomously** — pause while
   watching/waiting for children, resume when settled, following the orchestration
   and long-horizon waiting skills (§8).
3. **Telegram communication: standard practice** — meaningful milestones,
   questions/blocked states, and completion; check delivery status (§8).

No blocking questions remain. Execution starts on the owner's Goal Engine
activation.

---

## 12. Live progression log (append-only; newest first)

**2026-09-18 (NATIVE LANE CAPTURE FIX — operator-reported production failure, root-caused, fixed, deployed).**

The operator reported that in production the native lane's **open mic** did nothing, **Start listening**
said "microphone unavailable — failed to load worklet module script", and **push-to-talk** claimed there was
no microphone — while the **legacy relay lane worked fine**. That asymmetry named the fault domain: two
capture paths, one broken.

**Root cause (reproduced, not inferred)**: `audioWorklet.addModule()` is a script fetch governed by
`script-src`; production's policy is helmet's default (`script-src 'self'`, **no `blob:`**), and the capture
session's only worklet URL was a `blob:`. Dev servers send no CSP, which is exactly why every dogfood run
passed and the deployed UI never could. All three microphone controls failed together because they share
one capture path.

**Fix `5992f84`**: the worklet's bytes (still generated from ONE source) are delivered as a **same-origin
asset** — a vite plugin serves them in dev and emits `voice-live-capture-worklet.js` into the bundle, which
the production server's `express.static` serves. No policy is relaxed. The blob stays only as a fallback for
a stale dist. Two further defects fixed with it: the worklet can no longer fail *anonymously* (the failure is
reported as the named fault `worklet_unavailable` with every candidate's error), and the surface's copy — which
promised "Push-to-talk and typing still work" after a capture failure while push-to-talk drives that same
path — is now derived from the named reason.

**Observability for the native lane** (the operator's report was visible NOWHERE server-side): a capture fault
now rides the activity frame as an additive v1 field (contract catalogue updated in the same change),
recorded as `voice-kernel {"event":"voice_capture_fault",…}` and counted in a bounded
`.operational.voice.live.captureFaultTotal` (unknown reasons bucket as `other`). Observation only.

**Verification**: real Chromium + real built bundle + the EXACT production CSP + the real UI: the same-origin
worklet **loads**, the blob **is refused** (the operator's error, reproduced on demand), and the native lane
reaches `capture: "live"` for **open mic and push-to-talk** with zero CSP violations. Evidence:
`operations/voice-live-20260917/evidence/native-lane-csp-fix-20260918/`.

**Deployed** 2026-09-18T10:04:37Z (owner-authorised restart, `RESTART-REQUESTED` recorded, drain pre-flight
0 busy of 200): service active, `NRestarts=0`, bundle `index-DyxmZ2CZ.js`, CSP unchanged, and
`http://localhost:3456/voice-live-capture-worklet.js` → 200 `application/javascript`, bytes identical to
the built asset. The restart also carried the previously-undeployed live-model visibility (`voice.live.model`
now reads **`gemini-3.8-live`** in production) and the `VoiceLive` log component.

**Open with the operator**: typing-latency was mentioned in the same report and has NOT been reproduced or
diagnosed; ask them to re-test it now that capture no longer fails.

**2026-09-18 (MODEL VERIFICATION + two observability additions, owner-requested).**
The owner asked the backend to prove which model the live path actually uses. **Verified: `gemini-3.8-live`**
(`VOICE_PROVIDER_MODEL`, `server/src/voice/types.ts:279`), by a five-link chain: (1) the mount constructs
`VoiceSessionService` with no model and no env override exists in `config.ts` (production's runtime env
carries only `GEMINI_API_KEY` and `VOICE_MODE_ENGINE`); (2) the bridge resolves `options.model ??
VOICE_PROVIDER_MODEL`; (3) production's **deployed** `server/dist/voice/types.js` contains the constant;
(4) a direct provider call using the server's own `createGenaiLiveSessionFactory` +
`buildVoiceConnectConfig` was **accepted — socket open 102 ms, `setupComplete` 505 ms** (a wrong or retired
model id fails setup, so acceptance is the provider's own receipt for that seat); (5) the owner's live
sessions (lanes bound, engine `gemini-live`, turns and a delivered release recorded) only reach `live`
after that same `setupComplete`. *(The first receipt attempt failed at 12 s — my script imported the
system instruction from the wrong module, leaving `parts:[{text: undefined}]`; that was a scratch-tool
bug, not a product issue, and it is exactly why the addition below matters.)*
**Because nothing at runtime actually SAID which seat was in use** (the model was debug-only; the
snapshot named the engine, not the model), the owner's "improve the observability tools" request was
answered with two additions (`f37f22d`): `operational.voice.live.model` states the seat from startup
(`null` = not stated, never assumed) and the bridge logs `voice live session ready {model}` at **info**
on `setupComplete`, once per lane, on the `VoiceLive` component. Docs (OBSERVABILITY.md retrieval
queries) and the Phase-8 checklist carry both checks. Gates: 545 focused tests, full server suite 434
files/5376, ratchet 323 ≤ 326, CI green. **Not yet on production** (which runs `b9e7fb4`): the two
visibility additions need a restart, deliberately not taken while the owner is testing.

**2026-09-18 (OBSERVABILITY AUDIT — the pre-wave stack survived intact; the native voice path gained its own log component).**
The owner asked whether the observability tooling that existed before the execution waves still exists
and whether Voice Mode is as observable. Checked against the pre-Wave-0 baseline (`f46d5b1`):
**nothing was removed or weakened** — no observability file added or deleted under `server/src/logging`
or `server/src/internal-api`; `error-codes.ts` (457 lines) and `event-types.ts` (67 lines) are
byte-identical to the baseline; `session-cleanup.ts`, `fatal-error-handlers.ts` and the whole
`logging/` module are untouched (`git diff` empty); `docs/OBSERVABILITY.md`'s section list is
identical. **Verified live on production** (which is serving `gemini-live` during the owner's Phase 7
test): `.voiceMode.lanes` (2 lanes bound with `boundAt`/`lastTurnAt`/`turnCount`),
`.voiceMode.recentTurns` (real turns, e.g. a confirm → `released` → `delivered`),
`.operational.voice` (turnTotal, releaseTotal, gateDeniedTotal, receiptAckTotal, turnDuration,
modelLatency, deliveryLatency, audio, live, proposals), and the journal carrying `[VoiceMode] voice
turn/release`, structured `voice-kernel {...}` evidence lines, the engine-selection record and the
WebSocket frame log. **One real gap found**: everything the NATIVE path emitted went out under the
generic `WebUI` component, so `DEBUG=`/`?component=` could not isolate a live-lane problem; fixed in
`a707ba8` (`VOICE_LIVE_LOG_COMPONENT` + `createVoiceLiveLogger()`, wired through the mount's
serviceLog/evidence sinks and construction lines; `docs/OBSERVABILITY.md` now lists
`VoiceLive`/`VoiceMode`/`ClientVoice` with filter recipes). Tests: 525 voice+websocket, full server
434 files/5374, ratchet 323 ≤ 326, CI green. **Honest limits**: voice records deliberately carry no
`sessionId` (the voice path is the global diagnostics route — documented), so the per-session
evidence bundle does not carry voice rows; retrieval is the documented global-route query filtered
by `workerSessionId`. The native audio counters read 0 at audit time (no operator PCM had reached the
server) — a fact about the flow in use, not a fault; the talker turn counters were moving normally.

**2026-09-18 (PRODUCTION DEPLOYED for Phase 7 — owner-authorised; and the red CI made green).**
The owner authorised deploy + restart so they can run the Phase 7 real-ear test on production,
asked for a Telegram ping when it was running, and for CI to be green. All three are done.
**Deployed**: master `b9e7fb4` built (`npm run build`, exit 0) and production restarted through the
audited wrapper at 06:16:12Z (`RESTART-REQUESTED` recorded with the owner's reason; drain
pre-flight 0 busy of 200; `NRestarts=0`). **Verified after restart**: service active, HTTP 200,
the served bundle is the freshly built one (`index-uBjwOgGB.js`, contains the voice surface),
contract 1.44.0, clean boot log showing `Allowed origins: https://pi.letsautomate.work`.
**Two env values added** (secrets env, never printed): `GEMINI_API_KEY` — it was genuinely
missing, so the live engine could not have worked — and `VOICE_MODE_ENGINE=gemini-live`.
Rollback = flip the flag to `cascade` and restart. **Not verified by me**: a real voice lane on
production, because login needs the owner's plaintext password (the stored value is a bcrypt
hash) — that is precisely the Phase 7 test, and the owner was pinged with the exact steps.
**CI**: the `Application correctness` workflow had been red on the voice pushes in two layers.
(1) The warning ratchet: 349 > 326 — fixed by consuming the contract's 19 assertion aliases in
one exported tuple (an orphaned alias asserts nothing), deleting two stale test declarations, and
extending the existing `^_` ignore convention from args to vars; **no ceiling change and no
suppression** (`a38c65d`, 353 → 323 locally). (2) The shared coverage gate: functions 91.3% <
93.11% — three contract guards (`isVoiceClientMessageType`, `isVoiceServerMessageType`,
`hasNoToolArguments`) are called in production (websocket routing, client validator, bridge's
parameterless-tool check) but had no tests; covered (`20c02b5`, now 95.65% functions / 95.85%
lines / 84.25% branches). **`Application correctness` is green on master** (run 35314914811), and
Docs checks stayed green throughout. Production runs `b9e7fb4`; the two later commits are
lint/test/type-level only, so their runtime is identical — no further restart (the owner is
testing).

**2026-09-18 (GATE 5 RE-PROVEN THROUGH THE CORRECTED CODE — three harness defects found and fixed; R's audit-converse limit closed on live evidence; then the loophole the verifier found closed too).**
Running the Gate-5 slice after the Wave-3 merges exposed that the harness itself had not been
exercised since the corrections, and found four real problems — **two of them integration defects
that the merges introduced and no gate had caught**:
1. **The slice's disposable server booted in `cascade`.** Track H's `VOICE_MODE_ENGINE` default is
   `cascade`, and the slice never set the flag, so every lane start was refused
   `voice_provider_unavailable` — the gate was silently misconfigured the moment the flag landed.
2. **An early-failure return never tore the disposable server down**, leaving it running and the
   process hung until an external kill (observed: a 25-minute stale run with a stray server).
3. **The audits read pre-L1 field names.** Track K's L1 hygiene replaced full text with scrubbed
   excerpts (`tidiedExcerpt`/`bytesExcerpt` + `…Truncated`), and the gate-leak/byte-fidelity audits
   still read `tidied`/`bytes`, so a *correct* run reported digest mismatches. The audits now read
   both shapes, **never recompute a digest from a truncated excerpt**, and say so instead of
   guessing (SHA chain + excerpt equality still bind).
4. **S2's spoken confirm is ASR-flaky**: the live provider transcribed "Yes, send that." as "Yes
   and that." — a statement, so the (correct, fail-safe) classifier never treated it as a
   confirmation. The scenario now gives one honest retry with a second phrase and reports which
   attempt landed; a human repeats themselves.
Plus the substantive addition: **the converse audit** (review R, Gate-5 coverage limit 2) — every
instruction in the worker's own store must be an authorised delivery or the named harness baseline
(`SLOW_WORKER_PROMPT`), so `store ⊆ delivered` is proven rather than implied. Its unit suite shows
the failure direction (near-miss byte equality, wrapped text, an unauthorised instruction, an empty
store); the live run shows it clean. **Live revalidation: exit 0 — 3/3 scenarios, gate leak clean,
100% byte fidelity, worker-store coverage clean (`store instructions=3 unauthorised=0 wrapped=0`)**,
evidence in `operations/voice-live-20260917/evidence/gate5-revalidation-20260918/`. Full gate after
the change: typecheck 0; shared 9/246, server 433 files/5367 (+2 skipped), client 144/1611, mcp
8/71 — exit 0. Committed `2900997` and pushed. **An independent verifier (runtime-validator) is
re-running the live slice and trying to falsify the audits; its report is awaited.**

**2026-09-18 (M VERIFIED AND MERGED `cb929c6` — WAVE 3 CLOSEOUT COMPLETE; Phase 7 handed to the operator).**
Conductor verification of M on its frozen commit (`e68ef39`): typecheck 0; shared+client builds 0/0;
client 144 files / **1611** tests; shared 9 files / **246**; **Playwright 9/9 (my own run)**. Code
inspection: `receiptVerdict()` gives each outcome its own honest wording (`delivered` is the only
outcome worded or toned as delivery; `unknown` names the cause and the reconciliation promise); the
delivered chime badge is gated on `lastChime === 'delivered'` **and** `receiptIsCurrent`, so no
delivered claim can stand beside a newer unconfirmed proposal; the shared union change is purely
additive (one member + two type-level assertions). The evidence JSON records badge visibility and
the chime variant actually played per outcome: only `delivered` gets the delivered variant; the
other three keep C's deliberately distinct non-delivery figures. Merged `cb929c6`. Conductor hygiene
follow-up `4ca8262`: the default Playwright config now excludes the three voice-live-lab specs (they
are opt-in via their own configs — CI does not run Playwright, but a bare local
`npx playwright test` would otherwise run them against the wrong server and page). Cleanup: watch
cancelled, lease released, worktree removed, branch deleted. **Honest process note: the merge and
config commits were pushed before the post-merge full gate finished; **the gate then passed on the
final master**: `npm run typecheck && npm test` exit 0 — shared 9 files/246, server 431 files/
5355 passed (+2 skipped), client 144 files/1611, internal-api-mcp 8/71; `npm run lint` exit 0.**
**Phase 7 handed to the operator** (Telegram question + `PHASE-7-RUNBOOK.md`):
one-command disposable slice with the live engine, pre-tested by me (lane live, audio streamed,
clean detach). **Wave 3 closeout summary: all eleven review findings plus M7/M8 are closed across
K/L/M; three items are recorded as accepted LOWs rather than silently claimed — L3 (present-variant
honesty), R's audit-converse scope limit, and the deliberate "only the latest receipt is displayed"
choice.**

**2026-09-18 (PHASE 7 SLICE SELF-TESTED — the composed browser↔server loop now proven on it).**
`scripts/voice-mode-dogfood.sh` + `PHASE-7-RUNBOOK.md` prepared, then self-tested end to end by the
conductor: the disposable child demonstrably carried `VOICE_MODE_ENGINE=gemini-live` and the client
origin; a real Chromium (fake media) logged in, entered Voice Mode, continued a session, expanded
the **native voice lane** and started it — observed client-side as **`live · worker idle`** with
`Listening — open mic` and **no** `unavailable` state, and server-side as a stream of
`voice_audio_chunk` frames followed by `lane_send_unbound` + `lane_detached` on browser close. The
script's own teardown (client kill → validation-server stopper) was exercised and verified twice
(stopper recorded `group verified gone`; both ports freed). **This closes review R's Gate-5 coverage
limit 1 for the browser path** ("the composed browser↔server loop has never run against the composed
server") — evidence in `operations/voice-live-20260917/evidence/phase7-prep/`. It does NOT close
Phase 7: no audio was heard; real-ear stays the operator's verdict. One defect was found and fixed
during the self-test: `npm run dev:client -- --port …` let npm swallow `--port` (vite ran as
`vite 3499` on its default port); the script now execs the vite binary directly and the trap
hardened. **Track M (receipt verdicts visible, N6) still in flight** — the Phase 7 handover message
to the operator waits for M to land and pass verification.

**2026-09-18 (K VERIFIED AND MERGED `44aad1c` — all eleven review findings closed server-side).**
Conductor verification on K's frozen commit (`33af7dd`): **typecheck exit 0; focused suites 49 files /
801 tests; full server suite 431 files / 5357 tests (2 skipped)** — all re-run by me; then the
**merged-tree full gate (`npm run typecheck && npm test`, all four workspaces) exit 0** before the
push: shared 9/244, server 431/5355+2 skipped, client 144/1603, internal-api-mcp 8/71. RED-first
evidence is recorded per finding (21/25 red pre-fix with per-finding failure messages; M8 2/2 red).
**All four of R's probes re-verified by me on the merged tree**: `RETARGETED=false` + refusal
(H1); a confirm with no echo / no presentation refused with zero deliveries (H3); the lane table
reclaims a detached lane so a full table recovers (H2); M1's exactly-once is proven by a dedicated
test that gates the first delivery in flight and shares one idempotency key across two proposals
(1 delivery, 1 release record, loser refused). K chose resolve-then-retarget (option b) with
`proposal_resolved{outcome:'replaced'}` + evidence `reason:'worker_retarget_same_generation'` — the
change is never silent. The four modified existing tests were each **strengthened** (notably
`talker-transport`, whose old expectations pinned exactly the P25 channel shape M5 forbids).
Contract doc extended **additively** with `voice_lane_capacity` (no test parses the code table;
shared suite green after the edit). Cleanup: watch cancelled, lease released, worktree removed,
branch deleted. **Residuals recorded honestly:** L2 was improved (a spoken confirm now releases the
variant the read-back matched); **L3** (`ProposalStore.present` records `presentedVariant:'original'`
even when nothing was removed) and R's **audit-converse** observation (the Gate-5 audit proves
delivered ⊆ store, never store ⊆ delivered, so the plan's wording is stronger than the proof) remain
**accepted LOWs** — narrowing-only, no safety hole, not silently claimed closed. **Phase 7 prep
ready**: `scripts/voice-mode-dogfood.sh` (one command: disposable server with
`VOICE_MODE_ENGINE=gemini-live` + dev client wired to it, self-test pending) + `PHASE-7-RUNBOOK.md`.

**2026-09-18 (L VERIFIED AND MERGED `9caa44d`; conductor isolation gap found and repaired).**
L's handback (`coordination/L/complete.md`) closes H3-client, M7 and M8-client. Conductor
verification on the frozen commit: scope clean (client only + the two disclosed new root files);
the click-alone test exists and the buggy `onPresentationReport` prop is **removed from the card's
API** (the mistake cannot be reintroduced by a caller); the browser spec drives the real component
tree (the speech service is a disclosed deterministic stand-in; the product only ever learns of
completion from the utterance's own end event) and asserts the load-bearing sequence — pending →
disabled, a click sends **zero** `proposal_presentation` frames, playback end → presented → enabled,
confirm carries `proposalRef {version, sha256}`. **I re-ran the gates myself: root typecheck exit 0;
shared+client builds 0/0; client suite 144 files / 1603 tests; Playwright 5/5 in a real browser.**
Post-merge on master: typecheck + client suite green. Merged `9caa44d`, pushed; a conductor follow-up
fixed a prose typo in L's evidence README (`979c21a`, the committed log is the artefact). Cleanup:
watch cancelled, lease released, worktree removed, branch deleted. L's honest gaps stand as recorded
(audibility not measured on this host; real OS speech engine not exercised; no live server socket in
the browser evidence) — real-ear remains Gate 7, the operator's.

**CONDUCTOR DEFECT FOUND AND REPAIRED (D-08):** L honestly reported that `npm run typecheck` at the
repo root fails in the **server** workspace (`src/routes/*.ts`, zod `.errors`) and reproduced it with
its changes stashed. The cause was **my worktree isolation recipe**, not the product: the worktrees
lacked the **nested** workspace `node_modules` (main's `server/node_modules/zod` 3.25.76 and
`shared/node_modules/zod` shadow the root zod 4.4.3 that npm hoisted for another consumer). Both
correction worktrees now have the nested entries symlinked and resolve zod 3.25.76 (resolver-verified);
the root typecheck then passed in both. **Recipe v2: isolate nested `server|client|shared/node_modules`
as well as the root** — this also protected K's final gate. (It likely explains earlier one-off gate
oddities; future pre-dispatch checks must probe a nested import, not just `@pi-web-ui/shared`.)

**2026-09-18 (WAVE 3 CLOSEOUT — independent review R landed; two correction children dispatched `4ae2bcf`).**
R's review of record (`coordination/R/complete.md`, read-only, zai GLM 5.3 Flash for model-family
independence) reviewed `b39cc27` and re-ran its probes on post-H `edccdbe`. Gate verdicts: 0, 1, 2,
6 **SOUND**; 3, 4, 5 **WEAK**. Eleven findings. **I reproduced all four of R's executable probes
myself on master and confirmed every cited code site**: `PROBE1 RETARGETED=true` (same-generation
`voice_session_start` silently re-targets the lane's delivery worker — contract §3.2 "never
retargets"); `PROBE2 deliveries=1` (a confirm with no echo and no presentation released
immediately; `proposal_created`'s announced `presentation:{completed:false}` is never seeded and
the identity is fabricated from the live proposal); `PROBE3 deliveries=2 releaseRecords=1`
(concurrent confirms sharing an idempotency key); `PROBE4 lanesRetained=64` (lane table caps at 64
and never evicts — 64 page loads permanently exhaust voice until restart, refused as
`voice_internal_error`). Weaknesses confirmed at code level: `injectContext` has **zero** production
callers (plan Phase-3 property is dead code in the composed system); the normaliser lets lead-in
channel shapes reach the worker; no echo/self-transcript exclusion; the budget refusal is
unrenderable client-side; the card's typed Confirm is permanently disabled in the real UI while the
spoken path bypasses presentation (intent §18.2: the spoken read-back itself constitutes the
presentation — so both paths must require the read-back). R's negative results are as valuable:
instruction-bearing client frames, model output reaching the release path, double delivery of one
proposal, classifier bypass, audio-ceiling gaming and forged generations all held.

**Corrections dispatched (Wave 3 closeout, two children, disjoint paths, briefs `4ae2bcf`):**
- **K (server safety & honesty)** — session `01a0b286-ebe3-711b-bb08-c2cfa2ead195`,
  clinepass/cline-pass/deepseek-v4.1-flash high, worktree `/root/pi-web-ui-wt-corr-server`,
  branch `fix/voice-corr-server`, lease `0abf06dd-905b-4429-b626-1a3d30afc9df`
  (owner `voice-exec-20260917-k`). Closes H1, H2, M1, M2, M3, M4, M5, M6, M8 (server half),
  L1 and H3-server. Owns `voice-live-mount.ts`, `connection.ts`, `talker/**`, `voice/**`.
- **L (client presentation & reachability)** — session `01a0b286-ef54-711b-bb08-c2d1cfb0cfda`,
  commandcode/deepseek/deepseek-v4.1-flash high, worktree `/root/pi-web-ui-wt-corr-client`,
  branch `fix/voice-corr-client`. Closes H3-client (read-back really plays; presentation reported
  only after playback; typed Confirm enabled once presented and carrying the `proposalRef` echo),
  M7 (the surface is mounted in the app with an honest unavailable state — Phase 7 prerequisite)
  and M8-client. Owns `client/**`.
Watches `ww_11`/`ww_12` (goal_end + goal_state paused + PARENT-INPUT-NEEDED); backstop 90 min.
Both briefs require RED-first tests per finding and, for L, real-browser Playwright evidence.
**Phase 7 (real-ear) waits for these to land and pass conductor verification** — shipping known
safety gaps into an operator trial would be wrong. R's session cleaned up (watch cancelled, lease
released). Worktree isolation recipe applied and resolver-verified (OWN TREE) before dispatch.

**2026-09-18 (GATE 8 CLOSED — H verified and merged `edccdbe`; R still reviewing).**
H's 17-file diff is exactly its owned paths (config, session-registry, voice/**,
websocket/{connection,voice-live-mount}, security/rate-limit, observability/operational-metrics,
+ tests); frozen areas untouched. Conductor verification: **Gate 8 re-run verbatim
(`npm run typecheck && npm run test`) → exit 0**, all four workspaces green (shared
9, server 429, client 140, internal-api-mcp 8 files) — **re-run again on the
merged master with the same result** before pushing. The plan's fallback proof
re-run by me: 20/20 across the fallback suite + the seam suites; the kill is real
(the test closes the real bridge's provider socket mid-session, then asserts
fallback engagement, drafts/parked items surviving and remaining actionable, the
announcement frames on the wire, and the one-time registry announcement).
Structural checks: **F-1** — the mount's `withIdleToolAcknowledgements` wrapper
is **deleted** and the scheduling is now an engine option defaulting to
`WHEN_IDLE` (the F-1 silence defect cannot recur by construction); **F-2** —
`wsVoiceFrameLimiter` (1200/2 s) now lives in `security/rate-limit.ts` beside
`wsMessageLimiter`, used by `connection.ts`, behaviour identical and the generic
limiter unchanged; **flag** — unset/blank → `cascade`, case-insensitive, unknown
values throw with a clear message, and a cascade-mode lane never calls the bridge
factory. Security scan of H's commits: clean (only the known test sentinel).
Cleanup done (watch cancelled, lease released, worktree removed, branch deleted
local + remote). **R (independent review) is still running**; its findings will
be adjudicated on arrival, including a second read-only pass over H's diff.

**2026-09-18 (Wave 3 DISPATCHED — H rollout + R independent review, from master `5a453b2`).**
Briefs committed (`5a453b2`). **Structural decision:** the two deferred Wave-2
seams (F-1 tool-ack scheduling, F-2 rate-limit consolidation) are folded into
**H** rather than a separate correction child, because both touch files the
rollout also needs (`server/src/voice/**`, `server/src/websocket/{connection,voice-live-mount}.ts`)
— one writer, ordered deliverables, no cross-worktree dependency. **H**
`01a0b232-d19a-711b-bb08-c2cb50c0a7b3` — `opencode-go/deepseek-v4.1-flash`
(max), worktree `/root/pi-web-ui-wt-rollout`, branch `feat/voice-rollout`, lease
`552f5a84-85e8-43c1-a64b-5835e729b453` (owner `voice-exec-20260917-h`); owned
paths `config.ts`, `talker/session-registry.ts`, `voice/**`,
`websocket/{connection,voice-live-mount}.ts`, `security/rate-limit.ts`,
`observability/operational-metrics.ts`, `internal-api/routes/diagnostics.ts` +
tests. **R** `01a0b232-d4f4-711b-bb08-c2cd095a2f80` — `zai/glm-5.3-flash` (high;
deliberately a different model family from the authors), cwd
`/root/voice-review-20260918` (no worktree; **read-only**, report to
`coordination/R/complete.md` only), lease `723ff698-62b4-4634-bb4d-0341923bd591`
(owner `voice-exec-20260917-r`). Both started on dispatch. Watches `ww_9`/`ww_10`
(goal_end + goal_state(paused) + `PARENT-INPUT-NEEDED`); backstop
`deadline-bba684ec` until 03:18Z. Worktree isolation applied to H before dispatch
(resolver probe green).

**2026-09-18 (WAVE 2 COMPLETE — F merged `e792c26`; Gate 5 verified twice; one security incident contained; Wave 3 next).**
**F verified and merged.** My own verification ran the gate **twice**: once with
the ambient `ALLOWED_ORIGINS` and once from a bare shell with
`ALLOWED_ORIGINS`, `AUTH_PASSWORD` and `NODE_ENV` scrubbed — both exit 0, **3/3
scenarios**, gate-leak clean (deliveries == authorisations, each preceded by its
owned authorised confirmation), **100 % byte fidelity** (kernel digest
reproduces the confirmed SHA; delivered bytes byte-identical; the worker's own
store carries them), negative controls refused (`voice_proposal_stale`,
`voice_client_text_forbidden`). Two bounded defects I found during verification
were fixed by F in `a5119c6` and re-proven: **(1) gate reproducibility** — the
runner depended on ambient `ALLOWED_ORIGINS` (bare shells got a 403 origin
rejection at the `/ws` upgrade; the fix passes `ALLOWED_ORIGINS: SLICE_ORIGIN`
explicitly); **(2) failure visibility** — a thrown runner error exited 1 with no
printed reason (the completion path now prints the failing scenarios, checks and
failure lines). Merged-tree gates: typecheck + full build clean; **server suite
425 files / 5298 tests green**; mount unit suite 13/13.

**SECURITY INCIDENT (F-6) — contained, nothing reached the remote.** F's
*unpushed* correction commit carried live provider credentials: the disposable
worker ran an `env`-style command whose tool result (the worker's own tool
result, copied verbatim into the session store used as fidelity evidence) held
the operator's Google and OpenRouter keys from the ambient environment. **GitHub
push protection rejected the push (`OpenRouter API Key`)** — it never landed.
Containment, verified by me independently: F added `redactSecrets` on the
evidence-writing path and amended the commit; I scanned the whole tree at both
pushed commits (`03c9895`, `a5119c6`) for credential shapes — clean (the only
match is B's deliberate `AIzaSENTIN…` test sentinel, also on master); the
unredacted commit `b14f328` was never pushed and I removed its reflog reference
(no ref or reflog points at it; the object stays unreachable until a natural gc
— I deliberately did **not** force a prune because the object store is shared
with other worktrees/agents); the disposable state dirs that held raw dumps were
deleted (19 `/tmp/voice-slice-*` dirs cleaned). The owner was informed (F sent a
notification; conductor disclosure follows). Rotation of the OpenRouter key is
the owner's call — assessed as optional: local-only exposure, nothing on the
remote.

**F-5 (incidental, recorded for a product decision):** the frozen normaliser only
strips a commission frame that names its addressee, so "Ask it to update the
changelog." was a silent no-op (safe but invisible); the scenario now uses the
explicit "the worker" frame. Product question (clarify vs silent no-op) queued.

**Durable-fix decisions queued for Wave 3 / follow-up:** F-1 (where the tool-
acknowledgement scheduling belongs — Track B/parent), F-2 (fold the voice frame
budget into the shared rate-limit module), F-3 (offer flow — intent §19.4
capability decision).

**2026-09-18 (Wave 2 F in flight — backstop reconciled; F has already run Gate 5 and with real findings).**
Backstop `deadline-3950c64b` expired; **expiry ≠ completion** — F was verified
alive and productive (goal running, session busy, 619 messages, new files:
`server/src/websocket/voice-live-mount.ts` (995 lines) + its 451-line test,
`scripts/voice-live-lab/lib/voice-slice/*` (slice runner 1278 lines +
disposable-server/operator-audio/ws-client), and `evidence/F/` already carrying
`gate5-run.txt`, `byte-fidelity-audit.json`, `gate-leak-audit.json`,
`negative-control.json`). Backstop re-armed as `deadline-5e079e2b` until 01:53Z;
`ww_6` still armed for `goal_end`. F's interim **FINDINGS.md** documents four
issues it hit while wiring the real system, each worked around inside its own
owned paths without touching frozen code: **F-1** (high) tool acknowledgements
scheduled `SILENT` end the turn with no speech — Gemini Live calls the declared
function and the operator hears nothing; the mount wraps the provider session to
re-schedule acknowledgements `WHEN_IDLE` (durable fix is a Track-B/parent
decision on where the scheduling belongs). **F-2** (high) the generic
`wsMessageLimiter` (60 msg/min) drops the operator's audio frames (~10–50/s);
the mount exempts voice frames with a bounded per-client budget (1200 frames /
2 s) — the generic limiter is unchanged for every other message. **F-3**
(medium) `offer_ask_worker` is emitted as `tool_call` with no wire form and is
deliberately not turned into a kernel offer — an intent §19.4 capability
decision, not a Phase-5 convenience. **F-4** (low) a mid-run steer is only
visible in the worker store at the worker's turn boundary; the runner polls the
worker's own record for up to 45 s so byte fidelity is proven from the worker,
not the delivery call. Durable-fix ownership will be decided at handback review.

**2026-09-18 (GATE 6 CLOSED — G merged `e997d2a`; an npm incident damaged the main checkout's `node_modules` and was repaired).**
**G verified and merged.** Gate 6 re-run by me: **3 files / 30 tests in 1.8–1.9 s**
(bound < 20 s). The suite drives the **real** kernel/voice code (imports
`utterance-classifier`, `policy-core`, `proposal-store`, `release-store`,
`talker`, `delivery`, `voice-session`, `voice-router`, `contract` — no
reimplementation), and I **independently probed its falsifiability in two
lanes**: dropping a critical negation from a corpus item's recognised text
fails the fidelity suite; disabling the real duplicate guard in
`release-store.record()` fails the replay family with a precise report
(`executed 4, passed 3`). Both probes restored; tree clean. The fixture change
is additive (`recognisedText` + `recognisedProvenance`), with the honest caveat
recorded by G: the corpus's transcription lane is its own frozen reference text
(no scored live capture exists), to be replaced when a real capture happens.
G also independently reproduced the **`tier2-lean` flake** I recorded in Wave 0
(19/20 delivered recall once under full-suite load, then green on re-run) — two
independent observations now; it is a lab timing sensitivity in a NO-TOUCH path,
recorded for a future fix, not a Wave 2 defect. Post-merge gates: typecheck
clean; **full server suite 424 files / 5285 tests green**.

**INCIDENT (conductor-repaired):** an npm operation during Wave 2 (child G's
environment repair, handback §6) damaged the **main checkout's**
`node_modules`: top-level `@google/genai` and `@vitest/utils` went missing, with
npm staging dirs left under `node_modules/@google/`, and the main checkout's
`vitest` was broken. Repaired with `env -u NODE_ENV npm install --include=dev`
(`NODE_ENV=production` is set globally on this host — the trap that caused G's
first install to omit devDependencies). Verified: `@google/genai` resolves from
`server/`, vitest runs, tracked files never dirty, **production healthy
throughout** (service active, HTTP 200; the missing package is imported only by
the not-yet-mounted voice bridge). Standing rule recorded for future dispatches:
**children must not run `npm install` outside their own worktree** — the wave
briefs must say so explicitly.

**2026-09-17 (Wave 2 DISPATCHED — F integration + G regression, from master `97359fe`).**
Briefs written and committed (`97359fe`): `briefs/F-integration.md` (Phase 5 — mount
wiring, slice runner, the three scenarios, byte-fidelity proof, negative control)
and `briefs/G-regression.md` (Phase 6 — six vetoes through Track D's runner,
20-utterance corpus scoring, falsifiability controls, <20 s bound). Children
created with goals armed + durable leases + handback-keyed `verifyCommand`:
**F** `01a0b1ae-a973-711b-bb08-c2c7e3c5cece` — `opencode-go/deepseek-v4.1-flash`
(max), worktree `/root/pi-web-ui-wt-integration`, branch `feat/voice-integration`,
lease `efd4c022-7981-4145-81b7-fa2010cd12ae` (owner `voice-exec-20260917-f`);
**G** `01a0b1ae-acb5-711b-bb08-c2c94e7d46c9` — `clinepass/cline-pass/deepseek-v4.1-flash`
(high), worktree `/root/pi-web-ui-wt-regression`, branch `feat/voice-regression`,
lease `7428f5e5-bf42-4e3b-a4f9-6129814db221` (owner `voice-exec-20260917-g`).
Both started on dispatch (goal running, session busy). Worktrees created with the
proven `node_modules` isolation (real dir; `@pi-web-ui/shared` → own tree; shared
built locally — verified by resolver probe) before any child started. Watches
`ww_6`/`ww_7` (goal_end + goal_state(paused) + `PARENT-INPUT-NEEDED`); backstop
`deadline-3950c64b` until 00:53Z (~90 min, F does real provider sessions and a
server boot). Preflight: capacity 0/16; quota opencode-go monthly 80 %,
commandcode 36 %, clinepass 43 %, zai-glm 100 % (off-peak).

**2026-09-17 (Wave 1 COMPLETE — B and C verified, merged `--no-ff`, pushed, cleaned up; Wave 2 is next).**
Master `15cf5d0` (plus `8089dac` declaring `@google/genai`). Both tracks were
verified by me **on their frozen commits and again on the merged tree**, never on
their reports:

- **C (client)** — Gate 4 re-run: shared+client builds clean; the brief's exact
  arbiter command 23/23; **full client suite 140 files / 1550 tests**; the
  **Playwright ducking spec re-run by me: 3/3 in a real browser** (ducked gain
  0.15, 21 capture chunks *during* the duck, capture lifecycle `live`), and C's
evidence screenshot (masterGain 0.15, capture live, live chunk stream) matches.
  Frozen seam untouched; `speechArbiter.ts` byte-identical; the one
  `shared/src/index.ts` re-export is one additive line; the surface is correctly
  **absent from the shipped bundle** (0 hits for every marker) — Phase 5 wires it.
- **B (bridge)** — Gate 3a 7 files / 133 tests; **Gate 3b re-run by me: a real
  provider session** (setup 396 ms, transcript "voicebridge handshake check",
  100 % expected-token overlap, resumption handle captured). My anti-cheat probes:
  bogus key → FAIL as designed; **but a silenced fixture initially PASSED** (the
  provider hallucinated `"¿Qué?"`), which is a real false-green hole. B closed it
  in `ffa7e76` (phrase-related transcript predicate + unit tests incl. the exact
hallucination) and I **re-proved it myself**: silenced fixture → FAIL exit 1 with
  an honest observed-text message; real fixture → PASS; fixture restored
  byte-identical (sha256 `89d23516…`).
- **Conductor-owned defect B surfaced (mine, from the E merge):**
  `tests/unit/ci-workflow-paths.test.ts` was RED at base because the contract
  module's header names `docs/plans/VOICE-LIVE-WIRE-CONTRACT.md` while CI still
  ignored `docs/**`. Fixed in `36b5d88` by re-including the document
  (`!` entry); test 5/5 green. Honest note: my E-merge verification was scoped to
  shared build/typecheck/tests and did not run the full server suite — B's
  regression run caught what my gate missed.
- **Merged-tree gates:** typecheck + full build clean; **server suite 422 files /
  5268 tests green**; client suite 1550 green; voice suites 133 green;
  `ci-workflow-paths` 5/5.
- **Cleanup:** both leases released (`voice-exec-20260917-b/-c`), both worktrees
  removed, both branches deleted (fully merged), both watches cancelled (remote
  deletion generation-confirmed). Children's board entries had already expired
  (`leave` reported no such entry — noted, not forced).
- **Follow-through:** `@google/genai` 1.52.0 declared in `server/package.json` +
  lockfile (`8089dac`) now that the bridge is on master.

**NEXT — Wave 2:** F/G (Phase 5 vertical-slice wiring + Phase 6 orchestration)
per the plan's roster, then H + independent reviewer (Phase 8 implementation),
then the Phase 7 handover to the operator. Production unaffected throughout.

**2026-09-17 (Wave 1 in flight — B's environment blocker answered; worktree `shared` isolation fixed).**
B raised a correctly reproduced blocker: my Wave 1 worktree setup symlinked
`node_modules` into production's, so `@pi-web-ui/shared` resolved to production's
`shared/dist`, which predates the frozen contract (`dist/types/voice-messages.js`
absent) — B's repro included the resolver probe and the root cause. Options it
offered: (1) rebuild production's dist, (2) per-worktree `node_modules`,
(3) injected-guard divergence. **Decision: (2), implemented by the conductor with
zero production writes** — each Wave 1 worktree now resolves `@pi-web-ui/shared`
to its *own* tree (track-b: real `node_modules` directory with per-entry
symlinks except `@pi-web-ui/shared` → `../../shared`; track-c had independently
self-patched a lighter variant at 21:36), and each worktree's `shared` was built
locally (`shared/dist/types/voice-messages.js` now present in both; production's
dist mtime unchanged at 21:05). Verified with B's exact probe (index and subpath
to `dist/types/voice-messages.js`). The answer was written to
`coordination/B/01-questions.md` §"Parent answer" **and** steered into B's
running turn; B's goal was re-armed (running). `@google/genai` 1.52.0 stays an
undeclared transitive dependency for now (B records it in its handback); the
conductor declares it in `server/package.json` + the root lockfile at
merge/Phase-5 wiring, since the lockfile is a shared, conductor-managed file.

**2026-09-17 (Wave 1 DISPATCHED — B bridge + C client in parallel from post-E master `e56128b`).**
Children created with goals armed (create-with-goal, atomic) and durable leases,
each with an objective-side `verifyCommand` keyed to its handback file:
**B** `01a0b148-0090-711b-bb08-c2bf16703ac6` — `opencode-go/deepseek-v4.1-flash`
(max), worktree `/root/pi-web-ui-track-b`, branch `feat/voice-bridge`, lease
`55596222-bdea-43e3-9d8c-6ecd0f0140ff` (owner `voice-exec-20260917-b`); **C**
`01a0b148-03dd-711b-bb08-c2c038ec0770` — `commandcode/deepseek/deepseek-v4.1-flash`
(high), worktree `/root/pi-web-ui-track-c`, branch `feat/voice-client`, lease
`6499e894-0ebb-4c67-8638-665726eff1d6` (owner `voice-exec-20260917-c`). Both
started on dispatch (goal running, session busy). Watches `ww_4`/`ww_5`
(goal_end + goal_state(paused) + `PARENT-INPUT-NEEDED`, 6 wakes each); backstop
`deadline-ffe20f8b` until 22:31Z. Preflight at dispatch: capacity 0/16 turns;
quota opencode-go monthly 82 %, commandcode monthly 37 %, clinepass 43 %,
zai-glm 99 % (off-peak). E's cleanup completed: retention released (owner
`voice-exec-20260917-e`), worktree and `feat/voice-contract` removed; its local
watch had already exhausted its 3-wake budget (status `done`), so there was
nothing to cancel — noted rather than silently ignored.

**2026-09-17 (Wave 0 COMPLETE — E accepted and merged; contract frozen v1 on master).**
E's independent review returned PARTIALLY CONSISTENT with six material findings;
E reproduced each before acting, corrected five in `59975d2` (schema-exact
client→server frames closing a real N1/N2 hole, per-message required-field
validation, decoded-byte audio ceilings, `proposal`/`receipt` payload nesting,
probe-verified assertions replacing three provably **vacuous** type-level
sweeps) and did not accept one with sound reasoning (a handler would cross its
ownership boundary; the contract now states the handler's validation order
instead). Conductor re-verification **on the corrected tree** (`59975d2`, which
my earlier gate run did not cover): shared build + typecheck clean, **244/244**
shared tests (238 at first freeze + 6 from the correction), diff scope exactly
the three owned paths. Merged `53baf94` (--no-ff) and linked from
`VOICE-MODE-INDEX.md` §3.4. Honest note: E's goal ended formally **paused** (its
final run reported completion in prose but the goal never reached an `achieved`
state); completion is therefore **conductor-adjudicated on verified
deliverables**, and the session is being released. Wave 0 is closed: D ✅, A ✅,
E ✅. Next: Wave 1 — B (bridge) and C (client) dispatched from post-E master.

**2026-09-17 (Wave 0 — A verified green, merged and pushed; E applying its reviewer's corrections).**
Conductor verification after the correction: `tests/voice-live-lab/` 19 files /
450 tests green; full server suite (env-normalised) **415 files / 5135 tests
green**; typecheck 0; build 0; lint 0 errors (315 warnings, under the 326
ratchet); bench repo suite 10/10 after the fixture reply change. One transient
`tier2-lean` failure appeared on a single mid-correction full run and did **not**
reproduce in isolation (47/47) or on the full re-run — recorded as a suspected
flake to watch, not attributed to the changes. Pushed: pi-web-ui master
`941568d` (merge + conductor correction + fixture-based dead-end probe) and
agent-benchmarks main `7448f9c`. Bench scenario count preserved at the planned
seven (the dead-end probe lives as a pi-web-ui test fixture). **E**: its
read-only reviewer produced a material finding and E has committed the
correction (`59975d2` "correct the wire contract against the independent
review"); E's goal is still paused while it finishes, so the contract merge and
the Wave 1 (B/C) dispatch wait for E's completion handback.

**2026-09-17 (Wave 0 — A merged locally; conductor correction; verification in flight).**
A fired `goal_end` (achieved, idle) after four commits (`0bb5aa8`, `e65853d`,
`08803f5`, `c634c62`). Conductor re-ran A's gates independently: Gate 1 85/85,
Gate 2 26/26, full talker suite 592/592 — all green. Three cross-track lab
failures confirmed by the conductor (the coupling A reported): the
`baseline-dryrun` s7 dead-end premise and two `tier3-orchestrator` tests driven
by the `b2-short` fixture reply. **Allocation amendment (D-07): the conductor
takes ownership of this tiny integration correction** (plan's correction-cycle
rule). Fixes: bench `b2-short/beats.json` restart-service reply
`"Yes, restart it."` → `"Yes, go ahead."` (pure confirmation); new bench scenario
`scenarios/tier1/t1-s8-bare-yes-dead-end.json` (a genuine bare `"Yes."` with
nothing held) and the full-path dead-end regression repointed to it — the s7
stop-reading beat is gesture/playback control and now correctly classifies as a
talker-directed statement. A merged `--no-ff` as `28afe5d` (local; master push
withheld until the verification run is green). Cleanup: A watch cancelled, board
left, lease released, worktree + branch removed; D worktree + branch removed
(its branch remains on origin — noted for end-of-programme cleanup). **E** still
paused awaiting its reviewer's verdict; its committed contract is frozen and the
conductor re-ran its gates green (shared build, typecheck, 238 tests).

**2026-09-17 (Wave 0 — D accepted and merged).** Child D fired `goal_end` (achieved)
and was reconciled: handback read, then **independently verified by the conductor**
— Gate 0 command re-run (exit 0, verdict `not measured`), the bench repo's own
suite re-run (10/10, 0 skipped), regression suite re-run by the conductor
(13/13, 0 skipped), corpus file deep-equal to the frozen source (20 items) with
provenance. Merged `--no-ff` as `5e7566d` and pushed; regression suite re-run on
merged master (13/13). D's supervision cleaned up: watch `ww_3` cancelled
(remote generation deletion confirmed), board entry left, retention lease
released. Two D findings recorded: (a) the plan's lab-scoped `site/` never
existed — the repo-root site page is retained and corrected per D1 (no deletion;
conductor ruling D-06); (b) the automated session-end memory-capture lane wrote
into child D **after** its goal was achieved (goal protected the task itself; no
repo impact — noted for future children). Also observed: E spawned a read-only
review subagent (board entry `pi-01a0b113`, session already gone) — within its
session tree, no action needed. **E** still running (contract drafted in worktree,
not yet committed). **A** still running (Phase 1 committed: `0bb5aa8`
"whole-utterance confirmation shapes — doubt and conditions never release").
**Conductor early probe on A's Phase 1 commit (read-only, ahead of Gate 1):**
all 13 of the ledger's Appendix C + pushback cases behave correctly on the
branch — doubts/conditionals/echoes → `statement`, `why did you say yes` →
`question`, pure confirmations and the pushback authorisation → `confirm`. Ten
minutes later, D's session remained busy handling the automated capture lane
with no repo impact; its retention lease was released and its worktree is kept
until it settles.

**2026-09-17 (Wave 0 dispatched — strategy amendment).** Execution started on the
owner's goal-engine activation. Wave 0 was amended to pull **A (kernel) and D
(audit) forward** alongside **E (contract)**: dependency analysis showed neither
consumes the wire contract, so the critical path starts immediately; B and C move
to Wave 1 once the contract merges. Preflight snapshot captured
(`operations/voice-live-20260917/preflight/wave0-*`: contract 1.44.0, healthy
capacity, three DeepSeek pools live). Briefs committed (`26c3c26`). Worktrees:
`/root/pi-web-ui-wt-contract` (`feat/voice-contract`),
`/root/pi-web-ui-track-a` (`feat/voice-kernel`),
`/root/pi-web-ui-track-d` (`feat/voice-audit`). Children created with goals armed
(auto-start observed) and durable leases; board entries `voice-live-e-contract`,
`voice-live-a-kernel`, `voice-live-d-audit`; local wakes `ww_1`/`ww_2`/`ww_3`;
wave backstop armed. Next: reconcile on wake, verify gates, merge.

**2026-09-17 (planning close).** Ledger written, checked and pushed (`5b893a7`);
baseline verified (§3). Owner resolved OQ-1…OQ-4 and added three operating
instructions (§11); recorded here. Status remains **READY, NOT STARTED** —
execution begins on the owner's goal-engine activation. First move on start:
Wave 0 contract child E (§6).

---

## 13. Decisions log (append-only)

- **D-07 (conductor, 2026-09-17).** Allocation amendment: after Track A froze,
the conductor took ownership of the small cross-track integration correction its
change required (the `b2-short` permission-reply fixture and the full-path
dead-end probe), instead of adding another child round. RED evidence: the three
failing lab tests reproduced on A's branch by the conductor; GREEN: the same
suites after the correction (see §12 and the merged commit).

- **D-06 (conductor, 2026-09-17).** Ruling on D's flagged wording mismatch: the
execution plan's lab-scoped `site/` path never existed, and the repo-root
`site/index.html` is deliberately retained with the withdrawn-figures notice
(owner decision D1 — annotate, not erase). Nothing is deleted; the plan's wording
is read as applying to the corrected publication, which is satisfied. §12.

- **D-05 (conductor, 2026-09-17).** Strategy amendment: Wave 0 = E + A + D in
  parallel (A/D pulled forward; no contract dependency), B/C held for Wave 1.
  Rationale and dependency check recorded in §6/§12.

- **D-01 (owner, 2026-09-17).** DeepSeek v4.1 Flash confirmed as primary child
  model; provider rotation approved across `commandcode`, `opencode-go`,
  `clinepass`; `openrouter` not approved (metered). §11.
- **D-02 (owner, 2026-09-17).** Accepted waves may be merged to master and
  pushed; production deployment/restart remains a separate owner gate. §9.
- **D-03 (owner, 2026-09-17).** Real bounded Gemini Live calls approved; no
  maximum budget set. §10.
- **D-04 (owner, 2026-09-17).** Children run under goals; conductor manages its
  own goal engine autonomously (pause while waiting, resume when settled);
  Telegram standard practice. §8, §11.

---

## Appendix A — quota snapshot (2026-09-17T20:06Z, `agent-os provider-usage`)

| Pool | Headroom | Resets | Notes |
|---|---|---|---|
| `command-code` | 5h 92%, weekly 77%, **monthly credits 39% left** | 5h 21:53Z, weekly 09-22, monthly 10-07 | shared by all commandcode-catalogue routes (incl. Gemini/Luna/Qwen) |
| `opencode-go` | 5h 100%, weekly 75%, monthly 82% | 5h 09-18 00:49Z, weekly 09-21, monthly 10-13 | policy note says dashboard-only; OQ-2 |
| `clinepass` | 5h 99%, weekly 86%, monthly 43% | 5h 09-18 00:36Z, weekly **09-18 10:31Z** (resets soon), monthly 10-03 | policy note says dashboard-only; OQ-2 |
| `zai-glm` | 5h 99% (off-peak; peak window inactive) | 5h 21:35Z | GLM 5.3 Flash fallback pool |
| `antigravity` | Gemini group + Claude/GPT group both ample | 5h 09-18 01:06Z | Gemini 3.8 Flash fallback/balancing |
| `claude` | 5h 100%, weekly 98% | — | not used by this programme's children |
| `codex` | 5h 100%, weekly 54% | — | not used by this programme's children |

## Appendix B — model catalogue matches (`deepseek-v4.1-flash`, pi runtime, live)

| Selector (copy at dispatch) | Provider | Thinking levels |
|---|---|---|
| `commandcode/deepseek/deepseek-v4.1-flash` | commandcode | low, high, max |
| `opencode-go/deepseek-v4.1-flash` | opencode-go | off, high, max |
| `clinepass/cline-pass/deepseek-v4.1-flash` | clinepass | high |
| `openrouter/deepseek/deepseek-v4.1-flash` | openrouter | off, minimal, low, medium, high |

## Appendix C — Phase 1 defect baseline (conductor run, 2026-09-17)

`classifyOperatorUtterance` observed output — the RED evidence Phase 1 must flip:

| Utterance | Observed | Required after fix |
|---|---|---|
| `not sure` | **confirm** (defect) | never `confirm` |
| `sure, but wait` | **confirm** (defect) | never `confirm` |
| `yes, hold phase three` | **confirm** (defect) | never `confirm` |
| `yes` | confirm | confirm |
| `send it` | confirm | confirm |
| `I am not sure` | statement | statement |
| `I said yes earlier` | statement | statement |
| `why did you say yes` | question | question |
