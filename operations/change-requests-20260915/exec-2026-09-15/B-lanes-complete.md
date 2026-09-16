FROZEN

# B-lanes-complete — W-C/W-D: lane correlation + multi-lane voice in one tab

Branch `task/multi-lane` (base master 7c87147), worktree `/root/pi-web-ui-wt-lanes`.
Commits (oldest first):
- `d6dcd22` voice-lanes: correlate talker results on requestId + lane identity (step 1)
- `35898e2` voice-lanes: lane store state + in-page floor coordinator (step 2a)
- `74d8850` voice-lanes: multi-lane surface — strip, per-lane state, cap ask, overlay wiring (steps 2-3)
- `e2c2f57` voice-lanes: the '+' is reachable from single-lane use (harness finding)
- `56d7d33` voice-lanes: real-browser harness fixes — picker reachable at one lane, wrappers stop intercepting clicks

Not pushed, not merged. Production untouched; the browser harness ran only against a disposable
validation server I started myself (systemd-run scope outside the production cgroup; stopped after).

## What changed (file:line)

### Step 1 — correlation (the lane A card can never appear in lane B)
- `client/src/lib/talkerBus.ts:96-160` — per-lane correlation records keyed on
  `(workerSessionId, normalised runtime)`; `noteTalkerRequestIssued()` (`:153`) generates a client
  correlation id per send (the existing optional `requestId` wire field — no contract change; the
  server already echoes it, `server/src/websocket/connection.ts:4240`); `acceptTalkerResult()`
  (`:162`) rejects: never-issued ids (foreign/stale replay), duplicates, and results OLDER than the
  newest applied (out-of-order). Legacy requestId-less results apply only while nothing is in flight
  and no correlated card exists. Rejections observed in the diagnostic ring (`recordTalkerRejection`,
  `:200` — bounded reason, no text, no ids).
- `client/src/lib/talkerBus.ts:222-281` — lane-filtered `subscribeTalkerTurnResults(listener, lane?)`,
  `getLastTalkerTurnResultFor(lane)` hydration; the unfiltered subscribe/global getter keep working.
- `client/src/hooks/useTalkerTurn.ts:80-117` — generates the id per send (`:86`), optional lane-scoped
  subscription+hydration, so a foreign lane's result never updates this hook's `lastResult`/pending count.
- `client/src/components/DriveMode/useVoiceTurn.ts:230-236` — passes its lane identity; ack intent ids
  session-scoped (`ack-<session>-<utteranceId>`, `:330`) so the shared arbiter can attribute speech.

### Step 2/3 — two/three lanes in ONE tab
- `client/src/store/driveModeStore.ts:20` `MAX_VOICE_LANES = 3`; `lanes` (empty = today's
  single-lane surface), `addVoiceLane` (`:171` — refuses duplicates, refuses a silent fourth with
  `'full'`, seeds the addressed session as lane 1), `replaceVoiceLane` (`:184`, in-place swap),
  `removeVoiceLane` (`:194`, collapses to the single-lane set at one), in-place add flow
  (`openAddLane/cancelAddLane/beginLaneReplace`, `:116-119` — the dictate phase never changes).
- `client/src/components/DriveMode/voiceLanes.ts` (new) — the in-page lane floor: ONE writer for the
  arbiter's operator-floor signal (`setLaneCapture` → `recomputeFloor`; a lane's unmount can never
  release another lane's floor), capture handoff (`yieldFloorTo` `:145`, `finaliseCapture` `:157` —
  the other lane's words are finalised into its own talker, never dropped), speech attribution by
  session-scoped intent id (`laneOfSpeechIntent` `:164`), bounded diagnostic events.
