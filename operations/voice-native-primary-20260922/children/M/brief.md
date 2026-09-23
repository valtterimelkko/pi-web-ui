# Child M — product fix: worker switch must resolve the pending proposal (C24)

You are a product-fix child on Pi Web UI. Child L5 built the harness that exposes this defect; you
fix the **product**, RED-first. You own the outcome, not just the edit.

## The defect (conductor-grounded, reproduce it yourself)

A pending proposal (live confirmation card) must never silently become a confirmation for a
different worker — the H1 guarantee, contract `docs/plans/VOICE-LIVE-WIRE-CONTRACT.md` §3.2/§4.2.

The server has the machinery: `server/src/websocket/voice-live-mount.ts`
`resolveLiveProposalForWorkerChange()` (≈ line 773) cancels the live proposal and sends
`proposal_resolved { outcome: 'replaced' | 'cancelled' }`; it is called from `registerLane()`
when a lane is re-attached to a different worker (both the same-generation retarget and the
generation-bump branch).

**But the Drive Mode picker's switch never goes through a lane re-attach.** The real flow is:

- `client/src/components/DriveMode/DriveModeOverlay.tsx` `handleSwitchLane()` →
  `laneFloor.finaliseCapture()` + `beginLaneReplace()`;
- `client/src/store/driveModeStore.ts` `replaceVoiceLane()` swaps the lane's session **in place**.

So the old lane is never re-registered with the new worker, `resolveLiveProposalForWorkerChange`
never fires, and no retirement frame reaches the client. Observed by the harness (C24
attempts 01–02, with a multi-page wire-union capture ruling out an evidence artefact): the real
picker switch executes, the pending proposal is never retargeted, the talker acknowledges
audibly — **but no `proposal_resolved {outcome: replaced|cancelled}` frame is ever delivered**,
so the cancel-before-retarget guarantee is unevidenced on the wire.

## Your job

1. **RED first.** Write a failing test that reproduces the gap at the level you choose
   (unit/integration on the client store + surface, and/or the mount): after a picker switch that
   replaces a lane's worker while a proposal is live, the live proposal must be resolved with
   `replaced`/`cancelled` and the frame must be delivered to the lane's socket. Prove the test
   fails on the current code for the right reason (not a test bug).
2. **Fix it product-side.** Choose the minimal, contract-correct path and justify it in your
   handback. Candidates (decide from the contract, not from convenience):
   - the client re-attaches/re-registers the lane with the new worker (same laneId) so the
     server's worker-change path fires and the frame is emitted; or
   - the server resolves the live proposal when a lane's worker changes or the lane
     stops/detaches on a switch, emitting the same frame.
   Whatever you choose: the proposal must not be retargeted, the frame must reach the lane's
   current socket binding, and a later confirm must never apply to the new worker.
3. **Do not widen the confirmation gate.** Never change what counts as a confirmation
   (`talker/policy-core.ts` reachability is out of bounds). No protocol shape changes beyond the
   frozen contract; keep diffs minimal.
4. **Tests + gates.** Add tests for the fixed behaviour (resolution frame delivered; no retarget;
   confirm-after-switch cannot target the new worker; ordinary switch with no live proposal is
   unaffected). Run: the relevant server websocket unit suites, the client DriveMode suites,
   `npm run typecheck`, `npm run lint`, `npm run build`.

## Boundaries

- **Owned:** `server/src/websocket/**`, `server/src/voice/**`, `client/src/components/DriveMode/**`,
  `client/src/lib/voiceLive/**`, `client/src/store/driveModeStore.ts`, and their unit tests
  (`server/tests/unit/websocket/**`, `client/src/**/*.test.ts(x)`).
- **NO-TOUCH:** `scripts/voice-lane-lab/**`, `server/tests/voice-live-lab/**` (child L5's live
  paths), `operations/**` (conductor), `scripts/voice-live-lab/corpus/**`, any fixture or corpus
  wording, production state, the registry, `~/.pi/agent`.
- **Do not run the heavy lab harness** (browser + audio journeys). The conductor sequences those;
  the campaign's own C24 cells will be the end-to-end confirmation once your fix is merged. If
  you believe you need one, ask the conductor instead of running it.
- Work only in your worktree `/root/pi-web-ui-wt-voice-m` (branch `task/voice-native-m`), commit
  there, and push nothing.

## Evidence and handback

Write `/root/voice-native-20260922/coordination/M/complete.md` and `complete.json`:

- the exact failing test (file, name, command, observed failure) before the fix;
- the fix (files, commits) and why this path is contract-correct;
- exact commands + results for every gate you ran, quoted honestly (no paraphrase of a failure);
- what you could **not** verify, stated as unverified rather than implied;
- any product observation the campaign should know (e.g. other paths that change a lane's worker).

Honest unsupported outcomes beat a fake pass. If you cannot fix it without crossing a boundary,
write the question file `/root/voice-native-20260922/coordination/M/01-questions.md` and end your
turn — the conductor answers questions rather than losing the round.
