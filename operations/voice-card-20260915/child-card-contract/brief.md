# Child brief — the confirmation card tells the truth, and the operator can choose the original

**You are a dispatched child worker.** You own one bounded outcome, below. You do
not commit, push, branch, or restart anything. You hand back evidence; the parent
verifies and commits.

- Programme: `operations/voice-card-20260915/` (strategy + checkpoint)
- Your handback goes to: `operations/voice-card-20260915/child-card-contract/complete.md`
- Working directory: `/root/pi-web-ui` (the parent's checkout — single writer, you are the only writer)

---

## 1. Why you are here (parent-proven evidence, do not re-derive)

Drive Mode's voice lane relays the operator's spoken words through a confirmation
card. The card is supposed to tell the truth about what will be sent (P26) and
quote exactly the bytes a Confirm will release (P25/P27).

The operator reported, using the live lane:

> "there was like the overlay of this, I've replaced your prompt, but it was
> verbatim the same … it says it's tidying up, but is it actually doing any
> changes to it? And then I thought I had the option of choosing the original
> prompt as well, but that didn't appear in the UI."

Two real defects, both reproduced by the parent:

**D1 — the card cries wolf (invisible tidying claims a visible tidy, and shows the
whole original as "taken out").**
- `normaliseRelayText("Proceed.\n")` → `{ text: "Proceed.", changed: true, removals: [] }`.
  `changed` is *byte*-level, so a dictation trailing newline marks a draft part as
  cleaned — with **zero recorded removals**.
- Live recordings from this morning's sessions contain exactly that shape:
  `[VoiceMode] voice turn …` conversation ring excerpts `"Proceed.\n"` and
  `"…inverse proxy either.\n"`.
- `server/src/websocket/connection.ts` (the `talker_turn_result` handler, ~line
  4216) then sends `cleaned: true` whenever any part carries `originalText`
  (which `pending-proposal.ts appendToDraft` sets whenever `changed` is true), and
  sends `removed:` **the operator's entire original utterance** — not the removed
  fragments. The card renders that struck through under "Taken out of your words",
  while the quoted text is visually identical to what the operator said.
- Result: the operator sees "your words, tidied" + his whole prompt struck through
  as if discarded, when the only change was a trimmed newline.

**D2 — the operator cannot choose his original words.**
- `client/src/components/DriveMode/ConfirmationCard.tsx` offers Confirm (tidied),
  Cancel, and a typed-text reply. Nothing releases the raw words, although the
  store already keeps them (`DraftUtteranceEntry.originalText`) and
  `relay-normalise.ts` already records the removals.

Both defects live on one seam: the server's `proposal` payload → the client card.

## 2. Frozen interface (parent-owned seam — implement exactly this)

`talker_turn_result.proposal`, when `phase === 'proposed'`:

```ts
proposal: {
  text: string;        // UNCHANGED semantics: the exact bytes a default Confirm releases
  cleaned: boolean;    // true IFF tidying removed VISIBLE content (see rules)
  removed?: string;    // the removed FRAGMENTS only, joined — present only when cleaned
  original?: string;   // the raw bytes an original-variant release sends — present only when cleaned
}
```

Rules (these are the contract, not suggestions):

R1. `cleaned === true` **iff** at least one recorded removal contains a
    non-whitespace character. A whitespace-only normalisation (trimmed trailing
    newline, collapsed double space, space closed before punctuation) is **not**
    a tidy: `cleaned === false`, no `removed`, no `original`. The relay text is
    still the normalised text, and "your words, exactly" is then true — the words
    *are* exact.
R2. `removed` carries the **fragments** the normaliser recorded (e.g. `"Okay, "`,
    `"Um,"`), filtered to those containing a non-whitespace character and joined
    with a single space. It never carries the operator's whole utterance.
R3. `original` is the exact bytes an original-variant release would send —
    the same parts in the same order, each `originalText ?? text`, joined with the
    same separator `joinDraftText` uses (`'\n'`). Present only when `cleaned` is
    true (there is a meaningful choice only then).
R4. Nothing is invented: no part, no fragment, no original text the store does not
    actually hold. Missing data is omitted, never guessed.
R5. Build the payload from a **pure helper** (see §3) so the seam is unit-testable
    without the WebSocket handler.

Client → server, `talker_turn` gains one optional field:

```ts
releaseVariant?: 'tidied' | 'original'   // default 'tidied'
```

R6. The variant is honoured **only** on the confirm branch: the utterance must
    classify as `confirm` (including the mechanical selection shape) and a live
    pending draft must exist. A non-confirm utterance carrying `releaseVariant`
    behaves exactly as today (nothing is released). Invalid values are rejected by
    the message schema, not silently coerced.
R7. With `'original'`, the release sends the raw bytes per part
    (`originalText ?? text`, same join) for exactly the parts the same selection
    resolves, and `released.text` echoes those bytes. Every existing gate
    behaviour is unchanged: lapsed draft → re-confirm, ambiguous selection →
    clarification, nothing pending → mechanical dead end.
R8. The release path stays private with a single caller (`talker.ts release()`);
    the variant is a parameter of that one path, never a second door.

## 3. Required work

**Server**
1. `server/src/talker/relay-normalise.ts` — keep the normalisation; make the
   "visible tidy" distinction available (e.g. an exported predicate/helper over
   `removals`), without changing any existing relay output byte.
2. `server/src/talker/pending-proposal.ts` — keep the recorded fragments on the
   draft entry (`removals`) beside `originalText`; add the pure proposal-descriptor
   helper (R5) and teach `takeForRelease` the variant (R7), so the same join is
   used by the card payload and by the release.
3. `server/src/talker/talker.ts` — thread the variant into the one release path
   (R6/R8).
4. `server/src/websocket/protocol.ts` — message type + result type (the shapes in §2).
5. `server/src/websocket/connection.ts` — pass the variant through; build the
   proposal payload via the pure helper.

**Client**
6. `client/src/components/DriveMode/ConfirmationCard.tsx` — honest header
   ("tidied" only when `cleaned`); the removal note shows only the fragments; when
   `original` is present and differs from `text`, offer a collapsed disclosure of
   the operator's exact words plus one explicit secondary action
   **"Send my exact words"**. The disclosure is view-only: the primary Confirm
   still sends `text` (label it so no hidden mode exists).
7. `client/src/components/DriveMode/useVoiceTurn.ts` + `DriveModeDictate.tsx` —
   carry the new fields through; add the explicit original send
   (`CONFIRM_UTTERANCE` + `releaseVariant: 'original'`); never invent fields and
   keep today's behaviour on an older server that sends none of them.
8. `client/src/lib/talkerBus.ts` — the optional field on the outgoing message.

## 4. Invariants that must not regress (pin them with tests)

- Confirm/Cancel/typed-text still behave; Cancel still clears the card.
- The card never interprets; the client never produces relay text.
- The **seam invariant**, in one test: a `proposed` result's `proposal.text` is
  byte-identical to the `released.text` of the default confirm that follows it,
  **and** its `proposal.original` is byte-identical to the `released.text` of a
  confirm sent with `releaseVariant: 'original'`. (P27's single live-matrix FAIL
  was exactly this seam: both halves individually green, the wire between them
  wrong.)
- An utterance that is already clean reports `cleaned: false`, no `removed`, no
  `original`, and relays byte-identically.
- Whitespace-only normalisation: relay text normalised, `cleaned: false`.
- `server/tests/unit/websocket/talker-transport.test.ts` keeps passing.

## 5. Method (mandatory)

- **TDD, RED first.** Write the failing test, run it, see it fail for the right
  reason, then implement. Record the RED and GREEN command + result in the handback.
- Only the paths listed in §3 (plus their test files) are yours. Do not touch any
  other file.
- **No git mutations** (no commit, branch, stash, checkout, reset). The parent
  stages and commits path-limited.
- **Do not run `npm run build`** (root, server, client, shared) — production serves
  `server/dist` from this checkout and the build must stay frozen until the gated
  deployment. `tsc --noEmit` typechecks are fine.
- **Do not restart, reconfigure, stop or otherwise touch any service** — no
  `systemctl`, no production, no `npm run validate:server` against real sessions.
- Test commands (from `/root/pi-web-ui`):
  - `npm test --workspace=server -- tests/unit/talker tests/unit/websocket/talker-transport.test.ts`
  - `npm test --workspace=client -- tests/unit/components/DriveMode`
  - `npm run typecheck --workspace=server` and `npm run typecheck --workspace=client`
  Parent's pre-dispatch baseline: server talker+transport **31 files / 396 passed
  / 2 skipped**; client DriveMode **21 files / 193 passed**. Your finish must be
  green with the new tests added.

## 6. Handback (`complete.md`, plus a `logs/` directory)

- `Status: COMPLETE` or `Status: PARTIAL` — plus a **FROZEN** line naming the
  owned paths you stopped editing.
- Changed-path inventory (exact paths).
- Per behaviour (R1–R8 and §4): the RED evidence, the GREEN evidence, the command,
  the result.
- The final full-suite numbers for both commands above, verbatim.
- Anything you could not do, with the reason. Do not claim a check you did not run.
- Keep it tight: evidence, not narrative.

## 7. When to ask the parent

Only for a contradiction in this brief, a scope boundary you cannot cross, or an
irreversible action. Everything below that is yours to decide, record and move on.
If the seam in §2 turns out to be unimplementable as written, stop and say so with
the exact obstacle rather than inventing a different interface.

## 8. Model note

You are running as `opencode-go/deepseek-v4.1-flash` at thinking `high`. Work
autonomously end to end; the GLM peak window makes that route the right one today.
