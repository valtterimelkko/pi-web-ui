# P7 — Close the Phase 5 validation findings

## Context

`docs/plans/VOICE-MODE-VALIDATION-RESULTS.md` is the acceptance evidence for the
Voice Mode harness. It **passed** the criteria that matter (7/7 relays byte-equal
against the worker's own transcript; the permission gate shown failing red-first),
and it also recorded **one integration gap and two model-level findings**. This
package closes them.

**Read first:** the results document — especially §7 (findings), §8 (gaps) and the
A11 row of the §9 table. Then the relevant code.

## The three deliverables

### 1. A11 — wire the receipt ack into the live path *(the integration gap)*

`RECEIPT_ACK` and `receiptAckFor()` exist in `server/src/talker/ack.ts`, and
`UtteranceLog.takeReceipt()` exists in `pending-proposal.ts`, but **nothing calls
them** — verified by the parent: zero callers outside their definitions and
tests. So the operator's decided behaviour — *"it should acknowledge what I've
said shortly before relaying what the worker said"* (plan §4.1 rule 2) — is
unit-tested but **does not happen in the product**.

Give it a real emission path and prove it live.

**Invariants — these are the whole point and must not be softened:**

- It is a **receipt**, never an agreement. Nothing has been relayed when it is
  spoken, and the confirmation step still follows.
- It fires **at most once per relay**, never once per utterance (say three things
  in a row, get one ack).
- It is produced **mechanically by the harness** from the fixed vocabulary in
  `ack.ts`. The model must have no route to compose, suppress, or extend it.
- It **never races the gate**: emitting an ack must not relay anything and must
  not touch the release path.
- The client already has `TIER_RECEIPT_ACK` (tier 2) in `speechArbiter.ts` and
  `useVoiceTurn.ts` — the ack should reach it as tier 2, ahead of the worker's
  answer (tier 3). Do not renumber the tiers.

If the honest conclusion is that the ack belongs somewhere other than the turn
result, say so in your report with your reasoning — but it must be **emitted**
by something.

### 2. F1 — a cancel-shaped utterance swallows an instruction in the same breath

s5/t4: *"Never mind, forget it. Back to the caching thing — tell it to leave
caching alone entirely, we're dropping that work."* The classifier reads `cancel`
**before anything else**, so the **instruction half is never draft-captured**.
The operator's words stay in the talker conversation but vanish from the harness,
and a later "yes" finds nothing pending. Mechanically safe (nothing was sent) but
from the operator's chair an instruction they spoke disappeared.

Fix it. Two candidate shapes were recorded in the findings — terminate draft
composition **at the cancel boundary** and draft the remainder, or have the
talker **say** that it read a cancel and ask for the instruction again. **Choose
and justify**; a third option is fine if it is better. What must not happen is
the current silence.

### 3. F2 — a bare "yes" with nothing pending drew a false promise

s5/t5, with no draft held: the talker replied *"OK. I'll send that instruction to
the worker."* Nothing was sent and nothing *could* be — the gate held. But **in a
voice surface, telling the operator a send is coming that never will is a real
harm**. The intended behaviour for confirm-with-nothing-pending is the
conversational "send what?" path.

Fix the dead-end branch so it cannot promise a send that will not happen, and
**pin it with a test**. Check the neighbouring dead-end branches (cancel with
nothing pending, release failure) for the same class of false promise while you
are there — say what you found either way.

## Owned paths (yours)

- `server/src/talker/**` — `talker.ts`, `ack.ts`, `prompt.ts`,
  `utterance-classifier.ts`, `pending-proposal.ts`, `types.ts`
- `server/src/websocket/protocol.ts` and `connection.ts` **only if** the ack needs
  a wire field — if so, say what you changed and why; keep it additive.
- `client/src/components/DriveMode/useVoiceTurn.ts` — only to route the ack to
  tier 2 if it is not already wired.
- Their tests.

## Off-limits — do not modify

- **The release path's semantics.** `release()` stays private with one caller;
  `takeForRelease` stays atomic and release-time-staleness-enforcing; the model
  gets **no** text-composition path into a relay. If a fix appears to require
  widening any of that, **stop and report** — the design is wrong, not the gate.
- `client/src/lib/speechArbiter.ts` — frozen; consume it.
- `docs/plans/VOICE-MODE-VALIDATION-RESULTS.md` — it is the evidence record; do
  not rewrite it. Add your own results to your report.
- **Production.** Disposable validation only.

## Evidence you must return

- Exact commands and exit codes.
- **RED-first evidence for each of the three fixes** — the failing test that
  fails for the right reason before the fix.
- **A LIVE demonstration of the receipt ack emitting** (deliverable 1). Unit
  tests are what was wrong before; show it happening against a real worker on a
  disposable server, with the emitted text quoted.
- The full talker suite result, so the gate is shown unregressed.
- For F1 and F2: the before/after behaviour on the exact utterances from the
  findings.
- Anything that did **not** work, stated plainly. A partial fix reported honestly
  beats a claimed complete one.

## Do not commit

Leave the work in the tree and report. The parent reviews, commits and pushes.
