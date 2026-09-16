# Child handback — confirmation card contract (D1 honest tidy / D2 original choice)

**Status: COMPLETE**

**FROZEN** — I have stopped editing every path below. No git mutations were
made (no commit/branch/stash/checkout/reset); `npm run build` was never run; no
service was started, stopped or reconfigured.

Frozen owned paths (plus their test files):
`server/src/talker/relay-normalise.ts`, `server/src/talker/pending-proposal.ts`,
`server/src/talker/talker.ts`, `server/src/websocket/protocol.ts`,
`server/src/websocket/connection.ts`, `server/src/talker/session-registry.ts`
(see deviation D-1), `client/src/components/DriveMode/ConfirmationCard.tsx`,
`client/src/components/DriveMode/useVoiceTurn.ts`,
`client/src/components/DriveMode/DriveModeDictate.tsx`,
`client/src/lib/talkerBus.ts`, `client/src/hooks/useTalkerTurn.ts` (see deviation D-2).

---

## 1. Changed-path inventory

Server source:
```
server/src/talker/relay-normalise.ts
server/src/talker/pending-proposal.ts
server/src/talker/talker.ts
server/src/websocket/protocol.ts
server/src/websocket/connection.ts
server/src/talker/session-registry.ts      <- DEVIATION D-1 (not in §3)
```
Server tests:
```
server/tests/unit/talker/relay-normalise.test.ts
server/tests/unit/talker/pending-proposal.test.ts
server/tests/unit/websocket/talker-transport.test.ts
```
Client source:
```
client/src/components/DriveMode/ConfirmationCard.tsx
client/src/components/DriveMode/useVoiceTurn.ts
client/src/components/DriveMode/DriveModeDictate.tsx
client/src/lib/talkerBus.ts
client/src/hooks/useTalkerTurn.ts          <- DEVIATION D-2 (not in §3)
```
Client tests:
```
client/tests/unit/components/DriveMode/ConfirmationCard.test.tsx
client/tests/unit/components/DriveMode/useVoiceTurn.test.tsx
client/tests/unit/lib/talkerBus.test.ts
```
No other file changed (`git status --short` shows exactly these 17 modified
paths; the only untracked entry is the pre-existing `operations/` programme dir).

---

## 2. RED evidence (before implementation)

Command (server):
```
npm test --workspace=server -- tests/unit/talker/relay-normalise.test.ts tests/unit/talker/pending-proposal.test.ts tests/unit/websocket/talker-transport.test.ts
```
Result: `Test Files 3 failed (3)` / `Tests 14 failed | 69 passed (83)` — log `logs/RED-server.txt`.
Failures for the right reasons (not syntax):
- `TypeError: describeProposal is not a function` (×5)
- `TypeError: relayHasVisibleRemoval is not a function` (×2), `visibleRemovalFragments is not a function` (×1)
- `expected 'Um, tell the worker to rerun the suite' to be 'Um, tell the worker to'` (R2: old payload sent the whole utterance as `removed`)
- `expected true to be false` (R1: whitespace-only tidy claimed `cleaned: true`)
- `expected undefined to be 'Um, tell the worker to rerun the suite'` (R3: no `original`)
- `expected undefined to be 'INVALID_MESSAGE'` (R6: invalid `releaseVariant` not schema-rejected)

Command (client):
```
npm test --workspace=client -- tests/unit/components/DriveMode/ConfirmationCard.test.tsx tests/unit/components/DriveMode/useVoiceTurn.test.tsx
```
Result: `Test Files 2 failed (2)` / `Tests 5 failed | 36 passed (41)` — log `logs/RED-client.txt`.
Failures: no `relay-original-disclosure` / `Send my exact words`; `expected 'Confirm' to match /tidied/i`; original not carried through the hook; `TypeError: result.current.releaseOriginal is not a function`.

## 3. GREEN evidence (after implementation)

Command (server, targeted):
```
npm test --workspace=server -- tests/unit/talker/relay-normalise.test.ts tests/unit/talker/pending-proposal.test.ts tests/unit/websocket/talker-transport.test.ts
```
Result: `Test Files 3 passed (3)` / `Tests 83 passed (83)` — log `logs/GREEN-server-targeted.txt`.

Command (client, targeted):
```
npm test --workspace=client -- tests/unit/components/DriveMode/ConfirmationCard.test.tsx tests/unit/components/DriveMode/useVoiceTurn.test.tsx
```
Result: `Test Files 2 passed (2)` / `Tests 41 passed (41)`.

---

## 4. Per-behaviour evidence

