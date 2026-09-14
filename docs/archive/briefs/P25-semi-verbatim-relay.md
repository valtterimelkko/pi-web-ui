# P25 — Restore the intent's rule: semi-verbatim relay

## The finding: this is a DRIFT, not a new feature

`docs/VOICE-ORCHESTRATOR-FEASIBILITY.md` line 151 (the preserved intent file) states the
relay rule in three parts:

> **Relay with very high fidelity.** Semi-verbatim: the operator's own words, optionally
> made more concise when the speech rambles, but never summarised into the talker's own
> plan, never expanded into long-winded instructions. The worker receives the owner's
> intent, not a re-planned version of it.

The implementation kept part one (their own words) and part three (never summarised,
never expanded) — and **dropped part two entirely**. The release path is byte-for-byte
verbatim and the card says "your words, exactly". The plan's own acceptance criterion A5
says "arrived **semi-verbatim**", so the plan acknowledged the intent and the build
over-corrected anyway.

## Why that is now causing real harm (operator-reported, evidenced)

The operator spoke to the talker: *"Okay, **ask the worker** if it has enough materials to
start developing the first week's materials, if it has enough resources for that."*

Because the relay is exactly verbatim, the worker received that sentence as written — and
**the worker does not know it is a worker, does not know a talker exists, and parsed "the
worker" as some other agent it should dispatch to.** Its reply: *"Understood — I'll put
the readiness question to a worker agent."* It then started spawning sub-agents, which is
precisely what the operator did not want.

This is the class of failure the intent's part two exists to prevent: the operator's
spoken form contains the *channel* ("ask the worker") and the *disfluency* ("okay",
"if it has enough resources for that"), and none of that is the instruction. The
instruction is the content.

## The governing principle to implement

**Fidelity is about INTENT, not about BYTES.**

- What must never happen (the GPT-Live failure the operator lived through): the talker
  re-plans, drops, or invents content — "summarised into the talker's own plan".
- What the intent explicitly permits: the operator's own words **made more concise when
  the speech rambles**.

So the concision to implement is **removal of what carries no instruction** — never
rewriting, never substituting words, never reordering meaning.

## Required outcome

1. A relayed instruction carries the operator's own words **minus the channel and the
   disfluency**: addressing/commission frames, filler and hesitation, stutters, and
   leading discourse markers.
2. **The model never produces the relayed text.** Not one token. This is a deterministic,
   harness-owned transform — the same family as the existing confirm/cancel patterns and
   the `[[ask-worker]]` / `[[to-talker]]` marker handling. This is the line that protects
   the intent's prohibitions, and it must not be crossed for capability.
3. ~~The operator still authorises the exact bytes.~~ **THE CARD SHOWS THE EXACT TEXT
   THAT WILL BE SENT**, and the released text is byte-identical to what the card showed.
   The transform happens BEFORE approval, never after it. State this as the primary
   invariant, replacing "byte-equal to the operator's raw words".
4. The gate is untouched: `release()` private with one caller, `takeForRelease()` atomic,
   the store remains the only source of relay text.

## Suggested shape (yours to improve)

- A new pure module (e.g. `server/src/talker/relay-normalise.ts`) with a closed,
  well-commented list of transforms. Keep it conservative and testable:
  - commission/addressing frames: "ask the worker to/if", "tell the worker to/that",
    "let the worker know", "pass this on to the worker", "ask it to/if", "tell it to"
    — note the operator may address the *talker* ("tell the worker") or use a pronoun;
  - hesitation: "um", "uh", "er", "erm";
  - stutters and immediate word repetition;
  - leading discourse markers: "okay so", "right,", "so,";
  - padding phrases that carry no instruction ("if that's okay", "if you don't mind").
- Be careful with anything meaning-bearing. "kind of" and "sort of" can soften a request
  ("I don't want to kind of delay it"); when in doubt, LEAVE THE WORDS IN. A conservative
  transform that misses some noise is correct; an aggressive one that removes intent is
  the failure this project exists to prevent.
- Every transform must be reversible in the record: keep what was removed, so the
  operator can see the original if they want it (see the client brief P26 for display).
- If nothing is removed, the text is unchanged and the card is unchanged — a plain
  utterance must relay exactly as today.

## Owned paths (do not edit anything else)

- `server/src/talker/talker.ts`
- `server/src/talker/pending-proposal.ts`
- `server/src/talker/types.ts`
- new `server/src/talker/relay-normalise.ts`
- `server/src/talker/ask-worker.ts` (the offer path holds the operator's words too — the
  same transform must apply there, or a relayed question keeps the same defect)
- new tests under `server/tests/unit/talker/`

**Do not touch** `client/**` — sibling child P26 owns the surface and the card.

## Required evidence

- TDD, RED **first**: the failing test must reproduce the operator's exact case — the
  sentence above must relay as the content, not with the commission frame.
- A test proving the primary invariant: the released bytes equal the bytes the card
  showed.
- A test proving a plain, clean instruction is passed through **unchanged** (no transform
  by default).
- Tests for the borderline cases you decided to leave alone, with a comment saying why
  leaving them was the safe choice.
- The gate untouched, proven. `npm run lint` + ratchet ≤ 326, `npm run typecheck`, suites
  green.

## Reporting

Report to the parent: the transform list, the RED evidence, the borderline decisions, and
anything you could not do. **Do not commit.** The parent reviews, commits, pushes — and
**does NOT restart production** (gated by the operator).

## Hard constraint

**Do not restart production or any shared service.** The operator has gated restarts while
another agent works against the same Internal API. Your work lands in the repo and waits.
