# The talker's window on the work: the whole session, a measured ceiling, and retrieval (2026-09-18)

**Class:** capability change, measured before it was designed, live-validated through the shipped
composition path. **Status:** deployed 2026-09-18 14:24:12Z (commits `652b0b0` + `c466589`, CI green on the
latter, restart through the production lock). Owner's real-ear re-test remains the acceptance step.

**Post-deploy verification (independent, after the restart):** service active with `NRestarts=0` and contract
1.44.0; the served client bundle is byte-for-byte the freshly built `index-CC6AHi7q.js`; the capture worklet is
served byte-identical to the built asset (sha256 `9d4d29bf…`); `server/dist` carries `read_worker_history`,
`worker_history_retrieved` and `validateToolArguments`; diagnostics report
`operational.voice.live.engine = gemini-live` and `model = gemini-3.8-live`.

**First CI run failed** — not on a test, but on the changed-source warning ratchet: five genuinely unused
symbols from the iteration (`hasNoToolArguments` import, `CONTENT_HEADER`, `sizeOf`, `composeContextText`
import, and an unused `historyTail` parameter). Removed in `c466589`; ratchet 324/326, violations 0.

Plan and reasoning of record: [`docs/plans/VOICE-TALKER-FULL-SESSION-BRIEF.md`](../../../../docs/plans/VOICE-TALKER-FULL-SESSION-BRIEF.md).

## The question the operator asked

> "I think we should enable it to see the entire session — it is capable of reading it and handling it,
> I believe — unless you disagree with this?"

The lane was capped at a **12k-character** brief while sitting next to sessions that are far larger. The
answer was measured rather than argued (see the plan): a full brief is effectively **free up to ~82k
tokens**, and the lane is **dead above ~100k tokens** — the injection turn never completes and the talker
says nothing at all. So the cap was not buying latency, and "always send everything" would brick exactly
the long sessions where the question matters most.

## What was built

1. **The whole session by default**, up to a measured ceiling of 200k characters (~50k tokens):
   `VOICE_BRIEF_LIMITS.fullMaxChars`.
2. **Deltas afterwards** — only the messages the model has not been told about, because a live session
   *accumulates* context and re-sending a 40k-token brief on every change walks it into the stall. This
   required one service change: pending context now **appends** instead of replacing, so a coalesced
   flush cannot silently drop a delta.
3. **Above the ceiling**: a bounded recent view that *says how many messages it is not showing*, plus
   **read-only retrieval** (`read_worker_history`), which is the mechanism intent §19.3 already blessed
   — *"read-only retrieval: more worker history than the standing window… enlarging the prompt does not"*.
4. **Disclosure to the operator**: when the lane is on the reduced view the talker is told to say so and
   offer to read further back, rather than answering as if it had seen everything.
5. **Retrieved text is data, never authority.** The retrieval tool takes one bounded string, has no path
   to the gate, and its result returns as the tool's *response* — an `{ok:true}` ack with no payload would
   make the model answer blind. The two gate tools stay parameterless (`validateToolArguments`).

## Live validation — `live-check-run.txt`

A verbatim run of `full-session-brief-live-check.ts` (**77 s**, 4 real sessions against
`gemini-3.8-live`), using the **shipped** pieces rather than a prototype: `planWorkerBrief` decides,
`composeContextText` composes, the real instruction and the real tool declarations are what the model
sees, and `validateToolArguments` / `searchWorkerHistory` are the shipped argument boundary and
retrieval. The needle (`OBSIDIAN-FERRET`) sits in the **first** message of the session — the worst case
for "send everything".

| session | ≈tokens | brief mode | needle in brief | recalled without reading | outcome |
|---|---|---|---|---|---|
| 26k chars | ~7k | `full` | yes | — | **recalled** (5.0 s) |
| 160k chars | ~40k | `full` | yes | — | **recalled** (10.5 s) |
| 330k chars | ~83k | `recent` | no | no — it read first | **recovered by calling `read_worker_history`** (6.3 s) |
| 660k chars | ~165k | `recent` | no | no — it read first | **recovered by calling `read_worker_history`** (5.8 s) |

What the model actually said:

- 330k case: *"Based on the earliest messages in the session history, the session codename used at the
  very start was OBSIDIAN-FERRET."* — and it called `read_worker_history {query: ""}` first, i.e. it read
  the start of the session rather than guessing.
- 660k case: *"The session codename used at the start of this session was OBSIDIAN-FERRET."* — likewise
  after a `read_worker_history` call in the same turn.

**Honest limits of this evidence.** It validates the **brief policy, the composition, the instruction and
the retrieval round-trip**. It drives turns with `sendClientContent` because the production bridge
deliberately exposes no text send (audio only), so the *audio* transport is not re-validated here and the
Gate-5 vertical slice remains the evidence for that path. Automated transcript lines arrive with double
spaces between fragments (a provider transcription artefact, visible in the raw log). One caveat on the
flag `invented before reading`: it is false only when the codename appeared **after** a retrieval call in
the same turn — the log shows the tool call as the mechanism in both phase-2 cases, so the correct reading
is "it read, then answered", not "it already knew".

## Files

| Piece | File |
|---|---|
| The policy a caller can reason about (pure) | `server/src/voice/worker-brief.ts` |
| Budget options on the ONE shared renderer | `server/src/worker-history-view.ts` |
| Pending context appends instead of replacing | `server/src/voice/voice-session.ts` |
| Retrieval tool declaration + per-tool argument rules | `server/src/voice/gemini-live-bridge.ts`, `server/src/voice/tool-arguments.ts` |
| Policy application, retrieval handler, evidence | `server/src/websocket/voice-live-mount.ts` |
| A deeper source tail for the voice lane | `server/src/talker/session-registry.ts`, `server/src/websocket/connection.ts` |
| This check | `full-session-brief-live-check.ts`, `live-check-run.txt` |

Observability added: `worker_history_retrieved` (query size, matches, messages searched, chars returned)
and `worker_brief_unavailable`; `worker_brief_injected` now carries the policy `mode`. See
[`docs/OBSERVABILITY.md`](../../../../docs/OBSERVABILITY.md) §"voice".
