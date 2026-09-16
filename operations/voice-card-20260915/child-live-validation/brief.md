# Child brief — W2b: live validation of the card contract on a disposable server

**You are a dispatched child worker.** You own one bounded outcome: prove, live,
that the confirmation-card contract behaves as specified on a real server — with
evidence, not claims. You do not commit, push, or restart anything.

- Programme: `operations/voice-card-20260915/` (read `STATE.md` and
  `WAVE2B-APPROACH.md` first — the approach note is the design for this task).
- Handback: `operations/voice-card-20260915/child-live-validation/complete.md`
  (plus `logs/` and `evidence/`).
- Working directory: `/root/pi-web-ui`. The implementation is already committed;
  you are validating frozen bytes, so **do not edit source** — if you find a
  defect, reproduce it, write the RED evidence, and hand it back.

## 1. What is being validated

The confirmation card's server contract, on the WebSocket seam:

```
talker_turn_result.proposal (phase === 'proposed') = {
  text: string,        // the exact bytes a default Confirm releases
  cleaned: boolean,    // true IFF tidying removed VISIBLE content
  removed?: string,    // the removed FRAGMENTS only (present only when cleaned)
  original?: string    // the raw bytes an original-variant release sends (present only when cleaned)
}
talker_turn.releaseVariant?: 'tidied' | 'original'   // honoured only on the confirm branch
```

## 2. Rows to drive (all of them, with the actual bytes recorded)

Use a **disposable server** (`npm run validate:server`) — never production, never
a restart of any service. Point it at a **local deterministic talker stub** (see
`WAVE2B-APPROACH.md`): the talker client is OpenAI-compatible and env-configured
(`TALKER_BASE_URL`, `TALKER_API_KEY`, `TALKER_MODEL`), so a tiny local HTTP server
answering `POST /v1/chat/completions` with a fixed non-marker reply gives
byte-determinism at zero cost. Do not call a real hosted model.

Create a real pi worker session on the disposable server so the lane has a
delivery target, then drive `talker_turn` over the WebSocket exactly as the
browser does.

| # | Row | Expected |
|---|---|---|
| L1 | Utterance ending in a newline (e.g. `"Proceed.\n"`) — the operator's own reported case | `phase: proposed`; `proposal.text === "Proceed."`; `cleaned: false`; **no** `removed`, **no** `original` |
| L2 | Utterance with a visible tidy (e.g. `"Um, tell the worker to rerun the suite"`) | `cleaned: true`; `removed` = fragments only, never the whole utterance; `original` = the raw utterance |
| L3 | Default confirm after L2 | `released.text` byte-identical to L2's `proposal.text`; the delivery adapter recorded exactly those bytes |
| L4 | `releaseVariant: "original"` confirm after a fresh L2 utterance | `released.text` byte-identical to that turn's `proposal.original` |
| L5 | A **non-confirm** utterance carrying `releaseVariant: "original"` | nothing released (`phase` not `released`); the draft is unaffected |
| L6 | Invalid variant (e.g. `"raw"`) | `INVALID_MESSAGE`; no `talker_turn_result` |
| L7 | Lapsed draft (`maxPendingAgeTurns` turns later) then confirm with `releaseVariant: "original"` | the existing re-confirmation refusal, unchanged — the variant does not widen the gate |
| L8 | Transport regression: `scripts/p27-ws-transport-validate.mjs` (and `scripts/p27-talker-matrix-live.ts --stub-only` if it runs cleanly against the disposable server) | unchanged pass |

For each row record: the exact inbound/outbound WS frames (or the fields that
matter), the observed bytes, the assertion, and PASS/FAIL. An honest
`INDETERMINATE` column is allowed where the harness cannot drive a row; a claim
without the bytes behind it is not.

## 3. Constraints

- **Disposable server only.** Never production, never `systemctl`, never a real
  hosted model. If a row needs the real model, mark it INDETERMINATE and say so.
- No source edits, no git mutations (no commit/branch/stash/reset), no
  `npm run build` at the root (production serves `server/dist`), no service
  changes.
- Clean up what you start: stop your disposable server and the stub, and delete
  any sessions you created **on the disposable server** only.
- Report failures as defects with a reproduction, not as fixes.

## 4. Handback

`complete.md`: status, the row table with observed bytes, the exact commands,
log paths, anything INDETERMINATE with the reason, and a changed-path inventory
(should be empty apart from your evidence directory). Keep it evidence-dense.

## 5. When to ask

Only for a contradiction in this brief, a scope boundary you cannot cross, or a
defect you can reproduce but cannot explain. Otherwise decide, record and move on.
