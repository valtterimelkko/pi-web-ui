# H3 — Retest the top candidates against the REAL harness

You are a child worker. Complete this end-to-end, then report back. Do not ask the operator anything — if you hit a genuine blocker, stop and report it.

## Why this exists

The talker model was selected from **Benchmark 3**, which measured a **marker-based** harness: the model had to emit `RELAY:` / `CLARIFY_REQUIRED:` lines and the scorer inferred intent from text. The production harness is **different in kind**: the model never composes or sends anything, it only decides whether to answer, ask, or propose, and the gate is structural.

Two consequences:

1. The selection of `gemma-4-26b-a4b-it` rests on a **proxy** for the real thing.
2. Models that lost points to **marker omission** may rank differently now that the marker requirement is gone.

The operator approved retesting the top five against the real harness, **in this repository**, not the benchmark repo.

## Outcome

A per-candidate comparison table measured with the **real harness** (`scripts/talker-harness.ts`, which drives the real `TalkerSession` with a direct model call and the v3 justified-gate prompt), covering:

| # | Candidate selector | Thinking |
|---|---|---|
| 1 | `google/gemma-4-26b-a4b-it` (incumbent) | off |
| 2 | `google/gemini-3.6-flash` | minimal |
| 3 | `deepseek/deepseek-flash` | off |
| 4 | `openai/gpt-4o-mini` | off |
| 5 | `openai/gpt-5-nano` | minimal (provider floor) |

**Candidate 5 is the interesting one.** Its recorded failure in the earlier sweep was a *propose-and-relay-in-the-same-turn* pattern — exactly what the structural gate should make impossible once the model no longer owns the send. It is therefore a test of the harness change, not just a re-run. State explicitly whether it still exhibits that pattern.

**Resolve the exact selectors and model ids from the live catalogue before running** (`GET /api/v1/models` on the Internal API, or the OpenRouter models endpoint) — do not assume the ids above are current. Record what you actually used, and note the **served-model identity** where a routing id could silently differ.

## What to measure, per candidate

Run each candidate through the harness with the same settings:

- **first-token latency**: median, p90, max, against the 2 s target and 4 s failure line;
- **pushback hold rate**: `--pushback-runs` ≥ 3, reported as held/attempted. **This is the most important number** — a candidate that abandons the gate is disqualified regardless of speed;
- **verbatim relay fidelity**: the harness reports whether the released text matches the operator utterance exactly. Report any mismatch;
- **gate outcome**: any unintended release, any release with nothing pending, any double release;
- **honesty**: any claim of an action not taken (e.g. claiming the worker finished).

Suggested invocation (adjust as the runner requires):

```bash
eval "$(grep '^export OPENROUTER_API_KEY' ~/.bashrc)"
npx tsx scripts/talker-harness.ts --model "<selector>" --runs 3 --pushback-runs 5 --json "/tmp/h3-<candidate>.json"
```

Note: candidates 2–5 may not be reachable through this OpenRouter client if they are not OpenRouter-hosted. If a candidate cannot be driven by this client, say so plainly and either (a) resolve an OpenRouter equivalent for the same model, or (b) report it as **not tested with the reason** — do **not** fabricate numbers or substitute a different model silently.

## Scope and paths

**Owned (yours to create):**
- A results artifact: `docs/plans/H3-TALKER-RETEST-RESULTS.md` — the table plus your verdict.
- Any small script/report you need under `scripts/` (do not modify `scripts/talker-harness.ts` unless genuinely required; if you must, say so and why).

**Do not touch:** `server/src/talker/*` (another child is testing it concurrently), the plan file, or the briefs.

**Do not commit or push.** Leave work in the tree for parent review.

## Method

1. Read `scripts/talker-harness.ts` and `server/src/talker/model-client.ts` to understand exactly what is measured and how, so your report describes the real method rather than the intended one.
2. Confirm each candidate's selector resolves before a batch run.
3. Run all five with **identical settings**. If one fails for an environmental reason, retry once, then report it as not tested.
4. Produce the comparison table. **Do not** pick a winner on your own authority — present the evidence and a recommendation; the parent decides.

## Environment

- Repo: `/root/pi-web-ui` (main tree). Clean at `de6cafe`; verify `git status --short` before finishing.
- `OPENROUTER_API_KEY` in `~/.bashrc`.
- Do not use production; this is a direct model call, so no server is needed. **Do not restart or touch the production service.**
- Checks at the end: `npm run typecheck` (exit 0) and leave the existing test suite untouched.

## Stop and report if

- A candidate abandons the gate in any run (report the exact reply — it is a headline finding).
- Selectors cannot be resolved for more than two candidates.
- You find the harness itself is measuring something different from what the plan claims (report the discrepancy; do not fix it).

## Hand-back format (report exactly this)

1. **Status**: complete / partial / blocked.
2. **Resolved selectors actually used**, with served-model identity where relevant.
3. **The comparison table** — all five candidates, latency (median/p90/max), pushback held/attempted, verbatim fidelity, gate outcome, honesty.
4. **Headline findings** — especially whether `gpt-5-nano` still propose-and-relays, and whether any candidate breaches the gate.
5. **Does the incumbent still lead?** Your evidence-based read, plus what would change your mind.
6. **Latency vs the 2 s target** — how many candidates/ turns met it, and how this compares with the benchmark-era numbers.
7. **Checks run** — exact commands with exit status.
8. **What you could NOT test** and why.
9. **Any finding that contradicts the plan** — state it; do not silently adapt.
