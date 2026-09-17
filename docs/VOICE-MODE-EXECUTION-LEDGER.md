# Voice Mode — multi-agent execution ledger (live)

> **Class:** conductor's live execution ledger — strategy, checkpoint and progression
> record for the multi-agent execution of
> [`VOICE-MODE-EXECUTION-PLAN.md`](./VOICE-MODE-EXECUTION-PLAN.md).
> **Status:** READY, NOT STARTED — owner decisions recorded 2026-09-17 (§11); awaiting the owner's Goal Engine activation.
> **Rule of this file:** current state, not a completion claim — read before acting.
> **Owner start signal:** the operator initiates this session's Goal Engine; until
> that happens this file is planning only and **no child is dispatched and no
> worktree is created**.
>
> **Companions** (do not override them): the execution plan (authoritative plan and
> gates), [`VOICE-MODE-INTENT.md`](./VOICE-MODE-INTENT.md) (intent, N1–N9) and
> [`VOICE-MODE-ARCHITECTURE-RECOMMENDATION-2026-09.md`](./VOICE-MODE-ARCHITECTURE-RECOMMENDATION-2026-09.md)
> (architecture of record, D1–D7; where plan and recommendation differ on
> sequencing, the recommendation governs the decision and the plan governs
> execution).
>
> Conductor session: `01a0b0ef-ab27-7359-867b-6aa4a17a6d11` (pi CLI, cwd
> `/root/pi-web-ui`). Last updated: 2026-09-17 (planning; owner decisions recorded).

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
