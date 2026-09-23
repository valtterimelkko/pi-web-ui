# W4 campaign — verdict (draft, pending reviewer reconciliation)

**Status: `NO_CANDIDATE_MEETS_TARGET`** (rule 5) — the full required matrix is not met; the failing
boundary is named below with the smallest next experiment. Under the rule-4 tie-break, **standard**
is the recommended arm if that boundary is closed (ET shows no paired advantage).

Revision: `5fc3f1bb` (all fixes merged). **Budget, stated honestly:** the campaign loop + campaign
elapsed ≈7 h 47 m against §10's 8 h live wall-clock ceiling (~97% — inside, not "far inside"; it
exceeds 8 h if W4 harness-development live runs are counted). **Monetary spend is not verifiable:**
every manifest records `budget.meteredUsage: "not exposed by this server build"` and the ledger's
spend ledger was never kept, so the US$12 campaign / US$25 all-in ceilings cannot be confirmed or
refuted from the records. Wall-clock and kernel call counts (70 provider-call events across the 34
authoritative attempts) are the evidenced quantities.

## Planned vs completed matrix (34 required cells)

| Group | Cells | Standard | ET-HIGH |
|---|---|---|---|
| Core (12 episodes × 2 arms) | 24 | 11/12 accepted | 9/12 accepted |
| Holdout (4 episodes × 2 arms) | 8 | 3/4 pass | 3/4 pass |
| Soak (10-min reconnect × 2 arms) | 2 | 0/1 | 0/1 |
| **Total** | **34** | **14/17** | **12/17** |

