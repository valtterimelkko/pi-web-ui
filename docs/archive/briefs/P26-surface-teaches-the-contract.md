# P26 — The voice surface should teach what happens to the operator's words

## Why

The operator reported being genuinely unsure **how to talk to the talker**. Their words:

> "I'm not sure how to talk to that agent ... what kind of role should I be telling it to ...
> or should I be saying, 'tell the worker that this' ... I've been kind of a little bit lost."

That confusion is a **design failure, not a user failure.** The voice surface asks the
operator to interact with a two-lane machine without ever telling them what the lanes do
or what will happen to their sentence. The operator has to infer the contract from
behaviour — and, as P25's evidence shows, inferring it wrongly produced a real failure
(the worker reading "ask the worker" as "dispatch a sub-agent").

There is also a second half to this: the operator's intent file
(`docs/VOICE-ORCHESTRATOR-FEASIBILITY.md` line 151) specifies a **semi-verbatim** relay —
"the operator's own words, optionally made more concise when the speech rambles" — but the
confirmation card currently claims "Ready to send — **your words, exactly**". Once sibling
child P25 restores the semi-verbatim transform, that claim becomes **untrue**, and an
untrue safety claim on the card is worse than no claim at all.

## Required outcome

1. **The card tells the truth about what will be sent.** If the harness cleaned the text
   (removed a commission frame, hesitation, filler), the card says so, plainly, in the
   operator's own register — and shows the exact text that will go.
2. **The operator can see what was removed.** Not hidden behind an extra click if
   avoidable, but at minimum retrievable on the card. The point of the transform is that
   it is visible and correctable, not silent.
3. **The surface teaches the contract at the moment of use** — one short line where the
   operator speaks, explaining what happens to their words. Keep it human, not
   documentation. Something in the spirit of: *"Say it however you like — I pass your
   words on, tidied. The worker never hears about me."* Yours to word better, but the
   three facts it must convey are: your words are passed on (not re-invented); they may be
   tidied; the worker does not know this lane exists.
4. **Nothing here changes behaviour.** This is display and teaching only.

## Owned paths (do not edit anything else)

- `client/src/components/DriveMode/ConfirmationCard.tsx`
- `client/src/components/DriveMode/DriveModeDictate.tsx`
- `client/src/components/DriveMode/useVoiceTurn.ts`
- client tests under `client/tests/unit/components/DriveMode/`
- `docs/DRIVE-MODE.md` (the operator-facing section, if one exists)

**Do not touch** `server/**` — sibling child P25 owns the server transform. The server
will carry what you need on the turn result; if a field you need does not exist, **report
that to the parent rather than inventing it or editing the server yourself.**

## Interface (agreed by the parent — do not change it unilaterally)

P25 makes the turn result's pending proposal carry, in addition to the exact text that
will be sent:

- whether the text was cleaned at all (a boolean flag), and
- what was removed, so it can be shown.

Code against those names if P25 has landed; otherwise code defensively — render the
disclosure only when the flag is present and true, so the card is correct whether or not
the server is new. **Say which you did in your report.**

## Required evidence

- Tests for: an uncleaned utterance shows no disclosure (the card must not cry wolf);
  a cleaned utterance shows the disclosure and the exact text; the surface hint is present.
- Confirm the existing card behaviours still hold: the verbatim quote, the three
  responses (Confirm / Cancel / typed text), and that Cancel still clears.
- `npm run lint` + ratchet ≤ 326, `npm run typecheck`, client suites green.

## Reporting

Report to the parent: what the card says in each case, how you worded the hint, the field
situation from the interface section, and anything you could not do. **Do not commit.**
The parent reviews, commits and pushes — and **does NOT restart production** (gated).

## Hard constraint

**Do not restart production or any shared service.** The operator has gated restarts while
another agent works against the same Internal API.
