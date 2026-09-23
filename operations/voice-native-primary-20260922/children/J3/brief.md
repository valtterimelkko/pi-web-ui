# Child J3 — correction brief: labelled synthetic-TTS seam for the journey

You are **Child J3** in the Voice Mode native-primary programme. SOLE WRITER in
**`/root/pi-web-ui-wt-voice-tts`** (branch `task/voice-native-tts`, based on current master).
Your session id is in the dispatch prompt.

**Mandatory:** load/follow `agent-os-child`; declare presence:
`npm --prefix /root/agent-os run agent-os -- board quick-declare "J3: synthetic TTS journey seam" --path scripts/voice-lane-lab --path server/tests/voice-live-lab --exclude client/src --exclude server/src --join-session <SID>`
and leave the board before finishing. The goal objective is your durable aim.

## Live evidence (fix-loop pass 3)

H2's host-controlled read-back now runs in the served client, but the automated journey's Chromium
has **no speech synthesis**: the client sends `proposal_presentation {completed:false}` and the
attempt stalls at "waiting for presentation" (C01, C18). The product's honest fallback (card notice)
is correct; an eyes-free automated journey simply cannot hear a real TTS. The input side already has
the sanctioned analogue: `synthetic-stream-source` (a labelled lab fixture feeding the unchanged
product pipeline).

## The outcome that must be true when you are done

1. **`--tts synthetic` journey mode (explicit, default OFF).** When requested, inject a labelled
   `synthetic-tts-source` shim into the page before load (Playwright `addInitScript`) that replaces
   the page's `speechSynthesis` with a deterministic implementation: non-empty `getVoices()`,
   `speak(utterance)` fires `onstart` then `onend` after a small length-proportional delay
   (configurable, default modest), `cancel()` fires nothing further, and **every spoken text is
   logged to a window-scoped array** the runner can read back and record.
2. **Recorded honestly.** The attempt manifest / capture mode must carry the shim marker
   (`synthetic-tts-source`) exactly where `synthetic-stream-source` is recorded, and the runner must
   record each text the shim was asked to speak into the attempt (e.g. under `capture/`).
3. **Verifier asserts the seam's integrity:**
   - if the shim marker is present, the manifest must also declare it (no silent use);
   - every text the shim spoke at read-back time must equal the live proposal's retained `tidied`
     bytes (exact national comparison after the product's own normalisation — use the same bytes the
     client reads back); a mismatch is a FAIL (the seam must not fabricate a read-back of different
     words);
   - the read-back must be attributed to the shim, and the attempt must not claim a rendered-audio
     (E2R/E3) pass.
4. **Default journeys remain unchanged** (no shim unless requested) and the missing-TTS path still
   behaves honestly (presentation incomplete, no fake completion).
5. **Tests, RED-first:** verifier rejects a shim-spoken text that differs from the proposal bytes;
   verifier accepts the exact-bytes case; the runner refuses `--tts` values other than
   `synthetic|real`.

## Gates — exact commands + exit statuses in the handback

```
cd /root/pi-web-ui-wt-voice-tts
NODE_ENV=test npm test --workspace=server -- tests/voice-live-lab
npx tsc -p scripts/tsconfig.voice-lab.json --noEmit
```
Do not run real journeys with the provider except at most ONE confirmation run of
`primary-mic --episode C01 --arm standard --tts synthetic` (it is inside the §10 budget) — paste its
attempt path and verifier verdict. If you run it, note the fresh-build step may take ~40 s.

## Owned paths · NO-TOUCH

Owned: `scripts/voice-lane-lab/**`, `server/tests/voice-live-lab/**`.
NO-TOUCH: `client/**`, `server/src/**`, `shared/**`, `package.json`, `server/tests/unit/pi-ai/**`,
`/root/pi-web-ui` (read-only). A concurrent child (H3) edits `server/src/**` and
`server/tests/unit/**` — never touch those.

## Handback

`/root/voice-native-20260922/coordination/J3/complete.md` (`FROZEN`) + `complete.json`
`{status, files, gates:[{command,exit}], red:[{case,evidence}], uncertainties:[]}`.

## Questions

`/root/voice-native-20260922/coordination/J3/NN-questions.md` + end the turn, `PARENT-INPUT-NEEDED`
last. Never wait or poll. Do not push/merge; never touch production.
