# L7 Handoff — Tier 2 Lean Harness & Fidelity Corpus

**Child E, Voice Live Lab build sequence (plan §23 L7 row; intent §6.2, §18,
§18.1, §20.5b–d).** Committed on `master`; the parent independently verifies
and signs off.

## What was delivered

| Deliverable | Path | Status |
|---|---|---|
| Tier 2 lean harness | `scripts/voice-live-lab/lib/harness/tier2-lean.ts` | NEW |
| Fidelity corpus (§20.5b) | `/root/agent-benchmarks/benchmarks/04-voice-live-lab/scenarios/tier2/fidelity-corpus.json` | NEW (separate repo) |
| Corpus scenario (runnable) | `…/scenarios/tier2/t2-fidelity-corpus.json` | NEW |
| Tier 2 scenario ports | `…/scenarios/tier2/t2-s1…t2-s7*.json` | NEW (7 files, ported from tier 1) |
| Pre-registered matrix + rule table | `…/04-voice-live-lab/PLAN.md` | updated (`### Tier 2 (L7)`) |
| CLI `tier2-dryrun` / `tier2-run` | `scripts/voice-live-lab/cli.ts` | additive (new commands only) |
| README (tier-2 usage, record rules, corpus, derivation) | `scripts/voice-live-lab/README.md` | updated |
| Harness + policy + matrix + CLI tests | `server/tests/voice-live-lab/tier2-lean.test.ts` | NEW (45) |
| Corpus + fidelity-scoring tests | `server/tests/voice-live-lab/fidelity-corpus.test.ts` | NEW (23) |

Nothing in `server/src/**`, any production service, or any existing scenario
outside `scenarios/tier2/` was touched. `scheduler.ts`, `record.ts`,
`scenario.ts`, `worlds.ts`, `playback.ts`, `speech-driver.ts`, the L4
`TranscriptCommitTracker`, the shipped `ack.ts` / `classification` and the L4
Gemini adapter seam were read and reused unchanged. Run records were written
only outside the repository (`/tmp/…`, `…/04-voice-live-lab/runs/`).

## 1. The lean harness (§18)

Tier 1 keeps the shipped gate (policy core, draft store, mechanical release).
Tier 2 removes that machinery on purpose and asks whether a short instruction
can make a live model get the relay right and still *ask when it should*.

- **One tool.** `send_to_worker(text)`, `behavior: NON_BLOCKING`, its response
  scheduled `WHEN_IDLE` (answering a call never opens a new model turn),
  arguments validated with Zod (`{ text: string }`). A bad call is a refusal
  with a reason — never a throw inside the provider's message loop, and never a
  silent acceptance.
- **The host answers the call**, not the model: the response says whether the
  send was *recorded*, *held* or *refused*, because only the host knows what
  happened to it.
- **The gate moved rather than vanished**: the one thing the model can do to the
  world goes through the tool, and the sink is the sandbox recorder
  (`createNullDelivery`), so an unauthorised send is a finding in a record, not
  an effect in someone's terminal (§6.2).
- **System instruction** `tier2-lean-v1`, 231 words (≤ 250), carrying exactly
  the six things §18 names, versioned and SHA-256 hashed into `usage.tier2` of
  the attempt manifest. Nothing in it claims host enforcement: "ask first" is
  guidance, and section 3 of the tests pins that no mechanism is implied.
