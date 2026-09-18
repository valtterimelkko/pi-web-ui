# Track K — server safety & honesty corrections (Wave 3 closeout)

**Role:** correction child. The independent review Track R (`/root/voice-exec-20260917/coordination/R/complete.md`,
review of record) found real defects in the merged implementation. The conductor reproduced
**all four of R's executable probes on `master` @ `edccdbe`** and confirmed the code sites.
Your job: close them **in the server only**, with tests that fail before your fix and pass after.

**Worktree:** `/root/pi-web-ui-wt-corr-server` · **Branch:** `fix/voice-corr-server`
**Base:** `master` @ `edccdbe` (contains contract E, kernel A, audit D, bridge B, client C,
regression G, mount F, rollout H).

**Owned paths (write only these):** `server/src/websocket/voice-live-mount.ts`,
`server/src/websocket/connection.ts`, `server/src/talker/**` (kernel + relay), `server/src/voice/**`
(only if strictly required), `server/src/observability/**` (metrics/sink if required),
`server/tests/**`, and `operations/voice-live-20260917/evidence/K/**`.
**Do NOT touch:** `client/**`, `shared/**`, `scripts/**`, `docs/**` (the conductor owns docs), `operations/**` outside `evidence/K/`.

**Report:** `/root/voice-exec-20260917/coordination/K/complete.md` (never create it before you are done).
Questions: write `NN-questions.md` beside it and put `PARENT-INPUT-NEEDED` in it for a genuine blocker only.

## Findings to close (severity as recorded by R; conductor-verified)

### 1. H1 (HIGH) — never retarget a lane's delivery worker inside one generation
`registerLane` (`voice-live-mount.ts:448-451`) accepts a same-generation `voice_session_start`
naming a **different** `workerSessionId` and silently replaces the lane's target; a pending
confirmation then releases to the new worker. Contract §3.2: "…and **never retargets** … A pending
confirmation therefore cannot silently become a confirmation for a different worker."
Repro (conductor-run): `PROBE1 … RETARGETED=true`, proposal went to W2.
**Required outcome:** the invariant above is enforced. Choose and justify one: (a) refuse the
same-generation worker-session change with an honest refusal code + evidence line; or (b) explicitly
resolve the live proposal (cancel + `proposal_resolved` on the wire + evidence) and *then* retarget.
Test to the shape of probe 1: a proposal created while targeting W1 must never be delivered to W2
silently. Also keep the generation-bump path working (it already cancels the live proposal).

### 2. H2 (HIGH) — bounded lanes must have bounded lifetime
`MAX_VOICE_LANES = 64` (`:236`) and `detachClient` (`:407-423`) stops the bridge and drops the
binding but **never removes the lane record**; the client mints a fresh `laneId` per controller
instance, so 64 page loads permanently exhaust voice until restart. At the cap the refusal is coded
`voice_internal_error` (a capacity refusal mislabelled). Repro: `PROBE4 … afterDisconnectingAllClients=0
newStartCode=voice_internal_error lanesRetained=64`.
**Required outcome:** lane records are reclaimed after client disconnect (a short grace window is
fine) so ordinary lifecycle can never exhaust the table; kernel state (proposals/receipts) stays
kernel-owned as today; at a genuine cap the refusal carries an honest capacity code (additive
catalogue entry if your code catalogue needs one — comment the addition). Tests both ways.

### 3. M1 (MEDIUM) — exactly-once under concurrent confirms sharing an idempotency key
`policy-core.confirm` checks `hasIdempotencyKey` against a store only written after delivery
resolves; concurrent frames (fire-and-forget handlers) can both pass and deliver twice. Repro:
`PROBE3 … deliveries=2 releaseRecords=1`.
**Required outcome:** the check-then-act window is closed (reserve the key atomically at confirm
time, or serialise confirms per lane+key). Two concurrent confirms sharing a key deliver **exactly
once**; the loser gets a duplicate refusal and never a `delivered` receipt/evidence. Test
concurrently (probe 3 shape) and keep the existing same-proposal replay tests green.

### 4. M2 (MEDIUM) — honest receipts: `unknown` must be reachable
`server/src/talker/types.ts` `DeliveryOutcome` has no `unknown`; the mount maps everything through
`toReleaseOutcome`/`buildReceipt` (`:180-196`, `:916-947`), so a delivery that throws **after
submission** (timeout/transport) is recorded `refused` — contract §4.4/§7.3 says a timeout after
submission is not a refusal, and N6 demands honesty.
**Required outcome:** the mount can emit the contract's `unknown` outcome (with
`reconcile: true` where the contract specifies it); genuine refusals still `refused`; the kernel's
reconciliation path is reachable. Extend the server-side types (`talker/types.ts`) as needed — no
`shared/**` change. Tests: post-submission throw → `unknown` + reconciliation evidence.

### 5. M3 (MEDIUM) — `requestId` echo
Contract §3.3: the server echoes `requestId` on every message answering a request. `server/src/voice/**`
and the mount have **zero** references; the client mints/tracks ids and its un-issued-id guard can
never fire; `controller.pendingRequests` grows unboundedly.
**Required outcome:** echo `requestId` on answering frames (at minimum: lane start ack, parking list,
confirm result). Tests. (The client-side guard already exists — do not change `client/**`.)

