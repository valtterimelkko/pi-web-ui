# P27 — Comprehensive live validation of the talker's function surface

## Context

Voice Mode has shipped a large function surface across ~20 packages (P1–P26). Each
package was validated when it landed, but no single run has exercised the CURRENT,
combined surface end-to-end. The operator asked for a comprehensive, autonomous
validation of the talker's functions, live, against real sessions — with evidence,
not claims.

## The matrix to cover (all of it)

**Classification (server/src/talker/utterance-classifier.ts)**
1. confirm shapes: bare yes/ok/go ahead; pushback ("just do it, stop asking"); selection ("just the second one")
2. cancel shapes: "no", "never mind", "cancel it", "don't send that", and a cancel + new instruction in one breath (residue capture)
3. question vs statement; worker-directed question ("could you ask the worker to X"); meta-send question ("did you send it?")

**The gate (pending-proposal.ts, talker.ts)**
4. release ONLY on confirm + live draft; nothing pending -> mechanical dead end; stale confirmation -> re-confirm with verbatim quote
5. release() private, single caller — verify, do not modify
6. draft supersession holds both; subset selection by ordinal releases exactly that part

**Semi-verbatim relay (relay-normalise.ts, P25 — newest, least battle-tested)**
7. commission frames stripped ("tell/ask the worker to/if", "pass this on"); hesitation fillers; stutters; leading markers
8. conservative cases LEFT IN: mid-sentence frames, "if" interrogative force, "very very", frame-only utterances untouched
9. PRIMARY INVARIANT live: the released bytes equal the bytes the card was shown
10. clean instruction passes through byte-identical, changed=false
11. ask-worker offer path holds the question in relay form too

**Markers (P22, P18)**
12. [[to-talker]]: self-service answered, not drafted; tag never spoken; buried tag ignored (utterance still drafted)
13. [[ask-worker]]: offered only when the talker cannot answer; stripped before speech

**Receipts + honesty (§4.1)**
14. one receipt ack per relay batch, never per utterance; mechanical acks (nothing-pending, nothing-to-cancel) fire without a model call

**History + state view (P20, P23)**
15. earlier-turns answers from real history; the worker's own messages get the 2200-char window; disclosure line truthful including shortening

**Observability (P24)**
16. every turn produces a VoiceMode record; the log line names the worker session; the lane-binding query answers; ?voiceConversation=<n> returns bounded turns and is OPT-IN (absent by default)

**Client surface (drive the browser or the WS protocol the UI uses)**
17. confirmation card: cleaned=true says "tidied" + shows what was removed; cleaned=false claims exact words and shows nothing (no crying wolf)
18. Confirm / Cancel / typed-text all behave; Cancel actually clears the card (P25-era regression risk)
19. reading levels switch mid-answer without repeating content; stop talker doesn't re-speak a cancelled answer

## How to validate — the established pattern

- Disposable server: `npm run validate:server` (see scripts/validation-server.ts).
  NEVER production. Do not restart production or any shared service.
- Reference existing live-validation scripts before writing new ones:
  scripts/talker-history-live-validate.ts, scripts/live-validate.ts, scripts/ws-validate.mjs,
  scripts/talker-drop-proxy.mjs (fault injection).
- A REAL pi session as the worker where the path needs one; a stub/null model where
  determinism matters. Say which you used for each row.
- Where a browser is genuinely needed, the audio lab's browser lane exists
  (scripts/audio-lab) — but the WS protocol path is preferred for logic; do not
  rebuild browser automation that already exists.

## Evidence, per row

A pass/fail table with, for each row: what you drove (exact utterance/inputs), what you
observed (the actual relayed text / reply / record), and where the artefact lives. A row
is FAIL only if you can reproduce it; indeterminate is an honest column, not a fail.

## If you find a real defect

Fix it ONLY if the cause is unambiguous and the fix is narrow (TDD, RED first). If the
cause is unclear or the fix would be broad, document it precisely (repro, expected,
actual) and leave it for the parent. **Do not commit. Do not restart production or any
shared service.** Report to the parent with the table + any diffs.

## Model note

You are running as zai/glm-5.3-flash. Work autonomously end to end; do not wait for
parent input unless genuinely blocked.
