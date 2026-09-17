# L6 Handoff — Adaptive Operator Instrument

**Child D, Voice Live Lab build sequence (plan §23 L6 row; intent §14.5, §18.1,
§20.1, §23; implementation plan §Phase L6).**
Committed on `master` as `30e2f5f`; the parent independently verifies and signs
off.

## What was delivered

| Deliverable | Path | Status |
|---|---|---|
| Mechanical director + rejection ledger + Gate 4 report | `scripts/voice-live-lab/lib/director.ts` | NEW |
| Adaptive simulator, prompt assembly, beat loop, entry gate, freeze extraction | `scripts/voice-live-lab/lib/operator-sim.ts` | NEW |
| `freeze` command | `scripts/voice-live-lab/cli.ts` | additive (new command only) |
| README (director, operator-sim, freeze, entry gate) | `scripts/voice-live-lab/README.md` | updated |
| Director tests | `server/tests/voice-live-lab/director.test.ts` | NEW (51) |
| Operator-sim tests | `server/tests/voice-live-lab/operator-sim.test.ts` | NEW (49) |
| Freeze tests | `server/tests/voice-live-lab/freeze.test.ts` | NEW (25) |

Nothing in `server/src/**`, any production service, or any existing scenario
file was touched. `scheduler.ts`, `record.ts`, `scenario.ts`, `worlds.ts` and
`fixtures.ts` were read and reused unchanged. Run records and frozen variants
are written only outside the repositories (`…/04-voice-live-lab/runs/…`).

## 1. `director.ts` — mechanical validation, no model call

The simulator is the only measurement component with **no oracle**, so the
director is the code-level answer: it decides whether a proposed line is
*legal* under the beat's declared policy, not whether it is a good line.

**JSON shape (Zod).** `say: string | null`, `interrupt: boolean`,
`waitMs: integer 0–4000`, `beatDone: boolean`, `why: string`. Unknown keys are
stripped rather than rejected: a model volunteering a little extra bookkeeping
is not the failure mode the 20 % ceiling exists to catch, and a strict schema
would manufacture instrument noise. (This is the one deliberate leniency;
everything else fails closed.)

**Length.** `say` ≤ 60 words when non-null.

**Style / language.** en-GB spoken prose. Rejects raw markdown (backticks,
headings, bold, links, list items, code fences), words/paths spelled out
character by character (`c-o-n-f-i-g`, two or more of
slash/backslash/underscore/hyphen), and a conservative list of unambiguous
American spellings. The British-spelling rule is gated on the scenario's
`language`, so a future non-en-GB variant keeps its markdown/path bans but not
that one. The Americanism list is deliberately spelling-only: a colloquialism
("gotten", "math") is not evidence of a non-British *phrasing*.

