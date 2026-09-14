# P13 — Make client-side voice errors visible (and diagnose the barge-in crash)

## Why this exists

The operator tested Voice Mode in production and **reproducibly got a "full error" on
screen** by starting to speak while the talker was reading aloud. The relay worked
(verified: `released`, 56 bytes, three `VoiceMode` records). Then:

- **Zero server error records. Zero server logs.** The talker turns arrived normally.
- So the failure was **client-side**, where nothing an agent can query ever sees it.

I could read the server's voice observability in one documented query — and the
browser was completely dark. That is the gap to close. The operator's instruction:
make this class of failure visible, then they will re-test.

**Design record:** `docs/plans/VOICE-MODE-OBSERVABILITY-DESIGN.md` (D4 anticipated
client telemetry but accepted the manual bundle as the allowed path — this package
goes further, because a crash is not retrievable from a manual bundle after the fact).
**Doctrine:** `docs/OBSERVABILITY.md`. **Design principle: extend, do not fork.**

## Phase 1 (do this FIRST) — reproduce and root-cause the barge-in crash

You cannot build observability for an invisible failure without a real one. Reproduce
it:

1. Boot a disposable validation server; run the **real UI** (`scripts/voice-mode-browser-e2e.mjs`
   is the existing driver — read it; extend or add your own, but do **not** break it).
2. Produce a **verbose** assistant message, start **read-aloud**, then **press the mic
   mid-playback** (the barge-in gesture).
3. Capture **everything the browser says**: console errors, unhandled promise
   rejections, the error boundary, and the on-screen error text.

Then **name the root cause** with the stack frame or the failing call — most likely a
race in the speech arbiter's ducking path (a chunk ending while a duck arrives, or a
gain node that is already gone). Do not guess: quote the actual error.

## Phase 2 — make that class of failure visible in the diagnostics an agent can query

**The aim: the next time the operator says "it errored", an agent can answer from
records.** Specifically:

- **Client errors of the voice surface reach the server's existing diagnostics ring**,
  so they are retrievable through the same documented path as everything else —
  `component=VoiceMode`-style queries, not a separate tool.
- **At minimum**: uncaught errors and unhandled rejections from the speech surface
  (arbiter, read-aloud, dictation, voice turn), plus the barge-in path specifically.
- **Bounded and scrubbed**: no secrets, no full utterance/reply bodies, no unbounded
  stacks. The ring buffer's existing scrubbing must apply — verify it rather than
  assume.
- **Correlated**: a client error should be attributable to the voice turn / worker
  session where possible, so it joins the server-side story instead of floating free.

**On the wire change:** the doctrine says do not add a wire message or endpoint without
justification. Here the justification is concrete — a client crash is currently
unknowable. **Prefer an existing path if one genuinely exists** (check the manual
browser diagnostic bundle and any client→server upload route first; if there is already
a route, use it). If none exists, a **small, additive, bounded** client-error report
is justified — propose it explicitly in your report as a parent decision, and keep it
minimal.

## Phase 3 — fix the barge-in defect, if the root cause is unambiguous

The operator's expectation is that **barge-in must not error**: plan §4.1 rule 1 says
the operator's speech is never interrupted, and the arbiter was built to **duck** rather
than hard-stop. A crash on barge-in is a defect against that design.

If Phase 1 gives you an unambiguous root cause, **fix it** with TDD (RED first, the same
way you reproduced it) and prove it live. If the cause is ambiguous or the fix would
change designed behaviour, **stop and report** instead — do not paper over it with a
try/catch, and do not silently swallow the error (Phase 2 exists so it is *visible*,
not hidden).

## Invariants — do not soften

- **The release gate is untouched**: `release()` private with one caller,
  `takeForRelease` atomic and staleness-enforcing, no text-composition path.
- **The operator's rules hold**: speech is never interrupted, no utterance is ever
  lost (capture unconditional, only playback scheduled), a receipt ack precedes the
  relay and is never mistaken for a send.
- **Observability observes; it does not alter behaviour.** Phase 2 must not change what
  the surface does — only what it records.
- **No new lint warnings** (ratchet ceiling 1738, currently 1736): check with
  `node scripts/check-lint-ratchet.mjs --base HEAD`.
- **Production is off-limits.** Disposable servers only.

## Owned paths

`client/src/**` (the voice surface, speech arbiter, client telemetry),
`server/src/**` only for a minimal additive ingest path if Phase 2 requires one, their
tests, `docs/OBSERVABILITY.md`, and `scripts/voice-mode-*.mjs` (extend, don't break).

## Evidence you must return

- **Phase 1: the reproduced error, quoted** — the message, the stack, and the exact
  reproduction steps. If you cannot reproduce it, say so plainly; that is a real result
  and it changes the plan.
- The root cause, named, with the failing call.
- Phase 2: **proof that the error is now retrievable via the documented query** — quote
  the retrieved record for the error you reproduced. Retrieval is the point; emission
  alone is not proof.
- Phase 3: RED-first evidence and a live proof, or an honest statement of why it was not
  safe to fix.
- The ratchet result. Suites green. Anything that did not work, stated plainly.

## Do not commit

Leave the work in the tree and report. The parent reviews, commits and pushes.