- `client/src/components/DriveMode/LaneStrip.tsx` (new) — per-lane rows with floor state
  (`:104` cap counter "N of 3", `:151` the floor-holding announcement on the other rows — visual
  only, per the owner's decision; no cue tone), one-tap addressing, close per row; collapses to the
  "+" affordance at <2 lanes (`:68`).
- `client/src/components/DriveMode/DriveModeDictate.tsx` — `laneEnabled`/`addressed` props;
  per-lane transcript/streaming from `sessionMessages`/`streamingSessions` (`:80-88`), per-lane
  reading level over the shared persisted default (`:101-113`), lane-scoped read-aloud id,
  intent-id prefix into `useAnswerReader`, non-addressed lanes hidden-not-unmounted (`:249-250`),
  no phase writes from lane surfaces (`:152`).
- `client/src/components/DriveMode/useVoiceTurn.ts:405-432` — lane registration, capture-controls
  registration, floor through the coordinator, and the mic tap as the handoff gesture (`:424`).
- `client/src/components/DriveMode/useAnswerReader.ts:104,279,309` — `intentIdPrefix` option.
- `client/src/components/DriveMode/readingLevel.ts:127-145` — `levelFor`/`setLevelFor` per-lane
  overrides; the persisted single-lane default untouched (not persisted for lanes — lanes are a
  live tab's arrangement).
- `client/src/components/DriveMode/DriveModeOverlay.tsx` — multi-lane render (strip + every lane's
  mounted surface, addressed wrapper z-10, non-addressed wrappers `invisible pointer-events-none`
  `:290`), the add-lane picker and the cap-ask render at the overlay root over BOTH single- and
  multi-lane (`:358`, `:363`) so no lane ever unmounts mid-flow; addressing re-subscribes the other
  lanes (the server's switch_session unsubscribes the old current); at the cap "+" asks
  replace-or-cancel — a fourth lane never appears silently.

## RED then green evidence (TDD)
All new tests were written and run RED before their implementation:
- `client/tests/unit/lib/talkerBus.lanes.test.ts` — RED: `Tests 13 failed (13)` with
  `TypeError: noteTalkerRequestIssued is not a function` (the API did not exist). GREEN after step 1.
- `client/tests/unit/store/driveModeStore.lanes.test.ts` — RED: `Failed Tests 11` (of 13; the 2
  single-lane-identity tests pass against today's store by design). GREEN after the store work.
- `client/tests/unit/components/DriveMode/voiceLanes.test.ts` — RED: collection failure
  (`Tests: no tests`, module absent). One mid-GREEN failure was a wrong expectation of mine
  (tier-4 chatter under a floor is DROPPED by the frozen rule 4, not queued) — the test was
  corrected to pin the frozen behaviour, plus tier-3 queuing. Final: 14/14.
- `client/tests/unit/components/DriveMode/readingLevel.lanes.test.ts` — RED: `Failed Tests 4`.
- `client/tests/unit/components/DriveMode/DriveModeDictate.lanes.test.tsx` — RED: `6 failed | 1 passed (7)`.
- `client/tests/unit/components/DriveMode/DriveModeOverlay.lanes.test.tsx` — RED: `8 failed (8)`; now 9/9
  (added a regression test for the single-lane add flow the harness caught).
- `client/tests/unit/components/DriveMode/LaneStrip.test.tsx` — 10/10; the two collapse tests were
  RED against the strip-returns-null version and amended once, deliberately and narrowly, when the
  harness proved the "+" must exist at one lane (documented below).

**Single-lane identity pin** (`DriveModeDictate.single-lane.test.tsx`) was written BEFORE any lane
surface existed and passed 5/5 against the pre-lane code: no lane rows, no cap counter, no strip
inside the surface, exactly one talker_turn to one session, floor straight to the arbiter, zero
subscription chatter. It still passes (5/5). Its one deliberate amendment: it now also asserts the
collapsed "+" affordance lives at the OVERLAY level, not inside the dictate surface — that
affordance is mandated by the brief ("a '+' that adds a second worker") and is the feature's only
entry point; scheduling/capture/messaging invariants are untouched.

## Harness — the real UI, one page, real Chromium
Command:
```
VOICE_EVIDENCE_DIR=/tmp/lanes-evidence node \
  /root/pi-web-ui/operations/change-requests-20260915/child-voice/harness/one-tab-lanes.mjs
```
(New harness file written in the authorised harness dir; adapted from `two-tab-repro-v2.mjs`.
Disposable validation server + vite dev booted outside the production cgroup: server port 3501,
vite 3503, state dir `/tmp/lanes-srv`, both stopped after the runs.)

Observed result: **ALL 14 VERDICTS PASS** (final run, after the critical-review extensions below),
evidence `/tmp/lanes-evidence/lanes.json` plus 8 screenshots (`01-single-lane.png` …
`06-after-close.png`, including `03b-strip-floor-during-capture.png` and `05b-after-replace.png`):
singleLane.collapse; lanes.two.inOneTab ("2 of 3"); lanes.perLane.surfacesMounted (one visible);
lanes.addressSwitch; capture.unconditional (real getUserMedia→MediaRecorder→/api/dictation, one
recorder, mic shows Stop); floor.noSpeechOverCapture (with capture live, lane B's tier-3 answer
queues and ZERO chunks play); floor.speaksWhenFloorFree; floor.duckNeverStop (0.15 duck observed at
the player wire via an observing player on the page's REAL arbiter; intent stays current); 
floor.tierThenFifo (same tier, B submitted first: B plays, A queues); lanes.three.capVisible
("3 of 3"); cap.fourthLaneAsks (replace-or-cancel, still exactly 3 lanes); strip.floorDuringCapture
(during real capture the capturing row reads "You have the floor" and every other row announces the
floor holder — the objective's display clause, browser-proven); cap.replace.inPlace (choosing
replace swaps the lane for the picked session in place, still exactly 3 lanes — the full
replace-or-choose flow, end to end in-browser); lanes.close.noLeak (no recorder or live mic track
left).

A critical-review pass extended the harness with the last two verdicts (`strip.floorDuringCapture`,
`cap.replace.inPlace`) because the objective's strip-display clause and the replace choice had only
unit-level evidence; the disposable server/vite were rebooted for the run and stopped after.

Two real defects the harness caught and I fixed (jsdom cannot see either):
1. the add-lane picker rendered only in the multi-lane branch — clicking "+" from ONE lane did
   nothing (commit `e2c2f57`);
2. non-addressed lanes' absolute wrappers invisibly covered the addressed surface and intercepted
   its clicks — the mic was untappable at two lanes (commit `56d7d33`).

## Gates — exact commands and exit statuses
```
cd /root/pi-web-ui-wt-lanes
npm test --workspace=client   → exit 0    (1342 passed / 1342, 0 failed)
npm test --workspace=server   → exit 1    (4426 passed, 4 failed, 2 skipped — see below)
npm run typecheck             → exit 0
npm run lint                  → exit 0    (0 errors; 304 warnings, all pre-existing)
npm run build                 → exit 0
```
The 4 server failures are baseline environmental leaks, NOT regressions: my diff contains ZERO
files under `server/` (`git diff 7c87147..HEAD --name-only | grep -c '^server/'` → 0). Exact names:
- `tests/unit/config/pi-max-sessions.test.ts > defaults to 20 when PI_MAX_SESSIONS is unset`
  (the operator shell exports `PI_MAX_SESSIONS=20`; `expected '20' to be undefined`)
- `tests/unit/opencode/opencode-service-expanded.test.ts > refreshModels` (3 cases — this
  environment sets `OPENCODE_ENABLED=false`, so the service throws a different honest error).
Proof: `env -u PI_MAX_SESSIONS -u OPENCODE_ENABLED npx vitest run <those two files>` →
`2 files passed, 34 passed (34)`.

## What I deliberately did not do
- No cross-tab machinery: no BroadcastChannel, no heartbeat, no server-side lane registry, no
  protocol/contract change (the correlation id rides the existing optional `requestId` field).
- No changes outside owned paths: `client/src/components/DriveMode/**`, `client/src/store/driveModeStore.ts`,
  `client/src/lib/talkerBus.ts`, `client/src/hooks/useTalkerTurn.ts`, `client/tests/**`, and the new
  harness file. `speechArbiter.ts`, `useDictation.ts`, `useReadAloud.ts`, `websocket.ts` and all of
  `server/` are byte-identical to base (arbitration is the existing arbiter's tier-then-arrival
  order — arrival order IS the waiting-time fairness §4.4 asks for).
- The 350 ms cue tone: dropped — the owner approved visual announcement over a cue tone.
- Cross-device lanes: dropped by the owner (LANE-SHAPE-DECISION).
- Multi-lane forces the voice-only layout (the desktop split shows one session's pane and cannot
  represent several lanes); adding a lane from split layout requires switching to voice-only.
- The harness observes arbiter scheduling via the two-tab harness's observing-player pattern (so
  evidence is deterministic and independent of live TTS availability); the real TTS capture→speech
  path was not exercised end-to-end in the browser.

## What is not finished
- Lane removal while a lane's proposal card is open closes the flow with the card (the card is
  per-lane component state; removal unmounts that lane). Capture is always finalised first — words
  are never dropped — but an unconfirmed card in the REMOVED lane is discarded by design (the lane
  is being closed). Removing down to one lane remounts the survivor's surface, so its pending card/
  focus state resets at that transition (same for the single→multi transition).
- The strip's per-lane "Waiting to speak" state is derived from the shared arbiter queue; queue
  entries whose ids predate the lane work (none in this codebase) would not attribute.

## Residual risk
- Two lanes pointed at the SAME worker session are refused ('duplicate') — intended (lane identity
  is the session), but if the operator ever legitimately wants the same worker twice this needs a
  product decision.
- Per-lane transcripts rely on the sessionStore's `sessionMessages`/`streamingSessions` projections
  staying fresh for subscribed background sessions (they are the same projections the background-
  sessions feature uses; the harness verified live two-lane behaviour). A long-lived three-lane
  session with heavy streaming could hit the store's cache-eviction limits — untested at scale.
- The mic-handoff gesture finalises the previous lane's partial utterance and relays it to THAT
  lane's talker (stop semantics, words never dropped). If the operator merely wanted to redirect
  mid-sentence, the partial words still go to the first worker — defensible, but it is the one
  judgement call worth the owner's eye.
- `git stash pop` was run by mistake on a clean tree and applied a PRE-EXISTING stash (not mine)
  into files I do not own; I restored those four files to HEAD immediately (`git checkout HEAD --`)
  and left the stash entry itself untouched in the stash list. Final tree == HEAD `56d7d33`
  (`git status` clean, `git diff HEAD` empty).