**Permissions.** A confirmation-shaped `say` is decided by the **shipped
talker classifier** (`server/src/talker/utterance-classifier.ts`) — so the
lab's policy and the product's gate can never drift into two definitions of
"yes". A confirmation is allowed only when (a) the beat grants a `confirm:*`
or `card:confirm` permission **and** (b) `heard` contains an assistant proposal
or an invitation-shaped question. A question that is not an invitation ("what
is worker two doing?") is not a pending proposal. Otherwise:
`permissions-violation`.

**Golden-truth leakage.** Hidden facts (`world.hiddenTruth`, the same
`goldenStringsFor` the offline verifier uses) may be *referred to* only after
they have been revealed in `heard` or the operator's own earlier lines;
matching is a contiguous whole-word run, so "holding" does not match "hold".
**A leakage rejection never persists the offending text** — neither in the
ledger entry nor in the rejection event — because the offline verifier fails a
record in which a golden string appears anywhere in the trace. The rejection
detail is worded so it names no fact, and the re-ask prompt therefore cannot
carry the leak either.

**Disallowed interrupt.** `interrupt: true` needs `beat.interrupt === true` or
a `stop-talker` grant.

**Turn budget.** Per-beat (`beat.maxTurns`) and per-run
(`budgets.maxOperatorTurns`). A *spoken* turn consumes budget; a silent or
beat-done move does not, so the model cannot exhaust a beat by staying quiet.

**Refusal precedence** is fixed and documented so the by-reason breakdown is
reproducible: `json-shape` → `turn-budget` → `style-violation` →
`over-length` → `permissions-violation` → `golden-truth-leakage` →
`disallowed-interrupt`.

**Ledger and the pre-registered ceiling.** Every validation call is a proposal
(so a re-ask counts too — that is what lets a bad simulator shrink the sample
visibly). `RejectionLedger` reports the rate, the by-reason counts, and
`insufficientEvidence()` — true only when the rate is **> 20 %**, not ≥, since
the ceiling is a refusal threshold and not a target. `evaluateInstrument`
aggregates it with the beat outcomes: `simulator-failure` beats (and
`missed-condition` beats, §14.2) are listed as `excludedBeats` and removed from
`scorableBeats`, and `adaptiveOnly` flags a headline that would rest on
adaptive beats alone (§20.1(a)).

## 2. `operator-sim.ts` — the adaptive simulator

- **Persona** shipped verbatim from the L6 brief, exported as `DEFAULT_PERSONA`.
  A calibrated persona replaces it by *version*; changing it invalidates
  comparability with earlier adaptive attempts.
- **Prompt assembly** matches §14.5 line for line: persona first (the
  `<persona>` placeholder filled, like `<beat.goal>`), then `GOAL FOR THIS
  BEAT`, `YOU MAY`/`YOU MAY NOT`, the heard list (one line per played segment,
  `[3.2s] assistant: … [interrupted]`), `YOUR EARLIER LINES`, then the exact
  JSON contract. Permissions are rendered in plain words; empty permissions say
  plainly that nothing may be authorised.
- **Default seat** `commandcode/deepseek/deepseek-v4.1-flash` @ `high` @ 0.7
  (the brief's default; `zai/glm-5.3-flash` @ `high` or the GLM peak-window
  twin stay selectable via options). `temperature` is 0.7 as §14.5 specifies —
  a *different* value from the judge's 0.
- **Re-ask protocol.** One rejection → re-ask once with `formatReAsk` appended
  ("… rejected by the director because: `<reason>: <detail>`. Please revise your
  response to respect the rules."). A second consecutive rejection ends the beat
  as `simulator-failure`. Unparseable JSON is a `json-shape` rejection and takes
  the same path; fenced/prefixed JSON is tolerated.
- **Latency segregation.** Model time and optional TTS time are measured and
  written to a dedicated `operator_reaction_latency` event flagged
  `excludedFromCandidateLatency: true`; `operatorLatencyFromEvents` reads the
  samples back and `operatorLatencyIsSegregated` asserts every reaction in a
  trace is flagged. The simulator never writes an `input_frame`, so it cannot
  appear in candidate-side accounting.
- **Event vocabulary** (all `source: operator` unless noted):
  `operator_beat_start`, `operator_turn_prompt` (prompt **hash**, not text),
  `operator_proposal`, `director_rejection` (source `director`),
  `operator_heard`, `operator_line` (carries `provenance: synthetic`, the
  fixture id/hash/bytes/duration, the `why`), `operator_reaction_latency`,
  `operator_beat_done`, `simulator_failure`.
- **Beat loop** `runAdaptiveBeat(operator, port, {beat})` terminates in exactly
  one of `completed` / `simulator-failure` / `budget-stopped`, driving a small
  port (`speak`, `wait`, `heard`) so a harness can wire it without this module
  knowing about sockets.
- **Hermetic transport.** `ScriptedSimulatorClient` replays queued replies,
  records every request and throws when the script is exhausted — no network,
  no key.

## 3. Gate 4 — the instrument entry gate (§14.5 rule 1)

`runInstrumentEntryGate(operator, cases)` drives the simulator against
frozen/branching cases whose correct next line is known and returns agreement +
rejection-rate evidence. Agreement is token-F1 between the known line (or a
declared acceptable alternative) and what was said; a case counts as reproduced
at ≥ 0.6, and the gate passes only when ≥ 80 % of cases reproduce **and** the
rejection rate is inside the pre-registered ceiling. The known line is never
placed in the prompt, and a frozen beat's golden `utterance` is stripped from
the prompt beat, so the gate cannot be passed by reading the answer out of its
own script. A `simulator-failure` case is recorded as `spoken: null`
(agreement 0) and never silently skipped.

This is the code half of Gate 4. The *live* half — driving a real simulator
seat against the frozen/branching beats and recording the two numbers — is a
scheduled, token-spending run for the parent, not a hermetic code task; the
entry gate is deliberately structured so that run is a single call plus a real
client.

## 4. `cli.ts freeze` (§14.5)

```
voice-live-lab freeze --attempt <id|dir> --beat <id> [--runs-root <dir>]
                      [--output <path>] [--allow-promotion --promotion-note <text>] [--json]
```

- `--attempt` is an attempt id searched under `--runs-root` (bounded, depth ≤ 4,
  must contain a `manifest.json`) **or** a direct attempt directory.
- Reads `manifest.json` and the event log it names (`manifest.eventLog`, default
  `application/events.jsonl`), plus `scenario.json` when the runner wrote one.
  A damaged log is refused rather than partially frozen.
- Extraction is read back from the append-only log, never inferred:
  `operator_line` events for the beat become `syntheticLines`, their
  `operator_reaction_latency` becomes `reactionLatencyMs` (linked by
  `causedBy`), their fixture metadata becomes `fixtures`, and `operator_heard`
  events tagged for the beat — plus untagged ones inside the beat's
  start→done window — become `heard`. Another beat's lines are never included.
- Output keeps `provenance: synthetic` **on both the scenario and the beat**,
  records `sourceAttempt`/`sourceBeat`/`sourceScenario`, and is
  `syntheticBackboneEligible: false` by default. Promotion needs **both**
  `--allow-promotion` and a non-empty `--promotion-note`; the flag alone is
  refused, and even a promoted variant keeps `provenance: synthetic`. The
  variant carries a `manifestNote` fragment a run record can adopt (the attempt
  manifest itself is immutable and is never rewritten).
- Output defaults to `runs/<run-id>/frozen/<variant-id>.json`, is written once,
  and is never overwritten. `assertSafeRunRoot` guards the destination, so the
  command cannot write into a repository.

## 5. Verification (run on this checkout, 2026-09-17)

| Gate | Command | Result |
|---|---|---|
| Lab suite | `cd server && npx vitest run tests/voice-live-lab` | **17 files, 375/375 passed** (was 250 before this phase; +51 director, +49 operator-sim, +25 freeze) |
| Lint | `npx eslint <the six owned files>` | 0 errors, 0 warnings |
| Lint ratchet | `npm run lint:ratchet` | `violations: []`, warnings 324 ≤ ceiling 326 |
| Typecheck | `npm run typecheck` | see §5.1 |
| Build | `npm run build` | see §5.1 |

### 5.1 Notes on the scripts-inclusive compile

`npm run typecheck` covers the four workspaces; `scripts/**` is outside it (a
pre-existing condition recorded in the L5 handoff). A scripts-inclusive
`tsc --noEmit --strict` over the changed files reports **zero diagnostics in
`director.ts`, `operator-sim.ts` and the new `cli.ts` code**; the remaining
diagnostics are the pre-existing ones in `worlds.ts`, `handshake.ts`,
`tier1-dryrun.ts`, `baseline-dryrun.ts`, `providers/gemini-live.ts`,
`providers/baseline-cascade.ts`, `harness/tier1-guarded.ts` and `cli.ts`'s
shared `runAttempts` callback — all outside this phase's scope and untouched.
The workspace `typecheck`/`build` results are recorded in the commit message.

## 6. Design decisions worth recording

1. **The director reuses the shipped classifier.** `isConfirmationShaped`
   delegates to `utterance-classifier.ts` rather than growing a second
   confirmation vocabulary. This is the same choice L5 made for the tier-3
   operator path.
2. **A leakage rejection redacts the offending text.** The offline verifier
   fails any record in which a golden string appears in the trace, so
   *preserving* the leak for debugging would fail the instrument's own run.
   The rejection is still fully attributed (`golden-truth-leakage`, with a
   non-revealing detail).
3. **Unknown Zod keys are stripped.** Stated in §1; the alternative inflates
   the rejection rate and makes the instrument look broken on beats where the
   candidate is fine.
4. **Turn budget counts spoken turns only.** A silent/beat-done move is legal
   and free; `runAdaptiveBeat` bounds silent looping instead.
5. **`violence` risk: the Americanism list is the one rule that could
   false-positive on a legitimate informal line** ("color"). It is
   spelling-only, conservative, and gated on `language`; if the entry gate ever
   shows it firing on lines a human would accept, narrow the list rather than
   raising the ceiling — a tuned ceiling is exactly what §14.5 pre-registers
   against.

## 7. For the parent

- Next step for L6 in the plan's own words is the **live half of Gate 4**: run
  `runInstrumentEntryGate` with a real simulator client (default seat
  `commandcode/deepseek/deepseek-v4.1-flash` @ `high`, or the GLM twin in the
  peak window) against the frozen and branching beats, record agreement and the
  rejection rate by reason, and either start L6's adaptive attempts or report
  `insufficient-evidence`. That is a scheduled, token-spending run — not part of
  this hermetic phase.
- The `b9`-style adaptive beats themselves are scenario authors' work in
  `/root/agent-benchmarks/benchmarks/04-voice-live-lab/scenarios/tier1/`. The
  schema already accepts `mode: "adaptive"` with `goal`, `maxTurns` and
  `permissions`; this phase builds the instrument, it does not add beats to
  existing scenario files (those paths are outside this child's ownership).
- Commits: this phase is `30e2f5f` on `master` in `pi-web-ui` (pushed to
  `origin/master`); no other path was touched. Nothing was deployed and no
  production service was restarted.
- An Agent OS capture for this phase is best taken by the parent at sign-off,
  together with the L4/L5 rows.

---

FROZEN-HANDBACK: Phase L6 Adaptive Operator Instrument Complete.