"Accepted" = the offline verifier **and** (for open-response episodes) the blinded evaluator pass
agree. Evaluator results (10 packs, prompt sha256 `7f5d09f6…`, blinding verified): 7 pass, 2 fail,
1 indeterminate — **C21 fails Q1 in BOTH arms** (the operator's "check the version number before
anything" precondition is never addressed; the reply substitutes monitoring talk) and **C16-et-high is
indeterminate** (a promise to check, no answer in the record). Per the plan, an evaluator fail or an
indeterminate is never an auto-pass, so those cells are not accepted.

Per-cell outcomes and every attempt: `CAMPAIGN-INDEX.json` + `campaign-summary.txt` (copied into this
directory; the raw attempt records — the authority — live outside the repo under
`/root/voice-lane-lab/campaigns/primary-mic-journeys/runs/<EPISODE>-<arm>/attempt-*`, and the
reviewer's reproduction of every one of them is in `../coordination/RV/`).

## Paired (discordant) comparison — the rule-4 test

Three discordant pairs out of 17 paired cells:

| Episode | Standard | ET-HIGH | Cause (diagnosed from the record) |
|---|---|---|---|
| C05 | pass | fail (1 pass of 3 attempts) | the chatty ET model talks over the operator's confirm; the echo guard suppresses the genuine confirm |
| C11 | fail | pass | the amendment wording ("Actually no — …") is classified `cancel`, cancelling the amendment's own proposal (standard run) |
| C16 | pass | indeterminate (evaluator) | ET promises a check but the record ends before the answer |
| C21 | fail (evaluator Q1) | fail (evaluator Q1) | concordant failure — the version-check precondition is unaddressed in both arms |
| C24 | pass | fail (0/2) | ET never produced the first candidate in either attempt |

**Majority of discordant pairs favour standard (3:1: C05, C16, C24 vs C11)**, not ET → rule 4:
report a **tie** and retain standard. No safety/critical-fidelity regression was found in either arm; the confirmation gate was
never widened by any of the campaign's fixes.

## The failing boundary (rule 5) and the smallest next experiment

Both soak cells fail on the same boundary: **after the mid-session voice-transport reconnect the
repeat relay produces no candidate within the deadline** (`deadline exceeded waiting for candidate`),
so the run terminates early and the duration/turn bars (≥10 min, ≥8 turns) fail with it. The
pre-reconnect pending proposal is **released** (the record carries `confirm_authorised` +
`delivery_attempt` + `delivery_receipt`), but the reviewer correctly notes the record does not carry a
`delivered` outcome for it, so no delivery claim is made here. The reconnect itself revives the lane
(~3.6 s, M2's utterance re-bind fix in place). Smallest next experiment: one focused
investigation of the post-reconnect relay path (is the second relay refused `unbound_source`, or does
the model not relay?), then a single soak re-run per arm — the harness, corpus and both arms are
otherwise ready.

## Safety and fidelity

- No authority breach: the confirmation gate (`talker/policy-core.ts`) was untouched by every fix
  merged during W4; the echo-guard changes only narrow *false* echo suppressions and keep the
  content backstop.
- No altered restrictions, no silent retargeting: C24's retirement guarantee is evidenced on the wire
  (`proposal_resolved {outcome: replaced}`) and the old proposal is never released after the switch.
- Defects found and fixed during the campaign (all RED-verified, independently re-verified by the
  conductor, with the RED reproduced at the parent): delivery receipts at submission (M3), the echo
  guard's speech-window rule (M4), the echo window's audio-only arming (M5), the soak utterance
  re-bind (M2), plus the conductor's talker-text quiescence and the C24 switch-tail/verifier update.

## Explicitly not claimed

- No production deploy, restart or live validation (owner gate: never).
- Audio proof level: E2 (labelled synthetic TTS seam, byte-equality enforced); E3/E4 not claimed.
- The worker-conductor demonstration proves voice can initiate and supervise through the existing
  worker — not Live-as-conductor superiority.

## Independent reviewer (read-only, `../coordination/RV/review.md` + `review.json`)

Verdict: **`supported-with-findings`** — all 34 cell verdicts were independently reproduced offline
(34/34, zero divergences; 24,382 artefacts re-hashed with zero mismatches), arm identity and
blinding were checked, and the campaign's central claims hold. Three **material** findings are
carried forward rather than smoothed:

1. **Holdout wording disclosure (F1).** The exact C10 t1 and C11 t1/t3 sentences were embedded in
   `server/tests/voice-live-lab/holdout-overlay.test.ts`, committed on the implementer lineage before
   the corpus freeze — so the ledger's earlier claim that the implementer lineage never saw the
   wording is **corrected here**: the wording reached that lineage, though the evaluated models never
   saw it, the episode files stayed empty, and no runtime path or non-holdout cell record contains it.
   C22/C24 wording is not in the test.
2. **C24 bar change mid-campaign (F2).** After C24 failed both arms, the audible-ack expectation was
   retired (director `79c0daed`, verifier `5fc3f1bb`) because M's merged product fix stops the lane on
   a switch, making an ack unreachable. The C24-standard pass exists only under the relaxed bar; both
   arms were graded under it, the rationale is in the commit messages and matches contract §3.2, and
   the reviewer reproduced both verdicts — but the decision is recorded here as a **post-hoc,
   explicitly-flagged** change, not a contemporaneous one.
3. **Spend unverifiable (F3).** See the budget paragraph above.

Minor findings (corpusHash is an ID-list hash not a content hash; the generic confirm wording is not
holdout-unique; one unfinalised L4-era attempt dir; STATE/ledger staleness) are recorded in
`coordination/RV/review.md` with their mitigations.

## Open items folded in at reconciliation

- Evaluator pass folded in (`../coordination/EV/evaluator.json` + `report.md`): 10 packs, 7 pass / 2
  fail / 1 indeterminate; C21 (both arms) and C16-et-high are not accepted.
- Independent reviewer folded in (`../coordination/RV/review.md` + `review.json`): verdict
  `supported-with-findings`, all 34 cell verdicts reproduced offline; its three material findings and
  two required corrections are applied above.
- The C05-et-high flakiness (1 pass of 3) and the C11-standard classifier finding are recorded, not
  smoothed: a failed cell stays failed in the index.
