# Voice relay robustness — the lost instruction (2026-09-16)

Operator report, in two parts, both about Voice Mode:

> "one of the things that is not useful is the talker summarising me what the
> worker has captured … I do not need to know what they have captured. But I was
> trying to find out from the worker … it took me a while to kind of get that out
> of it."

> "I sent an instruction to be relayed to the worker … I pressed accept, send it
> to relay … the voice mode front-end told me that it was sent, it was all green
> … but the talker itself said I couldn't send that. So I don't know if it worked
> or not."

## What was actually true (evidence, not inference)

The instruction **was not relayed**. Three independent records agree:

| Evidence | Finding |
|---|---|
| Worker session file `/root/.pi/agent/sessions/--root--/2026-09-16T08-08-17-026Z_01a0a942-…jsonl` | untouched since **10:12:17Z**; nothing was appended at 10:44 |
| Server voice-turn ring (diagnostics route) | turn 2 = `"yes, send that"`, `phase: "released"`, **`deliveryOutcome: "refused"`**, reply `"I couldn't deliver that — it has not reached the worker."` |
| Disposable-server reproduction (below) | the same flow refuses with `Session … does not exist` when the worker is not loaded |

## Root cause

Pi keys sessions by **path** and loads them **lazily**. The relay resolved the wire
session id to a path only against the **loaded** set (`MultiSessionManager.resolveSessionRef`),
then prompted by that reference. Nothing is loaded after a restart — and the
production restart at **10:42:21Z** landed mid-session — so the prompt threw
`Session <id> does not exist`, the delivery adapter reported `refused` honestly,
and the operator's instruction was lost.

A second, independent defect turned that refusal into a lie on screen: the
released-relay banner was **green with the heading "Sent to the worker:" for every
outcome**, refusal included.

A third defect made the incident undiagnosable: the refusal reason was recorded
only as a bound log field, and the pretty renderer prints correlation fields only
(measured: `deliveryError` appears **zero** times in the journal for the whole
day), while the in-memory voice ring omitted the reason — and dies with the
process anyway.

## Fixes

1. **Relay loads the worker it needs** (`server/src/talker/delivery.ts`,
   `session-registry.ts`, `websocket/connection.ts`). The pi delivery gains
   `ensureReady`/`release`: it resolves the id through the server's own session
   registry (the index the Internal API uses), rehydrates from disk with the
   same `subscribeClient` path every client uses, delivers, and hands the load
   back. A worker already in memory is left exactly as found.
2. **The front-end tells the truth about delivery**
   (`client/src/components/DriveMode/DriveModeDictate.tsx`, `useVoiceTurn.ts`).
   The banner is driven by the server's outcome: green *"Sent to the worker"*
   only for `delivered`, blue *"Queued for the worker"* for `queued`, amber
   **"NOT sent to the worker — it did not reach it"** with the reason for
   `refused` (and for an older server that reports no outcome). A refused relay
   now keeps the operator's words with a **Try again** path instead of looking
   sent.
3. **The refusal reason is readable** (`server/src/talker/observability.ts`).
   The release journal line states the outcome — and the reason when refused —
   and the conversation ring carries `deliveryError`.
4. **Housekeeping is not news** (`scripts/talker-prompts/digest.txt`,
   `scripts/talker-prompts/v3-harness.txt`). The talker no longer narrates
   routine memory-capture/recall machinery, and describes the substantive work
   instead. Paid for inside the prompt's existing leanness ceiling by tightening
   prose; the gate rules are untouched.

## Validation

**Unit / integration (all red first):**

- `server/tests/unit/talker/delivery.test.ts` — 5 adapter tests (load before the
  busy check, no reload of a loaded worker, steer without release, honest
  refusal when the load fails, release even when the prompt throws) + 3 wiring
  tests against a real manager shape.
- `server/tests/unit/talker/observability.test.ts` — the reason lands in both
  the release line and the ring.
- `client/tests/unit/components/DriveMode/DriveModeDictate.test.tsx` — sent vs
  queued vs **NOT sent**, and the refused relay stays recoverable.
- `server/tests/unit/talker/prompt.test.ts` / `digest.test.ts` — the
  housekeeping rule is in both prompts.
- Suites: server **4500/4500**, client **1379/1379**, typecheck clean, lint
  ratchet 318 ≤ 326 with no violations.

**Live, on a disposable validation server** (`harness/boot.sh`, ports 3531/3532 —
never production). `harness/relay-restart-probe.mjs` drives the real browser seam
(cookie login → `/ws` → `talker_turn`), seeds a worker session, restarts the
disposable server so nothing is loaded, then dictates and confirms:

| Run | Delivery | Worker transcript |
|---|---|---|
| **Before the fix** (stashed) | `refused — Session 01a0a9e0-… does not exist` | nothing appended; `mtime` unchanged |
| **After the fix** | `delivered (prompt)` | the instruction is in the worker's own transcript **and the worker answered it** |

Journal lines from those two runs, which is what the operator's incident could
never show:

```
voice release pi:01a0a9e0-…:2 — refused: Session 01a0a9e0-… does not exist [rt=pi]
voice release pi:01a0a9e6-…:2 — delivered [rt=pi]
```

`harness/digest-probe.mjs` puts the same worker turns through the real
`talker_digest` seam with the old and the new prompts (`evidence/digest-probe.json`):

| Case | Before | After |
|---|---|---|
| Capture turn only (Summary) | "…Two candidates were extracted and saved as pending, specifically cand-3v2h6l8qnb and cand-3v2kditwcp. The evidence was written to a markdown file…" | "Just housekeeping that turn — nothing for you." |
| Capture turn only (Headlines) | "Done: session-end memory capture and evidence saved. Needs you: nothing." | "Done: nothing new — housekeeping. Needs you: nothing." |
| Capture then real work | leads with the capture, work second | leads with the work, ends with the decision waiting on the operator |
| Plain work | unchanged | unchanged |

## Follow-ups worth the operator's attention

- **A restart mid-voice-session is still a hard stop for anything in flight**
  (a pending proposal dies with the talker session). The relay no longer loses
  instructed text, but the deploy drain check counts busy sessions only —
  `voiceMode.lanes` in `/diagnostics` is the signal that a voice session is live.
  Worth adding to the restart wrapper's pre-flight.
- **Marking routine injections** where they are produced (Agent OS) would let the
  server skip bookkeeping structurally instead of asking the model to judge it.
  That is the next lever if prompt-level filtering proves insufficient.
