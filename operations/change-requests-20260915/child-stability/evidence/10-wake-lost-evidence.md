### Run 5a62bf6c receipt (verbatim)
```json
{
  "runId": "5a62bf6c-dbfd-45d5-9fa4-9d66bcd7600f",
  "sessionId": "01a0a410-f683-7422-bc57-055af50db3f2",
  "runtime": "pi",
  "executionInstanceId": "pi-local-default",
  "mode": "follow_up",
  "dispatchMode": "prompt",
  "status": "failed",
  "acceptedAt": "2026-09-15T08:36:09.437Z",
  "liveness": {
    "activityPolicyVersion": "run-activity-v1",
    "idleTimeoutMs": 900000,
    "absoluteTimeoutMs": 21600000,
    "cessation": {
      "state": "unknown",
      "basis": "watchdog",
      "observedAt": "2026-09-15T08:51:10.383Z"
    },
    "watchdog": {
      "reason": "idle",
      "decidedAt": "2026-09-15T08:51:10.383Z",
      "idleTimeoutMs": 900000,
      "absoluteTimeoutMs": 21600000
    }
  },
  "idempotencyExpiresAt": "2026-09-16T08:36:09.437Z",
  "idempotencyKeyDigest": "986b9d97ab7bf179a26a9d0bd4fe343ed77b65d2b92d0b86e73f2284ecf9ba52",
  "requestFingerprint": "ee6fe784276b98a10174d3e8a7c1796535bff27465712549fea4db6b3bcff0d3",
  "startedAt": "2026-09-15T08:36:09.457Z",
  "servedModel": "deepseek/deepseek-flash",
  "modelRebound": false,
  "errorCode": "TURN_STALLED",
  "terminalAt": "2026-09-15T08:51:10.383Z",
  "outputEvidence": {
    "policyVersion": "run-output-v1",
    "source": "normalized-events-v1",
    "assistantMessages": 0,
    "assistantTextBlocks": 0,
    "assistantTextChars": 0,
    "toolCalls": 0,
    "disposition": "unknown"
  }
}```

### journal: dispatch + the runtime-ownership fence (08:35:55-08:36:30)
```
2026-09-15T08:36:09+00:00 docker-ce-ubuntu-4gb-hel1-2 pi-web-ui[2164396]: [InternalAPI] Watch wake dispatched: runtime=pi target=01a0a410-f683-7422-bc57-055af50db3f2 dispatchMode=prompt runId=5a62bf6c-dbfd-45d5-9fa4-9d66bcd7600f [req=req_2d8704d9-4801-4dc3-9855-3ab68a8473e0 run=d3854f61-6d3e-438a-9617-613258b7081e sid=01a0a42e-e8c7-7422-bc57-0562a081bbea rt=pi exec=pi-local-default]
2026-09-15T08:36:09+00:00 docker-ce-ubuntu-4gb-hel1-2 pi-web-ui[2164396]: [MultiSessionManager] Rehydrating session from disk: /root/.pi/agent/sessions/--root-pi-web-ui--/2026-09-15T07-56-10-243Z_01a0a410-f683-7422-bc57-055af50db3f2.jsonl [req=req_2d8704d9-4801-4dc3-9855-3ab68a8473e0 run=d3854f61-6d3e-438a-9617-613258b7081e sid=01a0a42e-e8c7-7422-bc57-0562a081bbea rt=pi exec=pi-local-default]
2026-09-15T08:36:09+00:00 docker-ce-ubuntu-4gb-hel1-2 pi-web-ui[2164396]: [auto-compact-75] Ownership: conflict (pid 2142860, tui) [2026-09-15T07-56-10-243Z_01a0a410-f683-7422-bc57-055af50db3f2.jsonl] — session is owned by another live runtime (pid 2142860). This runtime is fenced; run /autocompact75 handoff in the current owner first.
2026-09-15T08:36:09+00:00 docker-ce-ubuntu-4gb-hel1-2 pi-web-ui[2164396]: [MultiSessionManager] Session rehydrated: 01a0a410-f683-7422-bc57-055af50db3f2 [req=req_2d8704d9-4801-4dc3-9855-3ab68a8473e0 run=d3854f61-6d3e-438a-9617-613258b7081e sid=01a0a42e-e8c7-7422-bc57-0562a081bbea rt=pi exec=pi-local-default]
```

### journal: the watchdog decision
```
2026-09-15T08:51:10+00:00 docker-ce-ubuntu-4gb-hel1-2 pi-web-ui[2164396]: [RunReceiptManager] Run 5a62bf6c-dbfd-45d5-9fa4-9d66bcd7600f stalled: idle timeout exceeded
```

### /capacity after the event (quarantinedRuns=0 => the drain released the slot)
```
{
  "activeTurns": 0,
  "stalledRuns": 6,
  "quarantinedRuns": 0,
  "control": {
    "inFlight": 1,
    "queued": 0
  }
}
```

### parent session 01a0a410: no wake message ever arrived
```
2026-09-15T08:35:02.930Z  type=message  role=assistant  All four watches rehydrated active. Re-dispatching the interrupted children with re-anchoring 
2026-09-15T08:35:04.433Z  type=message  role=toolResult  W2b -> d6ba1bbc-676f-415a-92be-07f3e08883e6 accepted handoff -> 806f8aae-5d1a-4601-b3d6-262d1
2026-09-15T08:35:04.433Z  type=message  role=toolResult  pi-web-ui.service: State 'stop-sigterm' timed out. Killing. pi-web-ui.service: Killing proces
2026-09-15T08:35:12.386Z  type=message  role=assistant  
2026-09-15T08:35:12.388Z  type=custom  role=-  
2026-09-15T08:35:12.442Z  type=message  role=toolResult  === in-repo restart paths === server/src/systemd-watchdog-worker.ts scripts/opencode-refresh-
2026-09-15T08:35:12.442Z  type=message  role=toolResult  Goal is wrapping up: supervising four dispatched children (card-contract W2b live validation,
2026-09-15T08:35:16.724Z  type=message  role=assistant  
2026-09-15T08:35:16.783Z  type=message  role=toolResult  9: * report that loop's death — when the loop stalls the ping simply stops 11: * restarted un
2026-09-15T08:35:16.783Z  type=message  role=toolResult  Sep 15 08:29:58 docker-ce-ubuntu-4gb-hel1-2 pi-web-ui[1596898]: [MultiSessionManager] Memory:
2026-09-15T08:36:03.819Z  type=message  role=assistant  
2026-09-15T08:36:03.838Z  type=custom  role=-  
2026-09-15T08:36:09.722Z  type=custom  role=-  
2026-09-15T08:36:09.785Z  type=custom  role=-  
2026-09-15T08:36:13.837Z  type=message  role=assistant  
2026-09-15T08:36:14.101Z  type=message  role=toolResult  === commits in last 3h === 2026-09-15 08:26:20 +0000 0798661 fix(voice): the card stops cryin
```

Zero 'user' entries in 08:35-08:36: the wake text never entered the session.
