# STATE — Voice Mode native-primary + autonomous validation

> **Current state, not a completion claim — read before acting.** Rewritten at every fan-in/dispatch.
> Authority and strategy live in [`LEDGER.md`](./LEDGER.md); the plan is the contract.
> Conductor session `01a0caac-7dbe-73fd-809a-f3eb3c6b0b6b` (bare-CLI pi; primary wake
> `watch_wake_register`, backstop `wake_deadline`/`bg_run`).

**Stage:** `EXECUTING` — owner gates answered (Q1 merge granted, Q2 plan confirmed).

**Wave:** W1 · W2 complete · **W3 fix loop COMPLETE — GATE G4 ACHIEVED** (11 passes; pass 10 and
pass 11 both **12/12 clean**; freeze at `f7c43bc9`) · **W4 (Phase 5) opening**.

**Active children:** none.

**W3 outcome (frozen revision `f7c43bc9`)**

- 11 dev-set passes: 1/12 → invalid (stale build) → 5/12 → 4 clean → 9 clean → 11 → 11 → 10 →
  **12/12 → 12/12**.
- Corrections delivered by children (all verified + merged): H2 (host read-back, routing prompt),
  J2 (director persistence, verifier negation), H3 (binding grace), J3 (labelled TTS seam),
  K (presentation persistence, seam completeness, openResponse, C18 prompt).
- Conductor fixes: corpus C05/C15/C16/C18/C21 data, fixture re-freezes (C05-t1/t2, C17-t1, C18-t3),
  fixture text-drift guard, deadline bump + data-derived timing tests, 15 lint errors cleared,
  runner freshness (stale built app), C16 openResponse, state-aware correction hint, talker-quiescence
  before confirm turns.
- Evidence: `fix-loop/pass-1..11/`, `PASS-1-DIAGNOSIS.md`, `freeze.json` + `FREEZE.md`.

**W4 plan (Phase 5)**

1. Holdout validator (parent): author + freeze C10/C11/C22/C24 wording + fixtures (unseen by the
   implementer lineage).
2. Cost the matrix from measured spend (≈90 min live so far; §10: 8 h / US$25) — full §8 matrix fits.
3. Campaign: 34 required cells (12 core ×2 arms, 4 holdout ×2, 2 soaks), one heavy runner, paired by
   ID, alternating arms with recorded seed; cells via `primary-mic --episode <id> --arm <arm>`;
   soak driver to check/extend.
4. Evaluator pass for open-response episodes (fixed rubric, blinded).
5. Independent reviewer child (read-only): manifests, accounting, identity, hint leakage, offline
   re-verification.
6. Verdict + repository gates + canonical docs + Agent OS capture.

**Open questions:** none.
**Backstops:** none armed (goal resuming for W4 work).
