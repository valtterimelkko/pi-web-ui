# "The talker does not have access to the session" — an unloaded session read as an empty one

**Date:** 2026-09-18 · **Commit:** `0c4ba97` · **Deployed:** 15:14:39Z (same day)

**Operator report, minutes after the full-session-brief deploy:**

> *"I was asking it if it can summarise what the worker had been doing. It was attached to a worker session and it
> told me it was an existing one … but basically the talker told me it does not have access to the session."*

## What the journal said

`journal-failing-lane.txt` — lane `01a0a575-7d40-7494-847d-2f42042c7759:vl-1-zze18jkx`:

| event | what it carries |
|---|---|
| `worker_status_injected` | `{"workerActivity":"idle"}` — the status line, and nothing else |
| `operator_utterance` | *"Tell me what do you think is the the most significant of the of the work that the worker has done here?"* |
| `talker_reply` | *"I don't have access to the worker's session history to see what work has been done, but I can ask the worker for you."* |
| *(absent)* | **`worker_brief_injected`** — the lane was never handed any of the work |

`worker_brief_unavailable` count over the window: **0**. Nothing failed; the brief was *empty*.

## Root cause

A worker session is loaded into the Pi manager **lazily**. `TalkerSessionRegistry.buildSnapshot` read only
`manager.getAgentSession(id).messages`, so a session that is idle, evicted, or post-restart presented as an **empty**
conversation — while the very same session file was complete on disk and the UI displayed it perfectly well (the UI
reads the file). The talker was not lying; it had been told nothing.

The worker: session `01a0a575-7d40-7494-847d-2f42042c7759`, runtime `pi`, cwd `/root/si`, `messageCount` 540, file
5.63 MB, not loaded in memory.

This also explains why the earlier live validation passed while production did not: that check ran through the shipped
composition with a brief *handed to it* — it never faced an unloaded session.

## Fix

- **`server/src/talker/session-file-history.ts`** (new) — stream the session file ONCE, keep the newest conversation
  entries while counting every one (so the total stays exact and the truncation disclosure stays honest), reusing
  `parsePiSessionHistory` — the same interpretation of a session file the browser replay uses — with tool results and
  raw thinking excluded.
- `buildSnapshot` falls back to it **only** when the in-memory session holds no messages, via the **same**
  `resolveWorkerSession` resolver the relay's load-on-demand dispatch already used.
- **Cached by the file's own version**: the worker-status poll runs every second, so an unchanged file costs one
  `stat`; a changed file is re-read rather than served stale.
- Every failure degrades to the previous honest view — never to an invented conversation.
- **Observability:** `worker_brief_empty` records a lane given a status line and *nothing* about the work. This
  incident was diagnosable only by noticing which event was **missing**; that is now a positive record.
- **The wiring itself is now a tested unit.** The ~12-line closure in `connection.ts` that maps a snapshot to the
  lane's brief — where this report was actually decided — had no test: the composition beneath it was covered, but
  the mapping in between was only visible by reading the code. It is now
  `server/src/websocket/worker-brief-source.ts` (`createWorkerBriefSource`), covered by
  `server/tests/unit/websocket/worker-brief-source.test.ts`, including the unloaded-session case.

**Other runtimes are unaffected and were checked.** Claude is already disk-aware
(`hasDirectSession` → `existsSync(sessionStore.getFilePath(...))`, `loadSessionHistory` → `sessionStore.loadHistory`),
so its view of an unloaded session was never empty. The pi path was the outlier; this brings it to parity.

## Proof

`dist-path-check.txt` — **the shipped artifact itself** (`server/dist`, the JS the running process executes), real
session registry resolver, real `TalkerSessionRegistry`, real brief policy, with the worker session absent from
memory:

```
DIST: entries=162 total=162 mode=full chars=49046
EXIT=0
```

`dist-wiring-check.txt` — the same, driven through the **shipped wiring unit** `createWorkerBriefSource` rather than
reproducing the mapping by hand, so the last untested link is covered too:

```
WIRING: activity="worker status: idle" entries=162 total=162 mode=full chars=49046
EXIT=0
```

`real-session-read.txt` — the same session through the source composition: 162 conversation messages of the file's 540
entries (tool results are correctly excluded), 59 ms, retrieval `matches=13 searched=162`.

49,046 characters is ~12k tokens, comfortably under the measured ceiling, so the talker now holds the session's
**whole** conversation rather than a status line.

`gate-results.txt` — typecheck 0 · lint ratchet 324/326 violations 0 · lint 0 errors · `test:coverage` exit 0
(shared 9 / server 440 / client 146 / mcp 8) · docs gates 0 · CI run 35358663175 success 6m26s.

## Tests

- `server/tests/unit/talker/session-file-history.test.ts` (10) — user/assistant only, oldest-first, exact total when
  the bound bites, corrupt/interrupted line tolerated, missing/empty/non-file invents nothing, huge-line and
  >window files bounded, newest entries preserved.
- `server/tests/unit/talker/session-registry-disk-history.test.ts` (6) — the disk fallback end to end, plus
  **read-once caching** under repeated polling and **re-read on change**, and "a resolver that fails invents nothing".
- `server/tests/unit/websocket/voice-live-mount.test.ts` — the `worker_brief_empty` evidence assertion.
- `server/tests/unit/websocket/worker-brief-source.test.ts` (6) — the wiring: the on-disk conversation of a session
  this server is not holding in memory, the `pi` runtime and deeper source tail, the count travelling with the
  entries, no `entries` key when there is no conversation, nothing invented for an unresolvable session, and a
  registry failure left to surface so the mount can still record `worker_brief_unavailable`.

## Not proven here

**Live-lane confirmation is still outstanding.** The operator's lane had already detached (15:14:34) before the
restart (15:14:39), and no lane has started since, so the deployed behaviour has not yet been observed on a real
lane. Everything above is the shipped code driven directly; the operator is retesting the same session, and the
journal will then show either `worker_brief_injected` with real `briefChars`, or `worker_brief_empty` — in which case
this is a miss and the diagnosis reopens.
