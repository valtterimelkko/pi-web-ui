# P24 — Make Voice Mode diagnosable: which worker session, and what was actually said

## Why this brief exists

The parent spent roughly a dozen tool calls trying to answer two questions that should
each be one read:

1. **Which worker session is the talker attached to?** The operator said "the session I
   attached it to". Nothing queryable recorded it. The answer was only found by
   `find`-ing every session file modified during the voice turns and inferring from a
   two-minute mtime window.
2. **What did the operator actually say?** The operator asked the parent to "go through
   my exact voice requests". **This was impossible** — their conversational utterances
   are not recorded anywhere durable.

Both are ordinary operator questions about their own system. Neither is answerable today.

## What exists today (verified)

- `server/src/talker/observability.ts` DOES build a rich structured record per turn —
  `utteranceExcerpt`, `phase`, `utteranceClass`, `modelCalled`, `outputChars`,
  `deliveryOutcome`, and the correlation triple
  `voiceTurnId = <runtime:workerSessionId:turnIndex>`.
- But the console formatter prints only `[VoiceMode] voice turn [rt=pi]`. **The fields
  carrying the session id are built and then dropped on the way to the log.**
- The diagnostics ring holds **0 records** for these — they are info-level and the ring
  does not capture info.
- The `GET /api/v1/diagnostics?component=VoiceMode` and `?voiceTurnId=…` queries
  documented in `docs/plans/VOICE-MODE-CONTINUATION.md` therefore return nothing.
- `server/src/routes/client-diagnostics.ts` deliberately carries **no utterance text**,
  and `server/src/talker/history.ts` is **in-memory only**.

So the only durable trace of a voice conversation is whatever was *released* into the
worker session. Conversational turns vanish.

## Required outcome

1. **"Which worker session is Voice Mode attached to?" is one query**, answerable while
   the lane is live: runtime, worker session id, when it was bound, and when its last
   turn was.
2. **A recent voice conversation can be reviewed** — the operator's utterance and the
   talker's reply for the last N turns, bounded and honest.
3. The log line itself carries enough to grep: the session id must be visible in
   `journalctl` without a JSON formatter.

## Design guidance (yours to improve)

- The correlation fields already exist — the cheapest high-yield fix is making them
  reach the visible log line, plus a bounded read that does not depend on log capture.
- Prefer **extending** the existing diagnostics/observability surfaces over adding a new
  store (the repo's established preference — see the `client-diagnostics.ts` header
  comment, which explicitly publishes "extend, do not fork").
- Keep everything bounded: a small ring (turns, not transcripts), length-capped
  excerpts, secret-scrubbed on the same path as every other record.

## Governance — read before recording anything

The operator's own speech is involved, so this is a **decision, not a default**:

- Record the **operator's own utterances** and the talker's replies only — bounded,
  local runtime state. It must never reach the repository, never be committed, never
  leave the machine, and never be exposed to another agent as a channel.
- It must **not** be a relay path: the record is write-only observation. It must not
  feed `takeForRelease()`, must not touch the draft, and must not widen the gate.
- State this choice explicitly in your report so the operator can veto it.

## Owned paths (this child owns the shared registry file this session)

- `server/src/talker/observability.ts`
- `server/src/talker/session-registry.ts`
- `server/src/internal-api/routes/diagnostics.ts`
- `docs/OBSERVABILITY.md`
- new test files under `server/tests/unit/talker/`

**Do not touch** `talker.ts`, `utterance-classifier.ts`, `types.ts`,
`scripts/talker-prompts/v3-harness.txt`, `state-view.ts` or `history.ts` — sibling
children (P22, P23) own those this session.

## Required evidence

- TDD, RED first, ideally reproducing the actual failure: a query something like
  "which worker session is this lane bound to" returns nothing useful today.
- Show the before/after of the log line (today: `voice turn [rt=pi]`; after: it names the
  worker session).
- Prove boundedness (the ring cannot grow without limit) and prove the gate is untouched
  (`release()` still private with one caller; no new path to a release).
- `npm run lint` + ratchet ≤ 326, `npm run typecheck`, suites green.

## Reporting

Report to the parent: the exact query that now answers question 1, what the record holds,
the privacy choice you made, and anything you could not do. **Do not commit.** The parent
reviews, commits and pushes.
