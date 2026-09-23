# RV — independent reviewer report: W4 native-primary campaign

**Reviewer:** RV (read-only; did not build any of this; writes confined to this directory)
**Date:** 2026-09-23 · **Worktree:** `/root/pi-web-ui-wt-voice-rv` · **Campaign revision:** `5fc3f1bbdc40cc02b97ae0b5e334a8686af6d211` (matches `CAMPAIGN-INDEX.campaignRevision` and this worktree's HEAD)
**Machine-readable result:** `review.json` (same directory)

## Verdict

**`supported-with-findings`**

The campaign's recorded table is real: every one of the 34 required cells has an intact, finalised, hash-verified attempt record; I re-ran the repository's own offline verifier on all 34 authoritative attempts and reproduced every recorded verdict and exit code exactly; arm identity is confirmed for all 34 cells from independent server-side evidence, not just the recorded env; holdout wording leaked into no non-holdout cell; the evaluator packs are blinded and bound to the authoritative attempts. The five recorded failures are honestly recorded, not hidden.

The "with findings" is earned by three material findings: real holdout wording reached the implementer lineage before the freeze (contradicting a ledger claim); the C24 holdout's expected semantics were relaxed mid-campaign without a ledger entry, and C24-standard's pass exists only under the relaxed bar; and monetary spend cannot be verified from any record.

## Check results (all 34 cells — no sampling)

### 1. Integrity — PASS (34/34)

For every LAST (authoritative) attempt:

- Recomputed `sha256(manifest.json)` matches `manifest.sha256` — 34/34.
- `FINALISED` marker present and parseable — 34/34.
- All `artifacts[]` entries re-hashed and byte-counted: **24,382 files, zero hash mismatches, zero missing, zero unlisted extra files.**

Across the whole runs tree (all 230 attempt dirs, all eras): 229 finalised. The single exception is `C22-standard/attempt-01` (an L4-era hard hang, never finalised — honest incomplete history, superseded).

### 2. Offline re-verification — PASS (34/34)

`npx tsx scripts/voice-lane-lab/cli.ts verify <attempt-dir>` run for every cell's authoritative attempt at revision `5fc3f1bb`:

- **29 pass / exit 0, 5 fail / exit 1 — all 34 reproduce the campaign index exactly.**
- Fails: `C05-et-high` (waiting for candidate), `C11-standard` (waiting for presentation), `C24-et-high` (no proposal pending at switch + waiting for switch-retirement), `SOAK-10MIN-standard` and `SOAK-10MIN-et-high` (240 s/292 s < 600 s bar; 5 turns < 8; pending-work unresolved).
- Holdout cells graded through the frozen validator overlays; soak through the constructed `SOAK-10MIN` episode — both mechanisms worked as designed.

### 3. Arm identity — PASS (34/34), with a caveat

- `manifest.arm` == index arm == `armSelection.env.VOICE_LIVE_PROFILE` == `armSelection.requested` — 34/34.
- The records themselves carry no provider-side model metadata (the manifest's own note admits: "arm identity confirmation against the provider profile surface is child P's integration contract; not yet present on this build"). I went one level deeper: each manifest names its disposable server's `stateDir`, and the surviving `/tmp/voice-lab-journey-*/server.log` files record the VoiceLive session's resolved model. **Standard cells logged `gemini-3.8-live`; et-high cells logged `gemini-3.8-live-extended-thinking` — 34/34 matches, each log timestamp inside its attempt's manifest-recorded window.**
- Caveat (honest): those /tmp logs sit outside the hash-covered record set and are mutable. They are strong corroboration, not tamper-proof evidence. The code chain (plan env → boot env → `resolveVoiceLiveProfileId` → profile table) is verified in source.

### 4. Hint leakage — PASS with one finding (F1)

- The four holdout surface sentences appear in exactly the allowed places (`corpus/holdout/*.validator.json`, `corpus/voices/*.manifest.json` frozen fixture manifests) **plus one disallowed location**: `server/tests/voice-live-lab/holdout-overlay.test.ts` (finding F1 below).
- Committed holdout episode files carry empty text with `validatorFrozen: true`.
- Grepped every JSON/JSONL/TXT/MD file in **all 230 attempt directories** (not just last attempts): holdout wording occurs **only** in the four holdout cells' own records — zero leakage into any non-holdout cell.
- Minor (F5): the generic confirm "Yes, send it." is shared between holdout overlays and non-holdout C05/C18 (and appears in the ledger, one brief, and two unit tests). Generic approval phrase; no holdout-specific content.

### 5. Accounting

| Item | Value |
|---|---|
| Required cells | 34 (24 core + 8 holdout + 2 soak) |
| Cells with records | **34/34** — none missing, none skipped |
| Recorded verdicts | 29 pass / **5 fail** (C05-et-high, C11-standard, C24-et-high, SOAK×2) |
| Attempt dirs (all eras) | 230 (229 finalised) |
| Campaign-window attempts | 67 — **all finalised**, all superseded attempts retained |
| Campaign window | 12:08–15:51Z (3 h 43 m elapsed; 71.7 min active attempt time) |
| Fix loop | 02:10–06:15Z (~4 h 04 m) |
| **Loop + campaign elapsed** | **~7 h 47 m — inside the 8 h ceiling** |
| Whole-programme live elapsed | ~9 h 35 m if W4 harness-dev live runs (07:31–07:48 soak, 09:23–11:01 L5-era) are counted — exceeds 8 h under that interpretation |
| **Spend** | **NOT VERIFIABLE** — see F3 |

The high attempt counts on some cells (C05-et-high ×7, C01/C03-et-high ×6) were deliberate re-runs after product/harness fixes plus a flakiness check, each documented in the ledger — not silent infra retries. The C05-et-high flakiness (fail a05 / pass a06 / fail a07) is real and honestly retained, and the cell's authoritative (last) attempt is the fail.

### 6. Blinding — PASS

- 10 packs (`C09/C14/C15/C16/C21` × 2 arms) under `/root/voice-lane-lab/evaluator/packs/`.
- **No pack contains any arm-revealing string** (`et-high`, `standard`, `gemini-3.8-live(-extended-thinking)`, `VOICE_LIVE_PROFILE` all absent).
- The label→arm mapping lives only in `evaluator/mapping.json` (5/5 balanced); every pack binds to its cell's authoritative attempt.
- `EVALUATOR-PROMPT-v1.md` sha256 `7f5d09f6337c…` matches the hash claimed in STATE.md.

### 7. Falsification attempts — what held, what didn't

**Held:**
- Index ↔ cell logs ↔ raw records fully consistent; the ledger's 15:05 row ("11 of 12 cells pass" on `bb61cc1f`) is accurate for that chunk.
- Fixture text vs episode text (holdout overlays merged): 86 turns checked across the 34 authoritative attempts — **zero drift**.
- No cell graded against the wrong corpus: my uniform re-verification at `5fc3f1bb` re-graded every cell against the current corpus and reproduced every verdict.
- No "pass" rests on anything the raw record does not support — with the C24 nuance in F2.
- Uniform client build identity (`fb0f4685…`) across all 34 authoritative attempts; all ran 14:56–15:51Z, after the last product change (M5, 14:41Z), so the recorded table is a coherent single-product comparison.

**Didn't hold:** findings F1–F3 below.

## Findings

### F1 · material · hint-leakage — holdout wording reached the implementer lineage before the freeze

`server/tests/voice-live-lab/holdout-overlay.test.ts` embeds the **exact C10 t1 sentence** and the **real C11 t1/t3 sentences** (its C11 t2 is a shorter draft variant missing ", and cap it at thirty seconds"). It was committed 06:50Z (`757c93fe`) on L4's implementer branch — whose base predated the 06:26Z overlay commit — and merged 08:07Z; the corpus freeze commit `8c4ed67e` landed 08:24Z. The wording therefore reached the implementer lineage via prompt/steer, not git, and lives in merged repo code. This **contradicts the LEDGER's claim "The implementer lineage never saw this wording."** C22/C24 wording does *not* appear in the test. Mitigations: the evaluated models never had the wording; episode files are empty; no runtime path (runner/verifier) contains holdout sentences; no non-holdout cell record contains them.

### F2 · material · mid-campaign scorer/semantics change on C24, unrecorded at the time

After C24 failed both arms, `79c0daed` (15:29Z) removed the `await-switch-ack` director phase and dropped `responseMustContain: ["switched"]` from the frozen C24 overlay; `5fc3f1bb` (15:42Z — the campaign revision) retired the verifier's audible-ack check. **The C24-standard pass (attempt-05, 15:43Z) exists only under this relaxed bar**: attempt-04 (15:30Z) of the same unchanged product behaviour honestly recorded a verifier fail under the old bar. The passing flow is 3 director steps (speak t1 → harness switch-attachment → complete on the retirement frame); the spoken switch wording (t2) is never spoken in any C24 attempt, so the cell evidences the switch/retirement product mechanism, not spoken-switch understanding, and no delivery/store tail is exercised. Mitigations: the product change (M, `e3e9e0b5`, 11:16Z) made the ack unreachable *before* both re-runs; both arms were graded under the same relaxed bar, so the C24 arm comparison stays internally fair; the rationale is documented in the commit messages and is consistent with contract §3.2; my re-verification reproduces both verdicts. At this review's record snapshot the LEDGER contained no row recording the decision; a completion row added at 16:06Z (after the snapshot) names both commits post-hoc but still carries no contemporaneous decision rationale.

### F3 · material · spend unverifiable; spend ledger never kept

Every manifest records `budget.meteredUsage: "not exposed by this server build"`; the LEDGER's spend ledger reads "0 entries; running total US$0.00" despite plan §9 requiring dated rates and per-cell usage. The §10 ceilings (≤US$12 campaign, US$25 all-in) **cannot be independently confirmed or refuted**. Only wall-clock (§5 above) and kernel call counts (70 provider-call events across the 34 authoritative attempts) are evidenced. The ledger's "cost far inside ceilings" statements are plausible but unevidenced.

### F4 · minor · `corpusHash` is an ID-list hash, not a content hash

`journey-plan.ts:255` computes `schemaVersion + sha256(episode-ID list)` — every non-soak cell records the same `1-4232ac64…` regardless of wording/slot changes, and the mid-campaign C24 overlay edit changed no recorded `corpusHash`. Real content freeze is carried by git history, per-attempt `planHash`, and the verifier's re-grading (which I re-ran). The field name overstates what it binds.

### F5 · minor · holdout confirm wording not unique

"Yes, send it." is shared between holdout overlays (C11/C22) and non-holdout C05/C18 (also in LEDGER.md, one child brief, two unit tests). Generic approval phrase; no holdout-specific content.

### F6 · minor · ledger/STATE stale for W4

STATE.md still describes W4 as "opening" with M5 active; the LEDGER progression table's last campaign row is 15:05Z, predating the final chunks, the C24 verifier change, and the completed 34-cell table. The ledger's own "current state, read before acting" rule is currently unmet for W4.

### F7 · minor · one unfinalised historical attempt

`C22-standard/attempt-01` (L4-era hang) has no FINALISED marker. Superseded, honest; all 67 campaign-window attempts are finalised.

### F8 · material · verdict-draft makes a soak claim the record does not carry

Added at re-validation (16:2xZ), after the conductor's docs commits `73a20ff9..ce1d25b0` landed. `campaign/VERDICT.md` states the soak's pre-reconnect pending proposal "is released and delivered correctly". The recorded evidence carries "released" but **not** "delivered": the verifier PROBLEM reads `soak-pending-work-unresolved: pending proposal prop-1 was released after the reconnect but delivery/store evidence is missing`. An unsupported success claim inside the terminal verdict document; it does not change the `NO_CANDIDATE_MEETS_TARGET` status (both soak cells fail regardless), but the sentence must be corrected to match the record.

### F9 · minor · verdict-draft overstates budget headroom

`VERDICT.md` claims "Live wall-clock and spend remain far inside §10's 8 h / US$25". Wall-clock is inside but not "far inside": loop+campaign elapsed ≈7 h 47 m of the 8 h ceiling (~97%), and it exceeds 8 h if W4 harness-development live runs are counted. Spend remains entirely unverifiable (F3).

## Could not verify (explicit list)

1. **Monetary spend** against the US$12 / US$25 ceilings (F3).
2. **Per-attempt server build identity** — manifests pin the client build (uniform) but no server-dist hash; uniformity inferred from the freshness rebuild mechanism and from no server-source commits inside the authoritative window, not from a recorded hash.
3. **Immutability of the /tmp server logs** used for arm-identity corroboration — timestamp-consistent with every attempt's manifest window, but outside the hash-covered records.
4. **That the profile model strings name genuinely distinct live models** — rests on child P's live probe (ledgered 01:34Z); I did not re-probe the provider.
5. **Constructed SOAK turn texts** beyond what the verifier checks (moot for the verdict: both soak cells failed).

## Re-validation after re-dispatch (post-review conductor commits)

At the second dispatch I re-checked the inputs and extended the review over the conductor's post-review docs commits (`73a20ff9` verdict draft, `12191b8f` STATE, `07a47c49`+`ae0b0417`+`ce1d25b0` evaluator fold-in). All writes by this reviewer remain under this directory; no 01-questions.md was needed (no boundary was hit).

**Inputs unchanged:** worktree still at `5fc3f1bb` and clean; `CAMPAIGN-INDEX.json` unmodified (mtime 15:51Z, 34 cells). All original checks above stand as reported.

**Verdict-draft cross-check — the numbers and rule logic hold:**

- Matrix table (core 12/12 vs 11/12, holdout 3/4 each, soak 0/1 each; totals **15/17 vs 14/17**, i.e. 29 pass / 5 fail) matches my verified cell results exactly.
- Discordant pairs C05/C11/C24 at 2:1 against ET → rule-4 tie, retain standard; `NO_CANDIDATE_MEETS_TARGET` via rule 5 (soak boundary) — consistent with the plan's decision rule as summarised in LEDGER §10.
- C11-standard diagnosis is carried by the raw record: the amendment utterance was classified `utteranceClass: "cancel"` and `proposal_cancelled {reason: spoken_cancel}` fired on the amendment's own proposal (`prop-2`).
- C24's retirement wire evidence is carried: attempt-05 records `{kind: retirement, identity: prop-1, outcome: replaced}`; the old proposal was never released after the switch.
- **Two claims fail verification**: the soak "released and delivered correctly" sentence (F8) and the "far inside" budget claim (F9).

**Evaluator fold-in cross-check — claims verified against the EV artefact:**

- `coordination/EV/evaluator.json`: 10 label-keyed outcomes, **7 pass / 2 fail / 1 indeterminate**; C21 fails Q1 in **both** arms; C16-et-high indeterminate on Q1 — exactly as folded into the verdict. Accepted-matrix arithmetic (14/17 vs 12/17) and the 3:1 discordant set (C05, C16, C24 vs C11) recompute correctly under "accepted = verifier AND evaluator".
- Blinding held in the EV artefact (labels only). I decoded the labels against `mapping.json` as reviewer and confirm the arm attributions in the verdict are correct.
- Scope note: I verified the artefact's internal consistency and the fold-in's accuracy; I did **not** independently re-grade the 10 packs (no second evaluator run was in scope).

## Bottom line

The campaign's central claims — 34 cells run and recorded, verdicts reproducible offline, arms genuinely distinguished, holdouts un-leaked into cells, evaluator blinded, failures preserved — **are supported by the raw records and were independently reproduced here.** The conductor's post-review verdict draft is arithmetically and logically sound against the evidence, and its evaluator fold-in matches the EV artefact — with two corrections required (F8, F9). The three material findings concern process integrity around the comparison (holdout wording disclosure, the C24 bar change, spend accounting) plus one unsupported success claim in the verdict document, not the validity of the recorded pass/fail table itself. Before the verdict is finalised: correct the F8 sentence, restate the F9 budget line, and state the spend story honestly (measured cost not captured).

*All evidence referenced above is reproducible from: `inventory.json`, `integrity.json`, `verify-results.txt`, `arm-identity.json`, `holdout-grep-worktree.json`, `holdout-grep-records.json`, `blinding.json`, `fixture-text-check.py` output, and `per-cell-budget.json` in this directory.*
