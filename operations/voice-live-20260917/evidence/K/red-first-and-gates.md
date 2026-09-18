# Track K — server safety & honesty corrections: RED-first and gate evidence

Branch `fix/voice-corr-server` (base `4ae2bcf`, which contains master @ `edccdbe`).
Server-only changes. Reviewed findings R §2: H1, H2, M1, M2, M3, M4, M5, M6, M8,
L1, H3-server.

## RED-first

Against the pre-fix source (`git stash push -- server/src`), with the two symbols
added by the fix locally stubbed in the test file:

- `tests/unit/voice/voice-corr-server.test.ts`: **21 of 25 failed** (H1, H2,
  M1, M2, M3, M4, M5, M6, H3-server, L1). The 4 that passed are deliberate
  non-regression guards (F-5 shape, particle kept on ordinary speech, genuine
  returned refusal, generation-bump path).
- `tests/unit/voice/voice-rate-refusal-envelope.test.ts`: **2 of 2 failed**
  (M8; base sent `voice_error` with `laneId: ''` / `generation 0`).

Representative pre-fix failures:

```
H1  expected false to be true                    (no proposal_resolved/replaced)
H2  expected 2 to be 1                           (detached lane retained)
H2  expected 'voice_internal_error' to be 'voice_lane_capacity'
M1  expected [ …(2) ] to have a length of 1 but got 2   (two deliveries)
M2  expected 'refused' to be 'unknown'
M3  expected undefined to be 'req-start'
M4  mount.refreshWorkerStatuses is not a function
M5  expected 'yeah tell the worker to, …' not to match /tell\s+the\s+worker/i
M6  expected [ …(1) ] to have a length of +0 but got 1   (echo released)
H3  expected null to be 'voice_presentation_incomplete'
L1  full bytes present in the logged line
M8  expected 'voice_error' to be 'error'
```

## R's original executable probes, re-run against the fixed worktree

`npx tsx /tmp/rprobe-k/mount-probes.ts` (paths rewritten to this worktree):

```
PROBE1 same-generation retarget: confirm code=voice_confirm_requires_proposal deliveredTo= bytes=[] RETARGETED=false
PROBE2 no-echo/no-presentation confirm: announcedPresentationCompleted=false confirmCode=voice_confirm_requires_proposal deliveries=0 bytes=[]
PROBE3 same-key concurrent confirms: confirmCodes=voice_confirm_requires_proposal/voice_confirm_requires_proposal deliveries=0 releaseRecords=0 reconciliationPending=0
PROBE4 lane table: firstRefusalAtLaneIndex=64 afterDisconnectingAllClients=1 newStartCode=null lanesRetained=1
```

PROBE3 now delivers 0 as well because its confirms carry no identity echo and no
presentation — refused by H3 before the kernel. The M1 exactly-once property is
proven by the dedicated test that supplies both (`deliveries=1`,
`releaseRecords=1`, loser refused).

Relay probe (`/tmp/rprobe-k/relay-probe.ts`):

```
"yeah tell the worker to, um, check the, uh, retry handler" -> "check the, retry handler"
"Please tell the worker, if you would, to check line 10." -> "check line 10."
"Ask it to update the changelog." -> "update the changelog."     (F-5, no regression)
```

## Gates (all after the final refinement)

```bash
cd /root/pi-web-ui-wt-corr-server
npm run typecheck
# EXIT=0

cd server && npx vitest run tests/unit/voice tests/unit/talker tests/regression
# EXIT=0 — 49 files passed | 799 passed | 2 skipped (801)

env -u PI_MAX_SESSIONS -u OPENCODE_ENABLED npx vitest run
# EXIT=0 — 431 files passed | 5355 passed | 2 skipped (5357)
```

`npm run lint` → EXIT=0 (337 warnings, 0 errors; the changed server files add
none).