### 6. M4 (MEDIUM) — worker-status context injection must actually be wired
`injectContext` (`voice-session.ts:438`) has **no production caller**; the mount knows worker
busy-state (`isWorkerBusy`) but never forwards it. Plan Phase 3 task 5 / intent §18.4: worker
busy-state is structured context given to the talker **every turn**, not something it guesses;
provenance defence for `CURRENT STATUS: RUNNING`.
**Required outcome:** worker lifecycle/busy-state changes are injected into the lane, coalesced,
and suppressed while the operator is speaking. Tests: a lifecycle change produces one coalesced
update; nothing is injected while `speechActive`; the update carries structured status.

### 7. M5 (MEDIUM) — the commission channel must not reach the worker on lead-in shapes
`relay-normalise.ts` + `COMMISSION_FRAME_REMOVAL` are head-anchored, so
`"yeah tell the worker to, um, check the, uh, retry handler"` and
`"Please tell the worker, if you would, to check line 10."` reach the worker **verbatim**
(P25 failure class: channel-laden text that made a worker dispatch sub-agents). F-5's shape
(`"Ask it to update the changelog."`) is already stripped — do not regress it.
**Required outcome:** extend the mechanical strip for lead-in particles and polite interpolations so
the released bytes are the operator's instruction, not the channel. Test corpus of these shapes,
plus the F-5 counterexample.

### 8. M6 (MEDIUM) — echo/self-transcript exclusion on the native path
Final operator transcripts are consumed as gate input unconditionally (`:1048-1090`); the talker's
own TTS is in the room, so ordinary acoustic feedback transcribing as a confirmation-shaped
utterance while a proposal is live could release it.
**Required outcome:** final operator transcripts arriving while the talker is speaking
(`speechActive`) or within a short documented window after talker audio are ignored for gate
purposes (and labelled echo-suspect in evidence rather than silently dropped). Tests.

### 9. M8 (MEDIUM, server half) — envelope-faithful rate refusals
The budget-refusal `voice_error` is sent with `laneId: ''` / `attachmentGeneration: 0`
(`connection.ts:925-938`) when the offending frame lacked an envelope; the client rejects that as
malformed, so the "your frame was dropped for rate" notice is silently discarded.
**Required outcome:** refusals carry an envelope the client accepts (echo the offending frame's
lane/generation when available; define and test the truly-absent case). Track L makes the client
tolerant as well — your job is the server side.

### 10. L1 (LOW) — evidence log hygiene
The default sink `createLogEvidenceSink` (`:1198-1202`, wired in production) writes full instruction
bytes (`bytes`, `relayText`, `original`) while the observability contract says released text is
logged as a ≤120-char scrubbed excerpt ("full text is never logged").
**Required outcome:** pick the contract-compliant rule (excerpt + scrub) and implement it; tests.

### 11. H3-server (HIGH) — the confirm rule must be enforced server-side
Three verified defects:
(a) `proposal_created` announces `presentation: { completed: false }` but the mount never **seeds**
`lane.presentations` from it — the gate only fires if the client happens to volunteer a report
(`:783-794`);
(b) `identity = request.proposalRef ?? { version, sha256 }` (`:797`) fabricates the identity from
the live proposal, so a typed confirm with **no echo** can never fail (contract §4.3: a release
requires one currently **presented** proposal, identity-bound). Repro: `PROBE2 … announcedPresentationCompleted=false
confirmCode=null deliveries=1`;
(c) the spoken path (`:1108-1130`) bypasses presentation by construction.
Intent §18.2 gives the rule: a composed draft is "read back in full before confirmation", and for
the spoken flow **that spoken read-back itself constitutes the presentation**.
**Required outcome:**
- Seed the announced presentation state; a release requires the proposal to be **presented**.
- Typed/card path: a confirm without the `proposalRef` echo is refused (contract §4.3) — no
  fabrication; a confirm before a completed presentation report is refused
  `voice_presentation_incomplete`.
- Spoken path: the talker's spoken read-back of the draft (observable as the talker's output after
  creation, matching the draft) is the presentation signal; a spoken confirm arriving **before**
  that read-back is refused. Implement it defensibly (fuzzy/token overlap is acceptable), comment
  the rule with the intent citation, and test both orderings.
- Negative control: confirm-before-read-back refuses on both paths.
Track L wires the client so the read-back genuinely plays and reports completion after playback —
your server must already enforce correctly against today's client.

## Gates (run them; report exact commands + exit codes in the handback)

```bash
cd /root/pi-web-ui-wt-corr-server
npm run typecheck                                      # repo root
cd server && npx vitest run tests/unit/voice tests/unit/talker tests/regression
env -u PI_MAX_SESSIONS -u OPENCODE_ENABLED npx vitest run   # full server suite
```
Every finding above needs a failing-before/passing-after test (RED-first where practical) — state
for each finding which test proves it. Do not weaken or delete any existing test. Do not run
`npm install` anywhere (the worktree is already isolated; use it as-is). Commit on
`fix/voice-corr-server`; do not push (the conductor merges).

**Handback:** `coordination/K/complete.md` with: per-finding status (closed / not closed + why),
the proof test for each, exact gate commands + exit codes + counts, any deliberate deviation, and a
short "what I would still want a human to look at" list. Honest gaps beat confident prose.