| Rule | Test(s) | Evidence |
|---|---|---|
| R1 `cleaned` iff a removal holds non-whitespace | `relay-normalise.test.ts` "visible tidy vs byte-level change" (4 tests); `pending-proposal.test.ts` "R1: a whitespace-only normalisation is NOT a tidy"; `talker-transport.test.ts` "a whitespace-only normalisation (trailing newline) is NOT a tidy — R1" | RED: `relayHasVisibleRemoval is not a function`, `expected true to be false`. GREEN: all pass; `normaliseRelayText('Proceed.\n')` still returns `{text:'Proceed.', changed:true, removals:[]}` (byte output of the normaliser unchanged) and `describeProposal` reports `{text:'Proceed.', cleaned:false}`. |
| R2 `removed` = fragments only | `pending-proposal.test.ts` "R2/R3 …", "R2: fragments of several removals are joined once"; `talker-transport.test.ts` "a tidied draft tells the truth" | RED: `expected 'Um, tell the worker to rerun the suite' to be 'Um, tell the worker to'`. GREEN: `removed === 'Um, tell the worker to'`, with an explicit assertion that it is NOT the whole utterance. |
| R3 `original` = `originalText ?? text`, `joinDraftText`'s `'\n'`, only when cleaned | `pending-proposal.test.ts` "R3: a multi-part original …"; `useVoiceTurn.test.tsx` "carrying the raw original surfaces it" | GREEN: multi-part `original === 'Um, rebase main\nrun the suite'`, equal to `joinOriginalDraftText(parts)`; clean and whitespace-only drafts carry no `original` (asserted `undefined` on the wire). |
| R4 nothing invented | `pending-proposal.test.ts` "R4: an already-clean utterance invents nothing"; `useVoiceTurn.test.tsx` "junk on the original field is ignored"; `talker-transport.test.ts` clean-draft test | GREEN: `{text:'run the deploy checks', cleaned:false}` exactly (no `removed`/`original` keys); junk proposal fields fall back to the verbatim record. |
| R5 pure helper | `pending-proposal.ts describeProposal(utterances)` used by `connection.ts` (`proposalForCard = describeProposal(draftSnapshotForCard.utterances)`), unit-tested without the WebSocket handler | GREEN: 5 unit tests cover it directly; `talker-transport.test.ts` proves the transported payload equals it. |
| R6 variant honoured only on the confirm branch; invalid values schema-rejected | `talker-transport.test.ts` "R6: the variant is honoured ONLY on the confirm branch" and "R6: an invalid releaseVariant is rejected by the message schema, not coerced" | RED: `expected undefined to be 'INVALID_MESSAGE'`. GREEN: non-confirm turn → `phase 'proposed'`, `deliveredTexts() === []`; `releaseVariant:'raw'` → `error.code === 'INVALID_MESSAGE'`, no `talker_turn_result`. `isTalkerTurnMessage` now accepts only `'tidied' | 'original' | undefined`. |
| R7 `'original'` sends raw bytes per part; gates unchanged | `pending-proposal.test.ts` "takeForRelease variant (R7)" (4 tests); `talker-transport.test.ts` seam invariant | GREEN: lapsed draft still returns `null` and marks `needsReConfirmation` with the draft intact; empty draft returns `null`; selection resolves the same parts (`utteranceIds [2]`). |
| R8 one private release path | `talker.ts`: `private async release(confirmingUtterance, turn, selection, variant)`; the variant is a parameter of that one call site (`grep -rn "this.release(" server/src/talker/` → exactly 1 hit) | GREEN: `node_modules/.bin/tsc --noEmit` clean; no second caller exists. |
| §4 seam invariant (both halves) | `talker-transport.test.ts` "the SEAM invariant: proposal.text === default release bytes AND proposal.original === original-variant release bytes" | GREEN: default confirm `released.text` === `proposal.text`; confirm with `releaseVariant:'original'` `released.text` === `proposal.original` === the raw utterance; the fake delivery recorded exactly those two strings. |
| §4 clean utterance ⇒ `cleaned:false`, no `removed`/`original`, relay byte-identical | `talker-transport.test.ts` "a clean draft does not cry wolf"; `pending-proposal.test.ts` R4 | GREEN as above. |
| §4 confirm/cancel/typed-text unchanged; Cancel clears the card | existing `ConfirmationCard.test.tsx` suites (unchanged, still passing) + `talker-transport.test.ts` (17 pre-existing transport tests still pass; file now 21) | GREEN: client DriveMode 204/204; server talker+transport 414 passed / 2 skipped. |
| §4 card never interprets; client never produces relay text | `ConfirmationCard.tsx` renders only server-supplied `proposalText`/`removed`/`original`; `useVoiceTurn.proposalFromResult` is a defensive reader only; the original action sends `CONFIRM_UTTERANCE` + a variant flag, never text | GREEN: `useVoiceTurn.test.tsx` "releaseOriginal sends the confirm gesture with releaseVariant 'original'" asserts the exact outgoing message contains no composed text. |
| §4 `talker-transport.test.ts` keeps passing | full file (21 tests) | GREEN — **but see deviation D-3**: one pre-existing assertion encoded the D1 defect and was updated to the frozen R2 contract. |

