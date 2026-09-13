# P12 — Fix the id/path wiring defect that breaks every UI-driven relay

## The defect (found by P9's browser E2E — read that first)

`docs/plans/VOICE-MODE-BROWSER-E2E-RESULTS.md` §4. The assembled UI works end to end
**up to the confirm gate**, then the confirmed relay never reaches the worker.

**Root cause, already bisected (do not re-derive it):** the UI sends the session
**id** as `workerSessionId` (`DriveModeOverlay.tsx:132` passes `activeSessionId`,
and the app distinguishes id from path at the same call site), while the pi delivery
adapter hands that value straight to `MultiSessionManager`, which keys sessions by
**path** (`multi-session-manager.ts:708/849`, lookups at `:1479-1482` and
`:1536-1539`). For pi sessions id ≠ path, so **every UI-driven release is refused**
with `Session <id> does not exist`. The gate's fail-closed behaviour is correct; the
wiring is not.

Proof of the bisect: `scripts/voice-mode-release-path-probe.mjs` runs the identical
conversation through the same server and delivers **byte-for-byte 67/67/67** when
`workerSessionId` is the **path**. Three independent runs.

## The aim

**A confirmed relay reaches the worker whichever identifier the caller supplies.**

## How to fix it — and the trap to avoid

**Fix it in one place, server-side, so every caller works.** Resolve the supplied
`workerSessionId` to the manager's session key (accept **either** the id or the path)
before it reaches the delivery adapter. Do **not** patch only the UI call site: the
wire field is named `workerSessionId` and the server itself issues the id in
`session_created`, so a client using the id is behaving correctly. Patching the UI
would leave the Internal API, the RPC surface and every future caller with the same
latent break.

**The trap:** an id and a path can both be opaque strings, so a naive "try id then
path" is a silent-wrong-answer risk. Prefer an **explicit resolution** against the
registry/manager's own index, and make the failure mode loud — if the value resolves
to nothing, say so (the current fail-closed refusal is correct behaviour and must
stay).

**Check the other runtimes too.** The adapters are per-runtime. Claude, OpenCode and
Antigravity may resolve differently, may already work, or may share the defect. Find
out and **report** what you find for each — do not assume pi's shape generalises.

## Invariants — do not soften

- **The release gate is untouched**: `release()` stays private with one caller,
  `takeForRelease` stays atomic and staleness-enforcing, no text-composition path is
  introduced, and **a refusal still fails closed**. You are fixing resolution, not
  authorisation.
- **No regression in the existing relay validations**, which pass a path — the fix
  must accept a path exactly as before.
- **No new lint warnings** (ratchet ceiling 1738; check with
  `node scripts/check-lint-ratchet.mjs --base HEAD`).
- **Production is off-limits.** Disposable servers only.

## TDD — the regression test is the point

Write the test first, **failing for the right reason**: a release whose
`workerSessionId` is the session **id** must be refused *before* your fix (RED — the
exact production symptom), and delivered *after* it (GREEN). Pin the **path** case too,
so both identifiers are covered and the old behaviour is provably preserved.

## Live proof required

Unit tests are not enough — this defect lived precisely in the gap between "units
pass" and "the assembled thing works", and it was found by a browser. Prove it the
same way:

1. Re-run the **browser E2E** (`scripts/voice-mode-browser-e2e.mjs` — a sibling child
   owns that file; if it is not yours to touch, say so and use it read-only or
   coordinate through the parent rather than editing it).
2. Show a confirmed relay **from the real UI** reaching the worker's **own
   transcript**, **byte-for-byte with byte counts**.
3. Include a **screenshot** of the release succeeding.

If you cannot drive the browser, say so plainly and report how far you got — but the
whole point of this fix is the joint between the pieces, so a unit-only proof is a
partial result and must be labelled as one.

## Owned paths (yours)

`server/src/talker/**`, `server/src/pi/multi-session-manager.ts` (add a **resolution**
helper; do not change delivery semantics), the client call site **only if** the
server-side fix cannot work, and tests.

## Off-limits

- `docs/plans/VOICE-MODE-BROWSER-E2E-RESULTS.md` — evidence record; do not rewrite.
- `docs/plans/VOICE-MODE-VALIDATION-RESULTS.md` — evidence record.
- The release gate's semantics.
- **Production.**

## Evidence you must return

- Exact commands and exit codes.
- The RED-then-GREEN regression test, both identifiers covered.
- The per-runtime finding (pi / claude / opencode / antigravity): does each resolve
  an id, a path, or both?
- The **live browser proof** with byte counts, or an honest statement of what blocked
  it.
- The ratchet result showing no new warnings.
- Anything that did **not** work, stated plainly.

## Do not commit

Leave the work in the tree and report. The parent reviews, commits and pushes.
