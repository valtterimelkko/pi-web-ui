# Brief B — native voice bridge (plan Phase 3 = Track B)

**Session:** assigned at dispatch. **Worktree:** `/root/pi-web-ui-track-b` (branch `feat/voice-bridge`, based on master **after the wire contract merges**). **Runtime:** pi. **Model:** assigned at dispatch (deepseek-v4.1-flash pool rotation); thinking `high`, `max` if advertised.

## Bounded outcome

The **server-side native voice service** (`server/src/voice/`): a productised Gemini Live bidirectional-streaming bridge with PCM transcoding, session resumption, worker-status context injection, and the wire-contract service boundary — client-neutral, key server-side only, unit-tested, with a real live handshake probe.

## Read first

- `docs/plans/VOICE-LIVE-WIRE-CONTRACT.md` **— the frozen contract; your service boundary and message names come from it. Do not diverge; a needed divergence is a `PARENT-INPUT-NEEDED` question.**
- `docs/VOICE-MODE-EXECUTION-PLAN.md` Phase 3 (your tasks and gate).
- `docs/VOICE-MODE-INTENT.md` §17–§19 (provenance, structured context, allowed operations) and §20 (capture modes).
- `docs/VOICE-MODE-ARCHITECTURE-RECOMMENDATION-2026-09.md` §4.1, §4.5, §4.7.
- `scripts/voice-live-lab/lib/providers/gemini-live.ts` — the reviewed adapter to **productise** (interfaces `LiveConnectRequest`, `LiveSessionFactory`, `LiveCallbacks`, `GeminiLiveCallbacks` incl. `onResumptionHandle`, `onGoAway`, `onToolCall`). Copy/adapt into `server/src/voice/`; do not edit the lab file.
- `server/src/talker/*` — how the kernel exposes proposals/releases (read-only reference; do not edit).
- `server/src/websocket/*` — the authenticated transport your handler plugs into (read-only; Phase 5 wires it).

## Deliverables (owned: `server/src/voice/**`, `server/tests/unit/voice/**`, `server/package.json` — only to add the `test:voice-handshake` script)

1. `server/src/voice/gemini-live-bridge.ts` — connect/lifecycle for `@google/genai` (already a dependency at 1.52.0): open, `setupComplete`, send/receive, resumption handle capture, `goAway` handling, seamless reconnect, close. API key from server env (`GEMINI_API_KEY`) — **never logged, never sent anywhere but the provider**.
2. `server/src/voice/audio-transcoder.ts` — client 16 kHz mono PCM in, provider 24 kHz PCM out, and the reverse for playback bytes; explicit format/mime handling; bounded buffers + backpressure; corrupt/oversized chunks dropped safely.
3. `server/src/voice/voice-session.ts` — the contract's service interface: start/stop, audio feed, typed event emission, **context injection** of worker/status state (coalesce updates ≥2 s apart; suppress while operator speech is active), lane/attachment generation carried from the client messages.
4. `server/src/voice/types.ts` — internal types; **client-neutral** (no window/DOM/browser-lifecycle references).
5. Unit tests (`server/tests/unit/voice/`): bridged-mock WebSocket lifecycle incl. unexpected disconnect, corrupted chunks, latency spikes; transcoder round-trips and bounds; resumption handle reuse across reconnect; coalescing/suppression of context injection.
6. `test:voice-handshake` npm script in `server/package.json` running a real probe: connect → `setupComplete` → send ~1 s of audio → receive a valid transcription delta → close. Reads the key from server env; prints no secrets.

## Anti-cheat requirements

- Unit tests mock the socket; **the handshake probe must be real** (no fixture/dry-run masquerading as live). Report the provider usage/counters it produces.
- No client bundle may contain the key: add a check (grep of built client assets or a test) proving it.
- Do not weaken or skip anything to pass; a suite with 0 executed tests or skips fails.

## Gate 3 (run and record)

```bash
npm --prefix /root/pi-web-ui-track-b/server test -- tests/unit/voice/
npm --prefix /root/pi-web-ui-track-b/server run test:voice-handshake
```

Exit 0 for both; paste the handshake's key output lines (transcription delta observed; no key material).

## Constraints

- Owned paths only. **NO-TOUCH:** `server/src/talker/**`, `server/src/websocket/**`, `server/src/index.ts`, `shared/**`, `client/**`, `scripts/voice-live-lab/**` (the lab file is a reference — do not edit it), docs.
- Preserve cookie/origin/CSRF protections where you touch transport-adjacent code (you should not need to); input validation on every client message (shape + size limits).
- N1–N9 unchanged; the bridge may never provide a send path to the worker.

## Stop protocol

Blocked or a contract conflict → `/root/voice-exec-20260917/coordination/B/01-questions.md`, print `PARENT-INPUT-NEEDED`, end turn.

## Handback

Commit on `feat/voice-bridge`. `/root/voice-exec-20260917/coordination/B/complete.md`: outcome; changed-path inventory; gate commands + observed results (handshake output included); the provider's live-usage evidence; `FROZEN` marker. Declare on the agent-os board; leave the entry on completion.
