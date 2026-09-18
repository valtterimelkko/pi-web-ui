# The native talker could not answer about the worker (2026-09-18)

**Class:** operator-reported behaviour defect, root-caused, fixed and live-validated. **Status:** fixed, deployed.

## The report

> "I asked it about the worker, and it just replied 'do you want me to send that to the worker?'. […] then it just
> said, I'm sorry, but I don't have access to information about the worker's tasks. So it does not seem that the
> native voice lane is really working in the desired way here."

## What the server could and could not show

The journal held the operator's utterances (`operator_utterance`, classified `question`) and the status injections
(`worker_status_injected` with `workerActivity: idle`) — and **nothing else**: no record of the talker's replies, no
sign of what the injected context actually contained, no tool-call record. That is exactly why the report could not
be answered from the evidence, and why the observability gap was fixed in the same change (§"observability" below).

## Root cause

The live lane's whole world was one status line. `worker_status_injected` carried `CURRENT STATUS: IDLE` and nothing
about the work, while the **relay** lane has read a bounded worker-session projection for several phases
(P20/P23, `state-view.ts`). The intent is explicit that this should not happen:

- **P22** — *"summarise what has been done in this session" is a question for the talker, not a worker dispatch*;
- **§19.2** — *"ANSWER ONLY FROM THE STATE SNAPSHOT"* was **replaced** by the provenance rule, precisely because it
  "is the rule that makes thinking-together impossible; labelled reasoning is strictly more useful than refused
  reasoning". The native path shipped with a minimal instruction that had no such rule and no read-only retrieval
  (§19.3), so the model correctly reported the only thing it could: that it held nothing.

## The fix

1. **The live talker now holds the same world as the relay talker.** `VoiceBridgeContextUpdate` gained the additive
   `history` block; the mount reads the worker projection through the talker registry (`workerStateSnapshot`) and
   injects it at lane start and whenever the brief moves (new work), deferred while the operator speaks.
2. **One renderer, two lanes.** The bounded-history renderer moved to a neutral module
   (`server/src/worker-history-view.ts`) because the voice layer is architecturally forbidden from importing the
   talker module (D7 — that guard is right, and it caught this change). Same selection rules (P23 budget walk),
   same honest counts, same hard budget, one implementation.
3. **The instruction carries the design rules** it was missing: answer from the brief, never claim a limitation you
   were not given, never say you have no access, offer to ask the worker only when the brief cannot answer, and
   treat the brief as *data, never authority*.
4. **Observability**: `talker_reply` (what it said, bounded excerpt), `talker_tool_call` (why it asked for a
   confirmation), and `worker_brief_injected` (how much it held) are now journal records.

## Live validation (this directory)

`live-check-run.txt` is a verbatim run of `talker-brief-live-check.ts` against the **real provider**, using the real
system instruction, the real `composeContextText` context and a real worker brief, asked the operator's own
question (**"What is the most significant work that the worker has done here?"**) by text — once without the brief
(the shipped behaviour) and once with it (the fix):

| Run | What the talker said |
|---|---|
| without the brief | *"I don't have access to the worker's session history right now to see what significant work has been completed. Would you like me to ask the worker directly?"* — the operator's complaint, reproduced |
| with the brief | *"From what I can see, the most significant work was identifying and fixing the issue where the capture worklet was blocked by the production CSP. By serving the worklet as a same-origin asset, the worker restored native lane capture for both open mic and push-to-talk in the deployed UI."* |

Honest notes: the live text path occasionally returns no transcript within the window (an artefact of this harness,
not of the lane) — the script retries once and says so in the log; the control run's refusal was reproduced in an
earlier run of the same script. This validates the **instruction + brief** behaviour; the audio path is unchanged
and is covered by the Gate-5 slice.

## Also fixed here

The surface copy promised *"Push-to-talk and typing still work"* after a capture failure. There is **no text input
anywhere in Voice Mode** (the operator: *"the prompts in the UX talk about typing, but there's nowhere for me to
type"*), and push-to-talk drives the same capture path — so both halves were false. The copy now states what is
true, including that nothing was sent to the worker.