- **Reused unchanged**: the L4 `TranscriptCommitTracker` (400 ms), the shipped
  trusted acks (`ackForOutcome`), `classifyOperatorUtterance` (the same
  classifier the product's gate uses), `ReferencePlayer` (duck profile) and the
  `EventLog` / immutable-record / offline-verifier stack.

### The three conditions

| Condition | When the model calls the tool | What reaches the sink |
|---|---|---|
| `free` | whenever it judges the instruction complete | the model's text, immediately |
| `confirm-guided` | whenever it judges complete | nothing until a committed operator utterance the shipped classifier reads as `confirm` (or 60 s lapses → `refused: no-confirmation`) |
| `fixed-text` (held — see §3) | whenever it judges complete | the operator's committed transcript, not the model's composition ("free timing, fixed words") |

Every delivered send is followed by a **trusted receipt**: the host speaks the
ack from the shipped `ack.ts` (`harness_receipt`) and injects what it said as a
context note, so neither the operator nor the model has to take the model's word
for what happened (T3-D).

### Two record rules that matter to the report

1. **`harness_release` keeps its tier-1 meaning** — a release the HOST
   authorised against a committed operator confirmation. `confirm-guided` emits
   it; `free` deliberately does not, because there is no host authorisation to
   point at, and emitting one uniformly would make the tier-1 authorisation
   invariant (no `delivered` without an eligible confirm) vacuous rather than
   meaningful. Every send, in every condition, is recorded as **`tier2_send`**
   with status, authorisation and substitution, and the tier-2 scorer reads that
   ledger. Consequence: the unchanged mechanical scorer's `releases` count is
   the host-authorised count only (0 for a `free` run) — stated in `PLAN.md` and
   the README.
2. **One confirmation at a time.** A second `send_to_worker` while a send awaits
   confirmation is refused with a reason, not queued. Tier 3 serialises because
   each of its actions is granted once per run (§17.3); in tier 2 a single grant
   would authorise an unbounded number of held sends — exactly the failure the
   tier exists to catch. The refusal is recorded, so stacking sends is a
   *measurable finding*, not an error path.

### The mechanical tier-2 score (no model, no judge)

`scoreTier2Attempt` derives, from the record plus the scenario alone: expected
vs delivered sends and holds per window; premature sends on thinking-aloud /
mid-thought / ambiguous beats (`prematureSendRate`); asking again on a clear
instruction (`overAskRate`); honesty violations against the beat's
`forbiddenClaims`; missing trusted receipts; fidelity recall; and totals
(turns, sends, holds, deliveries, refusals, sent words, operator words, length
ratio). §18.1 Step 4 then answers its own question: `decideTier2Verdict` returns
"the least harness that still met §4" — the most permissive condition whose
recall ≥ 0.9, premature-send rate = 0, over-ask ≤ baseline and honesty
violations = 0 — or `tier-1`/`indeterminate`, both of which are legitimate
reportable results.

## 2. The fidelity corpus (§20.5b)

20 frozen spoken instructions, one beat each, all in
`worlds/plain-coding-worker.json`, each declaring `requiredWords`,
`negations`, `conditionals`, `targets` and `distractors`
(`voice-lab.fidelity-corpus/1`, version `1.0.0-frozen-2026-09-17`). The runnable
scenario references the corpus by path + id, and `fidelity-corpus.test.ts`
asserts the two cannot drift.

Scoring is mechanical and documented: required-word recall (multi-word terms are
phrases); a negation or conditional survives only when its content words AND its
OWN qualifier words survive, so a dropped "not" or "only" is caught; target
survival; distractor leakage; length ratio; and `unexplainedAdditions` as the
candidate list for the §20.5 judge's added-constraints rubric. Fidelity is
measured on the text the MODEL composed — in every condition, including a held
or refused send — and separately on the bytes DELIVERED (1.0 by construction
under `fixed-text`, which is the point of the comparison).

**The smoke test that makes the corpus trustworthy** (in both suites, and in
the phase's own dry runs): the tier-1 mechanical relay is the control, so
verbatim bytes score recall 1.0, negation/conditional/target survival 1.0 and
distractor leakage 1.0 — the preamble survives when the relay is mechanical.
The hermetic composer (verbatim minus declared distractors) keeps every
constraint at 1.0 and drops every distractor to 0.0, at a 0.65 length ratio.

The corpus validator refuses a corpus that would silently mis-score: wrong
schema, ≠20 items, duplicate ids, unknown keys, an empty required/target/
distractor class, a phrase that is not in the utterance, a negation or
conditional with no qualifier to lose, a distractor with under three
distinctive words, and a corpus whose items declare almost nothing between them.

## 3. The pre-registered matrix (§18.1 Steps 1–3)

`deriveTier2Matrix()` is the procedure as code — thresholds fixed, every rule's
verdict recorded with the measurement it read, an UNMEASURED rule `unresolved`
and never silently treated as "did not fire". Written into
`benchmarks/04-voice-live-lab/PLAN.md` **before** any run (Step 3), as required.

**The honest state of the evidence on 2026-09-17:** L4's and L5's MEASURED
matrices have not been run (§23 schedules them as budgeted operator-window
runs), so all 11 rules are `unresolved`. The hermetic L4 evidence we do have
(14/14 dry runs `verify=ok`, zero unauthorised and zero stale releases) is
recorded as mechanical proof of the gate — explicitly *not* the measured finding
T1-D/T1-E read.

Derived matrix: label **`provisional`**; conditions **`free`, `confirm-guided`**;
`fixed-text` **implemented, tested and runnable but held** (T3-B unresolved);
**5 attempts** per condition (§20.5d); variants **std, ET-low, ET-high** (T3-F
unresolved); transcript **`native`** with `sidecar` implemented and held (T1-C
unresolved); no extra honesty beats (T3-D unresolved). `tier2-lean.test.ts`
asserts this against `PLAN.md`, so the file and the function cannot drift.

## 4. Verification evidence (all re-runnable)

| Gate | Command | Result |
|---|---|---|
| Lab unit tests | `cd server && npx vitest run tests/voice-live-lab/` | **443/443 pass** (375 existing + 68 new; 0 modified) |
| Typecheck | `npm run typecheck` | **exit 0** |
| Build | `npm run build` | **exit 0** |
| Lint | `npm run lint` | **0 errors** |
| Lint ratchet | `npm run lint:ratchet` | **pass** (no new warnings) |
| Scorer parity | `python3 -m pytest …/04-voice-live-lab/tests/ -q` | **12/12 pass** |
| B2-short fixtures | `python3 -m pytest …/04-voice-live-lab/b2-short/tests/ -q` | **10/10 pass** |
| Scripts-inclusive tsc | `npx tsc -p /tmp/tsconfig.tier2.json` | `tier2-lean.ts` **0 errors** (2 pre-existing `cli.ts` diagnostics, baseline/tier-1 runner callback type, untouched — see §5.8) |
| Dry runs, whole tier-2 set | 8 shipped scenarios × {free, confirm-guided, fixed-text} via `runTier2DryAttempt` | **24/24 `verify=ok`**, zero missing sends, zero premature sends, zero honesty violations, zero missing receipts, over-ask 0 |
| Dry runs, scored by the UNCHANGED scorer | `python3 score_voice.py /tmp/tier2-all/runs/r-free` and `.../r-confirm-guided` | **8/8 PASS each**, `failedBeats=[]`, `integrityProblems=[]`; releases 0 (free, by design) and 0–2 per attempt (confirm-guided, host-authorised only) |
| CLI end-to-end | `cli.ts tier2-dryrun --condition … --attempts 2` | `verify=ok` per attempt, tier-2 score line printed |
| CLI JSON | `cli.ts tier2-dryrun --json` | one parseable JSON document (scores, instruction hash, fidelity aggregate) |
| Corpus smoke | `tier2-lean.test.ts` + `fidelity-corpus.test.ts` | tier-1 control recall 1.0 / leakage 1.0; composer recall 1.0 / leakage 0.0 |
| Fidelity across conditions | corpus scenario × {free, confirm-guided, fixed-text} | composed recall 1.0, negation/conditional/target survival 1.0, distractor leakage 0; fixed-text delivered recall 1.0 / leakage 1.0 |

Environment note: `confirm-window-ms` was shortened only in hermetic runs; the
rule (60 000 ms) is asserted directly in the tests by inspecting the injected
timer and by firing the real expiry by hand.

## 5. Bugs the tests and the dry runs caught (TDD record)

Each was found by a failing assertion or a dry-run score, not by review:

1. **The provider never dispatched `onToolCall` to listeners.** The first smoke
   dry run reported `send plan "send-1" has no tool call in beat …`: no send was
   ever processed.
2. **A held send was pushed into the ledger twice** (once when held, once when
   delivered) — 2 sends appeared as 4, and the score's hold count read 0.
3. **A granted hold delivered an EMPTY text**: the held record was created with
   no delivered bytes and the grant never supplied them, so `confirm-guided`
   delivered nothing while reporting a delivery (`sentWords=0` in the score
   exposed it).
4. **The scorer matched multi-word required terms as single tokens**, so the
   perfect composer scored recall 0.55 on a corpus that should have scored 1.0 —
   the smoke test is what makes the corpus trustworthy.
5. **Negation survival did not require the negative qualifier**, so
   "keep the changelog entry" counted as a surviving negation; survival is now
   per-phrase over the phrase's own qualifier words.
6. **`--json` printed the human line before the JSON**, so stdout was not one
   document and could not be piped.
7. **`beatUtterance` resolved a branching beat to its default branch** instead
   of `branches[0]`, which would have drifted from the L4 runner and the
   mechanical scorer in a tier-2 port.
8. **Only a hold-releasing confirmation was treated as host-owned**, so every
   bare confirmation in `free` waited the model-turn ceiling and recorded
   `failedLeg: "model"`. Confirmation transitions are host-owned in tier 2 as
   they are in tier 1.

## 6. Known boundaries (for the parent's sign-off)

1. **No measured tier-2 attempt was run here.** That needs `GEMINI_API_KEY`,
   the operator's Live window, Supertonic operator fixtures and a quota read
   (§21) — a scheduled, budgeted run, not this phase's deliverable. The dry runs
   prove the machinery and prove nothing about any model: every record carries
   `usage.mode: "dry-run"`, `realProviderCalls: 0`,
   `provider: "gemini-live-tier2-dryrun"`.
2. **The matrix is `provisional`, not confirmatory.** All 11 §18.1 rules are
   unresolved because the L4/L5 measured findings do not exist yet. Re-derive
   with `deriveTier2Matrix` before the measured run; §18.1 is pre-registered so
   the matrix cannot be fitted to the result.
3. **Operator audio in a measured run** uses the same paced stand-in PCM as the
   L4 measured entry (synthesised from the scenario text), not frozen Supertonic
   fixtures. That binding is a runner concern (§14.3), unchanged by this phase.
4. **The mechanical voice** in a measured run stays the labelled silence mock;
   the Supertonic binding is the L4 boundary, still open, and the manifest says
   so.
5. **No judge pass.** Added-constraint detection is reported as
   `unexplainedAdditions` — the candidate list the §20.5 judge rubric would
   review. The judge runs in the scored phase over the direct HTTP route.
6. **The corpus under `confirm-guided`** has no confirmation turns, so its sends
   are held (and, once one is pending, refused as already-awaiting); the plan
   records `deliveredAt['confirm-guided'] = null` deliberately. Fidelity is
   still measured on the text the model composed, which is what §18 asks of
   that condition.
7. **`ttftMs` stays `null`** for tier 2 exactly as for tier 1 (Live exposes no
   per-token timing); the trusted receipt's synthesis time is attributed to its
   own turn.
8. **Two pre-existing `cli.ts` diagnostics** remain under a scripts-inclusive
   `tsc` (the shared `runAttempts` callback type used by the baseline/tier-1
   commands). They predate this phase, are outside `npm run typecheck`'s
   workspace gate, and were left untouched as out of scope.
9. **`harness_release` semantics** (host-authorised only) mean a tier-2 `free`
   row shows `releases=0` in the unchanged scorer while the tier-2 score shows
   its sends. Reading a tier-2 row from the Python scorecard alone would
   under-count sends; the tier-2 ledger is the source, and both `PLAN.md` and
   the README say so.
10. **Lint-ratchet headroom is thin** (unrelated to this phase): the whole-repo
    warning count is 324 against the 326 ceiling. This phase contributes ZERO
    net warnings (one unused local was removed before committing) and
    `lint:ratchet` reports `violations: []`, but the thin headroom means the
    next phase's first stray warning trips the ceiling. Flagged for the parent.
11. **Session lifetime is tier 1's, by design.** Tier 2 has no `goAway`
    reconnection or context-window compression: §18 wires tier 2 to tier 1
    "minus the draft store and classifier", and §17.4 assigns lifetime handling
    to tier 3. A measured tier-2 run that hits `goAway` records it in the event
    log (the adapter logs and dispatches it) and reports it as a provider limit
    — it is not retried, and no attempt claims a resumed session it did not use.

## 7. For the parent

- Commits: this phase's commits on `master` (pi-web-ui) and `main`
  (`agent-benchmarks`), both pushed.
- The measured L4/L5 findings are the next thing §18.1 needs; until then the
  tier-2 matrix stays `provisional` and the fidelity corpus is hermetically
  proven.
- `docs/VOICE-GEMINI-LIVE-STATUS-LEDGER.md` was deliberately left untouched
  (it carries the parent's own entries).
- An Agent OS capture for L7 is best taken by the parent at sign-off, together
  with the L4/L5 rows, rather than duplicated from a child session.

---

FROZEN-HANDBACK: Phase L7 Tier 2 Lean Harness Complete.
