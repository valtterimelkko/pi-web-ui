# Brief A — authority kernel (Wave 0 child; plan Phase 1 + Phase 2 = Track A)

**Session:** assigned at dispatch. **Worktree:** `/root/pi-web-ui-track-a` (branch `feat/voice-kernel`, based on master `f70030d`). **Runtime:** pi. **Model:** `opencode-go/deepseek-v4.1-flash`, thinking `max` (kernel is safety-critical).

## Bounded outcome

1. **Phase 1** — the live confirmation-gate defect fixed **RED-first** on the current cascade.
2. **Phase 2** — the **four-object host authority kernel** implemented in pure TypeScript (Thread, Parking Lot, Proposal, Release) with the read-only tool operations, negative tests, and the delivered card-identity/staleness behaviour preserved.

## Owned paths — edit nothing else

- `server/src/talker/**` (all talker files).
- `server/tests/unit/talker/**`.
- `operations/voice-live-20260917/evidence/A/**` (your evidence logs, committed on the branch).
- **NO-TOUCH:** `server/src/websocket/**`, `server/src/config.ts`, `server/src/routes/**` (except nothing), `shared/**`, `client/**`, all other `server/src/**`, docs. Do not touch `server/src/voice/**` (another track owns it, in parallel).

## Phase 1 — the gate repair (do this first, RED before GREEN)

**Conductor baseline (reproduced 2026-09-17, ledger Appendix C):** `classifyOperatorUtterance` returns **confirm** for `not sure`, `sure, but wait`, `yes, hold phase three` — any of which would release a held draft. `yes` → confirm (correct), `send it` → confirm (correct), `I am not sure` → statement (correct), `I said yes earlier` → statement (correct), `why did you say yes` → question (correct).

1. **RED:** add failing tests covering at least: doubt/uncertainty (`not sure`, `I am not sure`, `hard to say`, `I doubt it`); conditional agreements (`sure, but wait`, `yes, hold phase three`, `ok but check line 10 first`, `yes if the tests pass`); quotation/echo (`I said yes earlier`, `why did you say yes`); disconnected confirmations (nothing pending; expired card — policy level, preserve existing behaviour); and keep-green cases: pure confirmations (`yes`, `send it`, `confirmed`, `go ahead`), and the **mandatory pushback turn** (`just do it, stop asking me every single time`) which must still confirm when a live proposal exists.
2. **GREEN:** narrow the classifier: whole-utterance anchored matching for confirmation shapes; explicit negation prefixes (`not`, `never`, `hardly`, `doubt`) disqualify; an utterance carrying substantial post-affirmation instruction classifies as `statement`, not `confirm`. Whole-utterance regex anchors — **no blanket wildcard regexes**.
3. Do **not** widen the gate's reachability (N8). Narrowing unsafe confirmation is the point. Existing 35 talker suites must stay green.

**Gate 1 commands (record output):**

```bash
cd /root/pi-web-ui-track-a
npm --prefix /root/pi-web-ui/server test -- tests/unit/talker/utterance-classifier.test.ts tests/unit/talker/talker-gate.test.ts
npm --prefix /root/pi-web-ui/server test -- tests/unit/talker/
```

(Use your worktree: `npm --prefix /root/pi-web-ui-track-a/server test -- tests/unit/talker/...`.) 0 failures; at least 25 distinct classifier test cases.

## Phase 2 — the four objects (after Phase 1 is green)

Implement/refactor in `server/src/talker/`:

1. **Thread** (`thread-store.ts`, new): in-memory conversational turns. **Structurally unsendable** — no code path from a thread turn to a release.
2. **Parking Lot** (`parking-lot.ts`, new): ordered `{ id, text, createdAt, sourceUtteranceId }`; add, list, promote exactly one; **batch sending denied in code**.
3. **Proposal** (refactor `pending-proposal.ts` → `proposal-store.ts`): one live proposal per lane: `{ id, version, sha256, original, tidied, presentedVariant, status }`; created **only** via the three promotion routes (direct address; accepted offer; parked-item promotion). Preserve the delivered card identity/version/staleness refusal and the original-variant gate — do not regress it.
4. **Release** (`release-store.ts`, new): append-only `{ proposalId, sha256, idempotencyKey, targetLane, deliveryOutcome, receiptTimestamp }`; `unknown` outcome is first-class requiring reconciliation; duplicate confirmation → `duplicate_refusal`, never a second delivery.
5. **policy-core.ts** orchestrates the four objects; declare the typed read-only operations (`retrieve_session_history`, `retrieve_file_context`, `park_item`, `read_parking_lot`, `offer_ask_worker`) as pure kernel/server functions — no transport, no model prompt authority. No DOM/window/browser assumptions anywhere (kernel stays client-neutral — D7).
6. **Negative tests** in `four-objects.test.ts` (≥15 assertions): thread→release impossible; duplicate confirm is a no-op/refusal; SHA-256 mismatch refuses; wrong version/stale proposal refuses; batch promotion denied; proposal creation only via the three routes; release log append-only.

**Gate 2 command (record output):**

```bash
npm --prefix /root/pi-web-ui-track-a/server test -- tests/unit/talker/four-objects.test.ts
```

Exit 0. Then re-run the **full** `tests/unit/talker/` suite and record it.

## Invariants that must not be softened

- N1–N9 (`docs/VOICE-MODE-INTENT.md` Part I). The relay stays gated by code; relay text is always the operator's own words; acknowledgements stay fixed strings produced after the outcome is known.
- No prompt change that moves authority into the model. Keep the shipped prompt/behaviour unless a test you add requires a change; if so, state it.
- Do not delete or weaken existing tests **except** where one encodes the defective behaviour — say exactly which and why in the handback.
- Strict TDD: red evidence logged for every behaviour change.

## Method notes

- Read first: `docs/VOICE-MODE-EXECUTION-PLAN.md` Phase 1–2, `docs/VOICE-MODE-INTENT.md` §8, §16–§19, and the existing talker code + tests.
- Keep diffs minimal and idiomatic to the existing talker style.
- Log red→green evidence to `operations/voice-live-20260917/evidence/A/` (e.g. `phase1-red.txt`, `phase1-green.txt`, `phase2.txt`).

## Stop protocol

If the brief conflicts with the code, or a decision would cross an authority boundary: write `/root/voice-exec-20260917/coordination/A/01-questions.md`, print `PARENT-INPUT-NEEDED` as a standalone line, and **end your turn**. Never hold the turn open, never poll.

## Handback (end of work, then end your turn)

Commit on `feat/voice-kernel`. Write `/root/voice-exec-20260917/coordination/A/complete.md`:

- outcome (Phase 1 + Phase 2, one paragraph each);
- **changed-path inventory** (exact);
- gate commands + observed results (paste summary lines);
- list of any existing tests modified and why;
- `FROZEN` marker (no further edits until conductor reassignment).

Declare on the agent-os board (`agent-os board declare --join-session <your session id>`); leave the board entry on completion.