## 5. Final full-suite numbers (verbatim from `logs/`)

```
npm test --workspace=server -- tests/unit/talker tests/unit/websocket/talker-transport.test.ts
 Test Files  31 passed (31)
      Tests  414 passed | 2 skipped (416)
```
(baseline 31 files / 396 passed / 2 skipped → +18 tests, 0 regressions)

```
npm test --workspace=client -- tests/unit/components/DriveMode
 Test Files  21 passed (21)
      Tests  204 passed (204)
```
(baseline 21 files / 193 passed → +11 tests, 0 regressions)

Extra, because one new test lives outside the two commands above:
```
npm test --workspace=client -- tests/unit/lib/talkerBus.test.ts
 Test Files  1 passed (1)
      Tests  5 passed (5)
```

```
npm run typecheck --workspace=server   -> exit 0
npm run typecheck --workspace=client   -> exit 0
npm run lint                           -> exit 0 (0 errors, 308 pre-existing warnings)
```

Logs: `logs/RED-server.txt`, `logs/RED-client.txt`,
`logs/GREEN-server-targeted.txt`, `logs/GREEN-server-full.txt`,
`logs/GREEN-client-full.txt`, `logs/FINAL-server.txt`, `logs/FINAL-client.txt`,
`logs/FINAL-talkerbus.txt`, `logs/FINAL-typecheck-server.txt`,
`logs/FINAL-typecheck-client.txt`.

---

## 6. Deviations, conflicts and things I did not do

**D-1 (scope deviation — needs your call).** `server/src/talker/session-registry.ts`
is **not** in §3's owned list, but the variant cannot reach the talker without it:
`connection.ts` calls `registry.handleOperatorTurn(...)`, whose input type and
pass-through to `TalkerSession.handleOperatorTurn` live there. I added
`releaseVariant?: ReleaseVariant` to `TalkerOperatorTurnInput` and forwarded it
(+10 lines, 0 removed, no logic). The alternative was either a wrong caller
(bypassing the registry's injection gate and delivery resolution) or stopping the
run on a mechanical pass-through. Flagging it explicitly for your review; the
diff is `git diff server/src/talker/session-registry.ts`.

**D-2 (brief ambiguity).** §3.8 says "`client/src/lib/talkerBus.ts` — the
optional field on the outgoing message". `talkerBus.ts` is a receive-only bus; the
outgoing `talker_turn` message is built in `client/src/hooks/useTalkerTurn.ts`
(`SendTalkerTurnInput`). I put the outgoing `releaseVariant` field there and
extended `talkerBus.ts`'s *result mirror* with `proposal: { text, cleaned, removed?, original? }`.
Both files are edited as the intent requires.

**D-3 (direct conflict — please note).** §4 says
`server/tests/unit/websocket/talker-transport.test.ts` "keeps passing", but its
pre-existing assertion
`expect(proposed?.proposal?.removed).toContain('Um, tell the worker to rerun the suite')`
pins exactly the D1 defect this brief removes (R2 forbids `removed` carrying the
whole utterance). The file still passes, but not byte-identically: I replaced that
one assertion with the R2 contract (`removed === 'Um, tell the worker to'`, plus a
negative assertion) and added the `original` assertion beside it. No other
pre-existing assertion in that file was touched. If you wanted that assertion
preserved, R2 and §4 cannot both hold — R2 (frozen) was implemented.

**D-4 (one test added post-implementation, not RED-first).** The new
`client/tests/unit/lib/talkerBus.test.ts` case ("carries a proposed result's card
payload through intact") is a shape pin, not a behaviour change: `talkerBus`
already forwarded unknown fields, so it would have passed before the edit. I did
not fabricate a RED run for it.

**Not done (by design of the brief):** no `npm run build` (root/server/client/shared),
no service restart, no live validation, no git mutation, no capture to Agent OS,
no third pass beyond the tests listed.

**Contact-surface check:** `describeProposal` is a new export consumed only by
`connection.ts`; `joinDraftText` semantics are unchanged; `repairRelaySeams` is
the former private `repairInteriorSeams`, renamed and exported with an identical
body, so every existing relay output byte is unchanged (the relay-normalise
suite carries 18→22 tests with all pre-existing cases untouched).
