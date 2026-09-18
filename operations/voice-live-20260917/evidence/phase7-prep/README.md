# Phase 7 prep — the composed browser ↔ server loop, run for real

This directory is the conductor's self-test of the Phase 7 disposable slice
(`scripts/voice-mode-dogfood.sh`): the first time the **real browser surface**
(track C/L: AudioWorklet capture, the lane surface, the arbiter) has been driven
against the **real composed server** (track B/K/F mount + voice service) with the
**live engine enabled** (`VOICE_MODE_ENGINE=gemini-live`).

## What was run

1. `bash scripts/voice-mode-dogfood.sh` — disposable server on `:3097` with the
   live engine and `ALLOWED_ORIGINS=http://localhost:3499`, plus the Vite client.
   Verified before use: the child process really carried
   `VOICE_MODE_ENGINE=gemini-live` and the client origin (`/proc/<pid>/environ`),
   and the server logged `Allowed origins: http://localhost:3499, http://127.0.0.1:3499`.
2. A Pi session was created through the disposable server's Internal API
   (`deepseek/deepseek-v4-flash`, cwd inside the slice's workspace).
3. `composed-loop-probe.mjs` (Chromium, fake media) logged in, entered Voice Mode,
   continued that session, expanded the **native voice lane**, and pressed
   **Start listening**.
4. Observed, client-side (`composed-loop-result.json`):
   `wireState: "live · worker idle"`, `listening: "Listening — open mic. Talking
   over the talker ducks it; it never stops you being heard."` — no `unavailable`
   state, so the live bridge genuinely started (a failure would surface the
   server's own reason there).
5. Observed, server-side (slice log): a stream of `voice_audio_chunk` frames from
   the client, then `lane_send_unbound` + `lane_detached` when the browser closed
   — the disconnect teardown path, exercised for real.
6. Teardown: `Ctrl-C`-equivalent SIGTERM to the script ran the slice's own
   cleanup (kill the client pid, then the validation server's stopper); the
   stopper recorded `stopped-by-stopper; group verified gone`, both ports freed.

## Why this matters

Review R recorded (finding M7 / Gate-5 coverage limit 1) that the Gate-5 slice
drives a scripted WebSocket client, so "the composed browser↔server loop has
never run against the composed server". This run closes that specific gap for the
browser path, on the exact slice the operator will use for Phase 7.

## What it does not prove

No audio was *heard* (headless Chromium, fake microphone); conversational
quality, pacing, ducking and real-ear honesty remain the operator's Phase 7
verdict. This is preparation evidence, not acceptance.

## Files

| File | Meaning |
|---|---|
| `composed-loop-probe.mjs` | the exact probe (Chromium + fake media) that drove the loop |
| `composed-loop-result.json` | its observed states + the step log |
| `composed-loop-live.png` | the surface at `live · worker idle` after Start listening |
