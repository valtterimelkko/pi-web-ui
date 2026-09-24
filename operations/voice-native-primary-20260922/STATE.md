# STATE — Voice Mode native-primary + autonomous validation

> **Current state, not a completion claim — read before acting.** Rewritten at every fan-in/dispatch.
> Authority and strategy live in [`LEDGER.md`](./LEDGER.md); the plan is the contract.

**Stage:** `FOLLOW-UP COMPLETE (§15.4) — DEPLOYED to production 2026-09-24 10:41Z (owner-approved); D15-7 dogfooding is the remaining, deliberately-manual step.`

**The §15.4 follow-up is executed (2026-09-24, direct execution — no children, owner redirect after
the child-dispatch chain failed).** All eight acceptance items are met or pending only the
owner-gated restart: F-1 SOAK-10MIN attempt-13 **verifier PASS** (pending-work survival verified:
prop-1 released, delivered AND stored after the reconnect; the repeat relay produced prop-2 →
presented → confirmed → delivered); F-2 D15-3 natural approval (C18 restored wording + C11
amendment + candidate-referring confirms + withdrawal-amends, gate untouched); F-3 the C21
precondition prompt (evaluator-style Q1 pass); F-4 VERDICT corrections + dated addendum; F-5
canonical docs dated; F-6 manifests carry wall-clock/kernel-call counts + the honest metered-usage
limitation; F-7 gates green + CI success on master `21bb5703`. The fix trail, one seam per attempt
(attempts 04–13 the honest record): `8fd7ddaa`, `3ee65713`, `8fd993f6`, `f704daf8`, `d38acf2d`,
`5283dbe9`, `539e60b6`, `284f186d`, `21bb5703`.

**F-8 DONE:** the owner approved in conversation; the audited restart ran 10:41:05Z (drainage
pre-flight passed), `/capabilities` verified on contract 1.44.0, the served bundle
`index-CKNTqq6X.js` matches the fresh build, and both Telegram messages verified `sent` (the
question and the completion/dogfooding go).

**Children:** none. No watches, no leases. No worktrees. The original campaign record below is
historical; read the §15.4 addendum in [`campaign/VERDICT.md`](./campaign/VERDICT.md) first.

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

1. Holdout validator (parent): author + freeze C10/C11/C22/C24 wording + fixtures — **done**
   (`8c4ed67e`; zero drift, both voices WER 0).
2. Cost the matrix from measured spend (≈2.5 h live; §10: 8 h / US$25) — the full matrix fits.
3. Campaign: 34 required cells (12 core ×2 arms, 4 holdout ×2, 2 soaks), one heavy runner, paired by
   ID, alternating arms with recorded seed; script ready at
   `/root/voice-lane-lab/campaigns/native-primary-20260922/run-campaign.sh`.
4. Evaluator pass for open-response episodes — **package frozen** (`campaign/EVALUATOR-PROMPT-v1.md`,
   sha256 `7f5d09f6…`, rubric + blinded pack protocol; pack builder
   `/root/voice-lane-lab/evaluator/build-pack.mts`). Awaiting the campaign's cell records.
5. Independent reviewer child (read-only) — **brief ready** (`children/RV/brief.md`).
6. Verdict + repository gates + canonical docs + Agent OS capture.

**Watching (zero-token):** none — all children settled. No process backstop needed (background-task cap saturated).
