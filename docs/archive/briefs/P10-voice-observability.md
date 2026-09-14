# P10 — Implement Voice Mode observability

## Context

**Read the design first: `docs/plans/VOICE-MODE-OBSERVABILITY-DESIGN.md`.** It is the
specification — deliverables D1–D6, the field table, the governing principle and the
non-goals. Do not re-derive it; implement it.

Then read **`docs/OBSERVABILITY.md`**: the doctrine this must ride. Voice Mode
observability **extends** the central logger, the scrubbed diagnostics ring buffer,
the operational metrics registry and the Internal API retrieval surface. It does
**not** fork them.

**Why this matters now:** the operator is about to test Voice Mode by voice. When
something looks or sounds wrong, the question will be *"what actually happened in the
backend?"* — and an agent must be able to answer it from the docs alone, without
reproducing the interaction.

## The bounded outcome

**One voice interaction is fully reconstructable after the fact, through one
documented path.**

Concretely: an operator turn emits correlated structured records (D1), a relay emits
its provenance — bytes and mechanism (D2), metrics are registered (D3), client speech
decisions are recoverable (D4), the retrieval path is documented (D5), and any new
failure modes use the existing error-code registry (D6).

## The thing that must not be faked

The design's verification section is the point of the package, not an appendix:

1. **TDD** for the record shape and correlation — a turn produces the expected
   fields, a refusal carries its reason, a release carries byte count and mechanism.
2. **Live proof on a disposable server.** Hold a short voice conversation through the
   real talker, then **retrieve that conversation's trace via the documented path**
   and quote the records back. If your own documented instructions do not actually
   work when you follow them, they are wrong — fix the docs, not the reader.
3. **Show both signatures from one session**: a gate **refusal** record and a
   **release** record, so the healthy shape is demonstrated rather than described.
4. **Verify the scrubber applies** to your new fields rather than assuming it does.

An implementation that logs beautifully but cannot be retrieved the documented way
has failed this package. Conversely, if the honest conclusion is that the existing
diagnostics surface cannot carry this without a change to the Internal API, **say so
and propose it** — that is a parent decision, not a workaround to invent.

## Hard rules

- **Observe; do not alter.** No change to the gate, the release path, the classifier,
  or any talker behaviour. `release()` stays private with one caller; `takeForRelease`
  stays atomic and staleness-enforcing. If observing appears to require changing
  behaviour, **stop and report**.
- **No new wire protocol, no new endpoint, no second buffer or log file** without
  justifying it in your report and marking it as a parent decision. Prefer queryable
  records over a bespoke view.
- **Bounded records.** Never log full utterance or reply bodies; excerpts only (the
  design caps them).
- **No secrets in any log.** The buffer scrubs on entry — confirm it does for your
  fields.
- **`no-console` is an ESLint error in `server/src/**`.** Use the central logger. Note
  also that CI runs a **lint ratchet** with a warning ceiling of 1738 (currently 1736):
  **your new code must not add warnings** — check with
  `node scripts/check-lint-ratchet.mjs --base HEAD` before you report.
- **Production is off-limits.** Disposable validation servers only.

## Owned paths (yours)

`server/src/talker/**`, `server/src/observability/**`,
`server/src/internal-api/routes/diagnostics.ts` (only if a query filter is genuinely
required), `client/src/lib/speechArbiter.ts` and the client diagnostics-bundle wiring,
`docs/OBSERVABILITY.md`, `docs/TROUBLESHOOTING.md`, and tests.

## Off-limits

- `docs/plans/VOICE-MODE-VALIDATION-RESULTS.md` — evidence record, do not rewrite.
- The release gate's semantics.
- **Production.**

## Evidence you must return

- Exact commands and exit codes.
- The RED-first evidence for the record-shape and correlation tests.
- The **live trace retrieval**: the records quoted, and the documented command that
  produced them.
- The refusal + release signature pair from one session.
- The scrubber verification.
- The ratchet result (before/after warnings) showing you added none.
- The client-side half: how a speech decision is actually retrieved, or an honest
  statement of what you could not make retrievable and why.
- Anything that did **not** work, stated plainly. A partial implementation reported
  honestly beats a claimed complete one.

## Do not commit

Leave the work in the tree and report. The parent reviews, commits and pushes.
