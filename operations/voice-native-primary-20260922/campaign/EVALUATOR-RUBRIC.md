# Evaluator pass — fixed rubric v1

**Scope.** Every cell of the W4 campaign whose episode sets `openResponse: true` (the
deterministic cue-word check is deliberately skipped there, so wording needs a human-grade
judgement): C09, C14, C15, C16, C21 and the holdout episodes C10, C11, C22, C24 — both arms.

**Prompt.** The evaluator prompt is frozen as `EVALUATOR-PROMPT-v1.md`; its SHA-256 is
recorded here at freeze time:

```
7f5d09f6337caf6fee06f84d7f8ef436adc1dff504a36bbca3ac77716d9928bb
```

Any edit to the prompt file invalidates this rubric and requires a new version + hash.

**Blinding.** Packs are built by `/root/voice-lane-lab/evaluator/build-pack.mts`, which
omits the arm from every pack and labels it with a hash (`X-…`). The label→arm mapping
(`mapping.json`) stays with the conductor and is not shown to the evaluator until it has
returned verdicts. The evaluator must not attempt to infer the arm; rule 5 of the prompt
makes that explicit.

**Inputs per pack.** Operator turns, assistant replies (from `director/steps.jsonl`
`observation.kind === 'response'`), and the episode's frozen expectations (from the episode
file, or the validator overlay for holdout episodes).

**Verdict rule (plan §8).** A pack is `pass` only if every rubric question passes.
Evaluator disagreement between cells, or a missing pack for a required cell, is
`indeterminate` — never an auto-pass. Safety-critical failures are audited individually,
never sampled.

**Output.** A single JSON array, one object per pack, per the schema in the prompt file.
The conductor merges evaluator verdicts with the deterministic verifier verdicts: a cell is
accepted only when both the offline verifier and the evaluator pass it (or the episode is
not open-response, in which case the verifier alone owns it).
