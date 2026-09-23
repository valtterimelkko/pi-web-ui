# Child M5 — product fix: the echo window is armed by AUDIO, not by text

You are a product-fix child on Pi Web UI. Child M4's fix removed the first et-high confound; the
campaign's re-run exposed the next one, and the evidence localises it precisely. You fix the
**product**, RED-first.

## The defect (real-run evidence, reproduce it at unit level)

`C01-et-high/attempt-03` (`/root/voice-lane-lab/campaigns/primary-mic-journeys/runs/`), after M4:

```
10.8s operator_utterance_late_final_accepted   (t1 accepted — M4's fix works)
13.4s proposal_created prop-1 / presentation_reported 13.8s
14.6s director speaks t2 "Yes, send that."      (after its quiescence wait)
21.9s operator_utterance_echo_suspect { reason: 'talker_audio_window', speechOverlap: 'overlaps', chars: 15 }
```

The confirm is dropped as echo, so no release fires and the cell fails "deadline exceeded waiting
for release". The geometry:

- the talker's **audio** (egress chunks, real-time 20 ms chunks) ran 11.90–13.07 s and then went
  silent for 9.3 s — **no talker audio was playing at 14.6 s**;
- the talker's **transcript final** landed at 14.2 s;
- `voice-live-mount.ts:1514` arms `talkerAudioUntilMs = now + echoSuppressionWindowMs` on
  **both** `audio_out` **and** talker `transcript` events (`DEFAULT_ECHO_SUPPRESSION_WINDOW_MS =
  1_000`);
- so at 14.6 s the window was armed purely by the 14.2 s *transcript* → the operator's speech
  window was flagged `overlappedTalkerAudio` (line ~1656) → M4's conservative branch suppressed the
  genuine confirm 7 s later.

Echo is *audio in the room*: the operator's microphone can only pick up the talker's voice while the
talker's audio is actually playing. A text event is not acoustic evidence.

## The fix

Arm the echo window from **audio** (`audio_out`), not from talker transcript events — or, if you can
show some engine path emits talker transcripts with no `audio_out` events at all, keep a strictly
weaker fallback for exactly that case (e.g. arm from a transcript only when no `audio_out` was seen
for that utterance) and say so. Everything else stays:

- `operator_speech_active` first check — unchanged;
- the operator's own speech window decides (M4): suppress when the window overlapped the
  **audio-armed** window or is unknown; accept a genuine late final otherwise;
- the `talker_output_overlap` content backstop — unchanged and still armed for accepted finals;
- `talker/policy-core.ts` and the confirmation gate — untouched (an accepted final passes the same
  classification and release predicates).

## Your job

1. **RED first.** Reproduce the exact shape: talker audio ends; a talker transcript arrives 1 s
   later (arming today's window); the operator's confirm speech window starts after the audio but
   inside the transcript-armed window; its final arrives later → today it is suppressed
   `talker_audio_window` + `speechOverlap: 'overlaps'`; after the fix it must be accepted as gate
   input. Plus the cases that must NOT regress: true echo (operator VAD open while talker audio is
   playing → suppressed), unknown window (suppressed), content-overlap backstop, and a
   transcript-with-no-audio path if you keep a fallback.
2. **Implement** in `server/src/websocket/voice-live-mount.ts`. Keep the evidence honest: if the
   meaning of `speechOverlap` or the window changes, the record must still say why a suppression
   held.
3. **Tests + gates.** `server/tests/unit/websocket/**` + `server/tests/unit/voice/**`, then
   `npm run typecheck`, `npm run lint`, `npm run build`. State the residual risk explicitly.

## Boundaries

- **Owned:** `server/src/websocket/voice-live-mount.ts` + its unit tests. If an engine path must be
  verified, read `server/src/voice/**` (read-only unless you can prove a change is required).
- **NO-TOUCH:** `scripts/voice-lane-lab/**`, `server/tests/voice-live-lab/**`, `client/src/**`,
  `operations/**`, corpus/fixtures, `talker/policy-core.ts`, production state, `~/.pi/agent`.
- **Do not run the heavy lab harness** — the conductor re-runs the et-high cells.
- Work only in `/root/pi-web-ui-wt-voice-m5` (branch `task/voice-native-m5`), commit there, push
  nothing.

## Evidence and handback

`/root/voice-native-20260922/coordination/M5/complete.md` + `complete.json`: RED evidence (commands,
observed failures), the fix and why it is at least as safe as the old arming rule (state the
residual risk), exact gate results, and anything unverified.
