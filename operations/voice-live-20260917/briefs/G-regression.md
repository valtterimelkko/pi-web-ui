# Brief G — lean deterministic safety regression suite (plan Phase 6 = Track G)

**Session:** assigned at dispatch. **Worktree:** `/root/pi-web-ui-wt-regression` (branch `feat/voice-regression`, based on master after **Wave 1** merged). **Runtime:** pi. **Model:** assigned at dispatch (deepseek-v4.1-flash pool rotation); thinking `high` (no `max` needed).

## Bounded outcome

The permanent, fast, **hermetic** automated regression harness that enforces every safety veto gate
and verifies the 20-utterance fidelity corpus. Tests only: you may not change kernel or service
behaviour. A real defect you discover becomes a correction brief to the conductor, not an edit.

## Read first

- `docs/VOICE-MODE-EXECUTION-PLAN.md` §Phase 6 (your tasks and Gate 6, verbatim).
- `docs/VOICE-MODE-INTENT.md` §9 (speech policy), §16 (four objects), §18.2 (read-back rule).
- `docs/plans/VOICE-LIVE-WIRE-CONTRACT.md` §3.4 + §4 (the confirm rule and fail-closed codes).
- **What Wave 0 already delivered (Track D)** — you extend it, you do not restart it:
  `server/tests/regression/harness/run.ts` (the veto runner: a suite with **zero checks fails**, a
  single failing check fails the suite, no thresholds, no skips),
  `server/tests/regression/harness/corpus.ts`,
  `server/tests/regression/fidelity-corpus.test.ts`,
  `server/tests/fixtures/fidelity-corpus.json` (the frozen 20-utterance corpus),
  and Track D's handback at `/root/voice-exec-20260917/coordination/D/complete.md` plus its audit
  notes under `operations/voice-live-20260917/`.
- **Track A's kernel** (`server/src/talker/*`: `utterance-classifier.ts`, `pending-proposal.ts`,
  `proposal-store.ts`, `release-store.ts`, `parking-lot.ts`, `policy-core.ts`) — read-only, the
  behaviour under test.
- **Track B's service** (`server/src/voice/voice-router.ts`, `voice-session.ts`) — read-only; its
  schema-exact envelope refusals are part of the veto surface.

## Deliverables (owned paths: `server/tests/regression/**`, `server/tests/fixtures/fidelity-corpus.json`)

1. **`server/tests/regression/safety-veto.test.ts`** — fast, hermetic, driver-of-the-real-code unit
   tests proving every unsafe state fails closed. At minimum, exactly the plan's six:
   - doubt (`"not sure"`) → `cancel` / `statement`, never confirm;
   - conditional agreement (`"yes, but wait"`) → `statement`, never confirm;
   - stale / tampered proposal (SHA mismatch) → `refuse`, never deliver;
   - replay (repeated idempotency key after a release) → `duplicate_refusal`, exactly-once;
   - disconnect safety (mid-speech disconnect never triggers dispatch);
   - lane isolation (a pending draft for lane/worker 1 does not release onto worker 2).
   Each check goes through `harness/run.ts`'s `RegressionCheck` contract (throw on failure). Add the
   **negative controls** that make the suite falsifiable: at least one check must be shown to fail
   when the guard is deliberately bypassed in a scratch copy (record the command and output in the
   handback; do not commit the bypass).
2. **`server/tests/regression/fidelity-corpus.test.ts`** — score the frozen 20-utterance corpus from
   `server/tests/fixtures/fidelity-corpus.json`: recognition WER, required-word recall, **100 %
   retention of critical negations and conditionals**, file paths, and semi-verbatim byte equality
   from recognised text to delivered instruction. Hermetic: the corpus carries the frozen recognised
   text; **no live provider calls** in this suite. If the fixture is missing a field you need, add it
   to the fixture **only** with provenance (source of the recognised text) recorded in the handback.
3. **Runner integration** — both suites execute through the D runner so the "zero checks = failure"
   and "one failure = suite failure" properties hold mechanically.
4. **Speed** — the whole `tests/regression/` directory must run in **< 20 s** (Gate 6's bound).

## Anti-cheat requirements (plan §Phase 6, binding)

- Every veto is an **absolute blocker**: a single failure fails the entire suite immediately. No
  threshold averaging, no retries, no skips (`it.skip`/`describe.skip`/conditional early return is a
  failed gate).
- The suite must be **falsifiable**: at least one negative control per major veto family, recorded
  with the exact command and observed failure.
- No live provider calls, no network, no disposable server: this suite is the fast permanent
  harness and must be runnable in CI without secrets.
- Tests only. Finding a real defect: write it up in your handback with a minimal reproduction and
  raise it as a `PARENT-INPUT-NEEDED` question — **do not** change `server/src/**`.

## Gate 6 (run and record, verbatim from the plan)

```bash
npm --prefix /root/pi-web-ui-wt-regression/server test -- tests/regression/
```

Exit 0, wall-clock **< 20 s**, 100 % of veto assertions holding, 100 % critical-word retention on
negations and conditionals. Also record `npm run typecheck` (exit 0) and the full server suite tail
(`env -u PI_MAX_SESSIONS -u OPENCODE_ENABLED npm --prefix server test`) showing your additions green.

## Constraints

- Owned paths only. **NO-TOUCH:** `server/src/**` (all of it), `client/**`, `shared/**`,
  `scripts/**`, docs. Track D's `server/tests/regression/harness/**` may be **extended** (new helper
  functions) but its runner contract (zero checks fails; one failure fails) must not be weakened.
- Do not weaken or skip tests to pass; a suite with 0 executed checks or skips fails.

## Stop protocol

Blocked or a real defect → `/root/voice-exec-20260917/coordination/G/01-questions.md`, print
`PARENT-INPUT-NEEDED`, end turn.

## Handback

Commit on `feat/voice-regression`. `/root/voice-exec-20260917/coordination/G/complete.md`: outcome;
changed-path inventory; gate commands + observed results (including the negative-control runs and the
timing); coverage table mapping each plan veto to its check id; `FROZEN` marker. Declare on the
agent-os board; leave the entry on completion.
