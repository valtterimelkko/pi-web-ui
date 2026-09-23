# Child M4 — product fix: the echo guard must not discard a genuine operator utterance

You are a product-fix child on Pi Web UI. The W4 campaign exposed this defect across every
extended-thinking arm cell; you fix the **product**, RED-first. You own the outcome.

## The defect (real-run evidence, reproduce it at unit level)

Every failed `*-et-high` cell shows the same chain (e.g.
`/root/voice-lane-lab/campaigns/primary-mic-journeys/runs/C01-et-high/attempt-02`):

```
operator_utterance_echo_suspect { reason: 'talker_audio_window', chars: 51 }
talker_tool_call { tool: 'relay_to_worker' }
relay_binding_waited { waitedMs: 2034, arrived: false }
relay_tool_call_refused { reason: 'unbound_source', candidateCount: 0, textExcerpt: 'I want to find out about Pod Point.' }
```

Wire timeline from the same record: the operator's first partial lands at 11.45 s; the et-high
model starts speaking at 12.47 s ("Let me get that over to the worker session for you"); the
operator's **final** transcript lands at 14.87 s — inside the talker's audio window. The guard
(`voice-live-mount.ts` `echoSuspectReason`) suppresses it with `talker_audio_window`, so the kernel
records no operator utterance, the relay's content binding has zero candidates, the relay is refused
as `unbound_source`, and the cell dies "waiting for candidate".

**Standard never hits this** (0 echo-suspect events in C01/C03/C05/C09 standard; 1–2 in every
et-high cell) because the standard model waits for the operator's final transcript before speaking.
The extended-thinking model speaks earlier, so the operator's late-finalising transcript always
lands in its audio window. Without a fix the whole et-high arm measures this guard rather than the
model — the campaign comparison is confounded.

## The fix (principled, narrow, gate-safe)

The guard exists to stop the **talker's own TTS leaking through the microphone** from becoming gate
input — a real protection you must NOT weaken. The discriminator you are missing is *when the
operator actually spoke*, which the host already knows:

- the client sends `voice_activity_state` (`client/src/lib/voiceLive/messages.ts`) and the mount
  already handles it (`noteOperatorSpeech`, `voice-live-mount.ts`) — the operator's own
  speech_start/speech_end window;
- the mount already tracks the talker's audio window (`lane.talkerAudioUntilMs`).

**Rule to implement:** `talker_audio_window` may suppress a final operator transcript **only when
the operator's speech window overlaps the talker's audio window** (mic picks up the talker → VAD
fires inside the talker's audio → echo is plausible). When the operator's speech window ended
**before** the talker's audio began — or never overlapped it — the utterance is genuine operator
speech whose transcript arrived late: it must be accepted as gate input, not discarded.
When the speech window is unknown/absent (no activity frames), keep today's behaviour: suppress.
Keep `operator_speech_active` and the `talker_output_overlap` content backstop exactly as they are
(the content rule is the time-independent protection and stays armed).

You may choose a different but equally principled discriminator if you can show it is at least as
safe (e.g. per-utterance first-partial timing) — justify it, and state the residual risk. What you
may NOT do: blanket-disable `talker_audio_window`, raise a magic timeout, or accept content that
overlaps the talker's own last output.

## Your job

1. **RED first.** Write failing tests that reproduce the real shape: (a) operator speech window
   entirely before the talker's audio; final transcript arriving during the talker's audio →
   currently suppressed, must become accepted gate input; (b) the true echo case: operator VAD
   fires *inside* the talker's audio window (mic picked up the talker), final arrives during it →
   must stay suppressed; (c) no activity frames → unchanged conservative suppression; (d) the
   content-overlap backstop still suppresses a transcript that reproduces the talker's last output.
2. **Implement the rule** in `echoSuspectReason` (and the lane bookkeeping it needs). Keep the
   evidence events honest — if the reason string changes, say what it means; add evidence when the
   new rule accepts a late transcript so the campaign record shows it.
3. **Do not widen the confirmation gate** (`talker/policy-core.ts` out of bounds). The guard's
   protection of the gate must survive every one of your tests; a suppressed-then-accepted
   transcript must still pass the same classification and release predicates as any other final.
4. **Tests + gates.** Run the relevant `server/tests/unit/websocket/**` and
   `server/tests/unit/voice/**` suites plus `npm run typecheck`, `npm run lint`, `npm run build`.

## Boundaries

- **Owned:** `server/src/websocket/voice-live-mount.ts` (guard + lane bookkeeping), and its unit
  tests. If the bridge must surface a signal it does not currently send, you may touch
  `server/src/voice/**` and say so — but prefer using what the mount already receives.
- **NO-TOUCH:** `scripts/voice-lane-lab/**`, `server/tests/voice-live-lab/**`, `client/src/**`
  (the client already sends the activity frames; only touch it if you prove they are absent in the
  lab path and say so in the handback), `operations/**`, corpus/fixtures, `talker/policy-core.ts`,
  production state, `~/.pi/agent`.
- **Do not run the heavy lab harness.** The conductor re-runs the et-high cells as the end-to-end
  confirmation once your fix is merged.
- Work only in `/root/pi-web-ui-wt-voice-m4` (branch `task/voice-native-m4`), commit there, push
  nothing.

## Evidence and handback

`/root/voice-native-20260922/coordination/M4/complete.md` + `complete.json`: the RED evidence
(commands, observed failures), the fix and why it is at least as safe as the old rule (state the
residual risk explicitly), gates with exact results, and anything you could not verify.
