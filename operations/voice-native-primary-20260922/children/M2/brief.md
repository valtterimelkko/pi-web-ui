# Child M2 — product fix: the kernel utterance pipeline must re-bind after a same-lane restart (soak)

You are a product-fix child on Pi Web UI. The soak harness exposed this defect on a real run; you fix
the **product**, RED-first. You own the outcome, not just the edit.

## The defect (real-run evidence, reproduce it at unit level)

Evidence: `SOAK-10MIN-standard/attempt-02` (harness records under
`/root/voice-lane-lab/campaigns/primary-mic-journeys/runs/SOAK-10MIN-standard/attempt-02`).

The reconnect worked for real: a socket drop, the session stream back, then a **capture-mode lane
restart** — the client sends `voice_session_stop` and a fresh `voice_session_start` with the **same
lane identity and generation**. `laneBack=true` in ~3.6 s, and the revived provider session
transcribed every post-revive operator utterance (all visible in the union wire record: "Yes, send
that." at +20 s, the repeat relay, the repair clarification).

**But the server-side kernel emitted ZERO operator utterance / classification events after the
revive** — the server evidence stops at the pre-reconnect talker reply. Consequences: the spoken
confirm never released the pending proposal `prop-1`, and the repeat relay never produced a
candidate. The pending proposal itself survived on the lane record, so the continuity question is
answered affirmatively up to the confirm gate; the gap is the **transcript → kernel utterance
pipeline not re-binding to the revived provider session**.

## Your job

1. **RED first.** Write a failing test at the mount/kernel level that reproduces the gap: a lane with
   a live pending proposal; a `voice_session_stop` (the capture-mode restart path) followed by a
   fresh `voice_session_start` on the **same laneId and attachmentGeneration**; then a provider
   transcript for a confirm utterance ("Yes, send it.") arriving through the revived session. Assert:
   a kernel utterance/classification event is produced AND the proposal is released. Prove the test
   fails on the current code for the right reason (no kernel utterance after the revive) — not
   because of a harness mistake.
2. **Fix it product-side.** Find where the utterance pipeline binds to a provider session on start
   and why the restart path does not re-bind (candidate area:
   `server/src/websocket/voice-live-mount.ts` — the start/stop routing and the transcript handler
   registration — and `server/src/voice/**`). Make the re-bind happen on a same-lane restart, with
   the kernel's existing state (pending proposals, parked items, presentations) preserved. Justify
   the path in your handback.
3. **Do not widen the confirmation gate.** `talker/policy-core.ts` reachability is out of bounds;
   confirmation classification must behave identically. No protocol-shape changes.
4. **Tests + gates.** Add tests for the fixed behaviour (re-bind on restart; kernel state preserved;
   an ordinary stop with no restart still detaches as before; a fresh lane is unaffected). Run: the
   relevant server websocket + voice unit suites, `npm run typecheck`, `npm run lint`, `npm run build`.

## Boundaries

- **Owned:** `server/src/websocket/**`, `server/src/voice/**`, and their unit tests
  (`server/tests/unit/websocket/**`, `server/tests/unit/voice/**`).
- **NO-TOUCH:** `scripts/voice-lane-lab/**`, `server/tests/voice-live-lab/**` (child L5's live
  paths), `client/src/**` (child M's just-merged surface; only touch it if the fix genuinely
  requires it, and say so in the handback), `operations/**`, corpus/fixtures, production state, the
  registry, `~/.pi/agent`.
- **Do not run the heavy lab harness.** The campaign's own soak cells are the end-to-end
  confirmation once your fix is merged. If you believe a real run is essential, ask the conductor.
- Work only in `/root/pi-web-ui-wt-voice-m2` (branch `task/voice-native-m2`), commit there, push
  nothing.

## Evidence and handback

Write `/root/voice-native-20260922/coordination/M2/complete.md` and `complete.json`:

- the exact failing test (file, name, command, observed failure) before the fix;
- the fix (files, commits) and why this path is correct (where the binding is made and re-made);
- exact commands + results for every gate, quoted honestly;
- what you could **not** verify, stated as unverified rather than implied;
- any product observation the campaign should know.

Honest unsupported outcomes beat a fake pass. If a boundary blocks you, write
`/root/voice-native-20260922/coordination/M2/01-questions.md` and end your turn — the conductor
answers questions rather than losing the round.
