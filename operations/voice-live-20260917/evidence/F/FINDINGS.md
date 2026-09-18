# Track F findings — disposable vertical slice (Phase 5)

Findings produced by wiring the merged kernel (A), the server voice bridge (B)
and the client surface (C) into one end-to-end system and running the three
Phase-5 scenarios against a real Gemini Live operator loop and a real
disposable Pi worker session.

Each finding states what was observed, how it was observed (re-runnable), what
the mount does about it, and who owns the durable fix.

---

## F-1 — Tool acknowledgements scheduled `SILENT` end the turn without speech

**Severity:** high (the talker lane is silent for exactly the utterances where
the declared functions matter).

**Observed:** with `responseModalities: ['AUDIO']` and the contract's two
declared functions, `gemini-3.8-live` answers conversational operator speech by
**calling a tool and ending the turn with no audio and no output transcript**.
`mark_addressed_to_talker` is used for musings ("I keep thinking about the retry
handler"), `offer_ask_worker` for questions — and in both cases the operator
hears nothing. The tool *response* is acknowledged with
`VOICE_FUNCTION_RESPONSE_SCHEDULING = 'SILENT'` (Track B's frozen constant).

**Evidence (direct SDK probe, exact bridge config):**

| Config | Model output for `"I keep thinking about the retry handler."` |
|---|---|
| no `tools` declared | speaks: *"That sounds interesting. What about …"* |
| `tools` + response scheduling `SILENT` (Track B today) | `TOOLCALL mark_addressed_to_talker` → `turnComplete`, **no speech** |
| `tools` + response scheduling `WHEN_IDLE` | `TOOLCALL mark_addressed_to_talker` → **speaks** *"It's certainly been on our minds lately."* |
| `behavior: BLOCKING` + `WHEN_IDLE` | **speaks** *"Is there something specific you're trying to figure out with it?"* then calls the tool |

**What the mount does:** the Phase-5 mount constructs Track B's bridge through
its documented `sessionFactory` seam and wraps the provider session so tool
acknowledgements are re-scheduled `WHEN_IDLE` (see
`withIdleToolAcknowledgements` in `server/src/websocket/voice-live-mount.ts`).
Track B's code, declarations and constant are untouched.

**Durable fix (owner / Track B):** decide where the scheduling belongs — the
bridge option surface (`toolResponseScheduling`), the constant, or the
declarations' `behavior` — and fold the mount's wrapper into it. This is a
parent/Track-B decision, not a mount edit.

---

## F-2 — The generic WebSocket message limiter drops the operator's audio

**Severity:** high (no audio reaches the provider; the lane looks live but the
model never hears anything).

**Observed:** `wsMessageLimiter` allows **60 messages per minute** per client.
A microphone stream is one frame per audio chunk (~50/s at the contract's 20 ms
cadence, ~10/s at the suggested 100 ms cadence), so the limiter answered
`RATE_LIMIT` for most frames and dropped them before routing. Live probe: 80
`RATE_LIMIT` error frames for one 2.7 s utterance; no input transcription.

**What the mount does:** voice frames are exempt from the 60/min budget and
carry their own bounded per-client budget (1200 frames / 2 s = 600/s, far above
a real microphone, far below a flood). The frame is refused with a surfaced
`voice_error` when the budget is exceeded; the generic limiter is unchanged for
every non-voice message.

**Durable fix (owner / platform):** if the voice wire becomes a product path,
fold the voice budget into the shared rate-limit module next to
`wsMessageLimiter` so the two policies live in one place.

---

## F-3 — `offer_ask_worker` is not surfaced by the mount

**Severity:** medium (a capability gap, not a defect).

**Observed:** the model calls `offer_ask_worker` when it cannot answer a
question ("What do you make of the retry handler?"). Track B emits `tool_call`,
and the contract deliberately gives it no wire form. The mount's speech adapter
does not create a kernel offer, so the operator's confirmation of the spoken
offer has nothing to accept; the question can still be relayed by the operator
using a directed instruction (S2's route), which is what the slice exercises.

**Durable fix (owner):** wiring the offer flow (kernel `ops.offerAskWorker` +
`accepted_offer` promotion) is an explicit capability decision under intent
§19.4 — not an implementation convenience — so the mount deliberately does not
add it in Phase 5.

---

## F-4 — A mid-run steer is persisted at the worker's turn boundary

**Severity:** low (evidence-timing, not behaviour).

**Observed:** a steered instruction delivered mid-turn is not visible in the
worker's session store until the running turn reaches its boundary; the delivery
itself is acknowledged immediately (`dispatchMode: "steer"`, HTTP 202) and the
receipt says `delivered`.

**What the runner does:** the byte-fidelity check polls the worker store for up
to 45 s instead of reading once, so the proof is taken from the worker's own
record rather than from the delivery call.
