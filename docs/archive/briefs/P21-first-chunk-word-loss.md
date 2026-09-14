# P21 — Words are being clipped at the start of speech

## The symptom

The operator reports the talker is **"eating a few words"** at the beginning — heard
while using Summary with a mid-session attach, so at least on the first utterance of a
read. They also report **pauses** during longer reads.

## The bounded outcome

**Every word of the text submitted is spoken, including the first ones, with no
audible clipping at the start or at chunk boundaries.**

1. **Establish the cause before fixing it.** Candidates to test, not guess: the first
   chunk played before the audio context is ready or resumed; the first chunk
   truncated in synthesis; overlapping/racing chunk playback where a later chunk
   starts before the earlier finishes; a pause/duck interaction at the start.
2. **Quote the actual defect** — the code path, or the reproduced behaviour — rather
   than applying a plausible-looking fix.
3. **The pauses are in scope too**: if chunks are stitched with an audible gap, say why
   and fix it, or report precisely what you could not fix and why.

## Rules

- **Do not renumber or change the tier model.** `speechArbiter.ts` is **read-only**;
  work within it.
- **Capture is never gated** and the operator's speech is never interrupted; barge-in
  keeps ducking.
- **P17 reading levels, P18 focus, P19 whole-turn digest must not regress.**
- **No new lint warnings** (ceiling 326).
- **Production is off-limits**; reproduce on a disposable server or in the browser
  harness (`scripts/voice-mode-barge-in-e2e.mjs` is a starting point).

## TDD

A test that FAILS on the current code and pins the guarantee: the full submitted text
is played, first word included, with chunk boundaries that do not swallow words. If the
defect is genuinely not unit-testable (audio timing), say so plainly and provide the
reproduction instead.

## Evidence

Exact commands; the reproduction and the quoted defect; RED evidence or an honest
statement that it could not be reproduced headlessly; the full client suite; the
ratchet result; anything that did not work.

## Owned paths

Client speech playback: `client/src/components/DriveMode/useAnswerReader.ts`,
`client/src/hooks/useReadAloud.ts`, the audio/TTS client path, their tests.

## Do not commit

Leave the work in the tree and report. The parent reviews, commits and pushes.
