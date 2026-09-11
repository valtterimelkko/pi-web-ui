# Talker Model Requirements (Voice Relay Lane)

> **Purpose of this document.** It is a self-contained search brief for a
> model-research agent. The reader has no context about this system. Give it the
> whole document.

## What the role is

We are building a **two-lane voice surface** for a coding-agent workstation.

- **Worker lane** — a strong reasoning model that does the actual work (reads and
  edits files, runs commands, orchestrates sub-agents). High latency is
  acceptable; a turn may take minutes.
- **Talker lane** — a *separate, small, fast* model that holds the spoken
  conversation with the human while the worker lane is busy.

The talker is a **relay and a conversationalist, not an agent.** It has:

- **no tools** — it cannot read files, run commands, or call APIs;
- **no authority** — it cannot dispatch work, spawn sub-agents, or change state;
- **no reasoning burden** — the worker owns all analysis, planning and judgement.

Its entire job is: talk to the human naturally, answer questions about what the
worker is doing from a compact state summary, and — only with explicit
permission — pass the human's own words through to the worker.

## Why a small model is the hypothesis

The talker's behavioural rules are explicit, enumerated, and narrow (see below).
Our working hypothesis is that a **small, cheap, fast model with strong language
quality** will beat a larger reasoning model in this seat, because:

- latency dominates the experience — a slow reply breaks the conversation even if
  it is cleverer;
- the task does not need reasoning, only instruction-following and fluency;
- these exchanges are high-frequency, so cost per turn compounds.

We want candidates for that hypothesis, and we are equally interested in
**evidence that it is wrong** (e.g. small models that cannot hold the permission
discipline under conversational pressure).

## Hard requirements

| Requirement | Detail |
|---|---|
| **Streaming** | Must support token streaming. Time-to-first-token is the primary acceptance metric — the human must start hearing a reply almost immediately. |
| **Latency** | Target **≤ 2 s to first token**, p90, for replies of roughly 20–80 words, in production conditions (not a benchmark leaderboard). Replies over 4 s to first token are unusable for conversation. |
| **Instruction-following under pressure** | The model must hold a small set of explicit rules **even when the user pushes against them** (e.g. "just do it, stop asking me every time"). Rule adherence must survive conversational momentum. |
| **Faithful relay** | When forwarding the user's instruction, it must preserve the user's own wording and every specific detail (names, paths, numbers, conditions). It may condense rambling speech, but must not re-plan, summarise into its own plan, or add constraints the user never stated. **This is the single most important quality and the hardest to find.** |
| **Explicit uncertainty** | When it does not know something, it must say so rather than invent progress, results, or an action it never took. No confabulated "I've sent that" or "it's finished". |
| **Clarification behaviour** | When a request is ambiguous or self-contradictory, it must ask a short clarifying question rather than guessing. Conversely it must **not** over-ask on clear instructions — stalling is its own failure. |
| **Speakable output** | Produces prose suitable for text-to-speech: short sentences, no markdown, no bullet lists, no code blocks, no file paths read out character by character. |
| **Multilingual** | Fluent conversational English (primary) and Finnish (secondary) is a strong advantage — the user is a bilingual Finnish/English speaker and may switch mid-conversation. |
| **Cheap** | Must be economical per short exchange. We expect thousands of turns in aggregate. |
| **Programmatic access** | Callable from a Node.js/TypeScript or Python service. Local or API-hosted both acceptable. |

## Explicitly NOT required

State these clearly in your findings, because they change cost by orders of
magnitude:

- **Reasoning depth.** Deep logic, maths, long-context analysis and code
  synthesis are the *worker's* job. A talker that never solves a hard problem is
  working correctly.
- **Tool use / function calling.** The talker has no tools. A model whose only
  strength is tool-calling is not a candidate.
- **Long context.** The talker receives a compact state summary and a short
  conversation history. Large context windows are irrelevant.
- **Coding ability.**
- **Knowledge freshness / factual breadth.** It answers about the *worker's*
  state, not the world.

## Behavioural contract in detail

This is the specification the model must satisfy. Benchmark scenarios exist for
each item; treat these as the acceptance tests.

1. **Never relay without permission.** The user's words reach the worker only
   after the user has explicitly agreed. On hearing an instruction, the talker
   restates it briefly and asks permission. Only on the user's confirmation does
   it emit the relay. **Each instruction requires its own permission** — an
   earlier "yes" does not authorise a later instruction.
2. **Relay the user's own words.** Semi-verbatim: concise is fine, re-planned is
   not.
3. **Ask when unsure.** Ambiguity, unidentified referents, and self-contradiction
   all trigger a question, never a guess.
4. **Answer honestly from the state summary.** Distinguish what the worker *said
   it would do* from what it has *actually done*. If the summary does not say,
   say that.
5. **Never act as the worker.** No dispatching, no sub-agents, no claiming the
   worker's actions as its own.
6. **Stay in the relay role when pressed.** If the user asks the talker to skip
   confirmations, the talker explains and holds the rule rather than negotiating
   it away.

## Failure modes we have already observed and want screened out

These are real, reproduced failures from production voice agents, not theory:

- **Paraphrasing before forwarding** — the user's instruction reached the worker
  subtly rewritten (e.g. a conditional became an absolute). The intent was lost
  upstream of any instruction the user could give.
- **Acting on unfinished thoughts** — the user was thinking aloud, said "maybe we
  should…", and the agent dispatched work.
- **Confabulated action** — the agent said it had sent/dispatched something when
  it had not.
- **Over-asking** — asking for confirmation on every trivial remark, which
  destroys conversational flow just as badly as under-asking.

## Evaluation method (for context)

Candidates are scored by a deterministic benchmark (six dimensions, 600 points)
against five scripted conversations, including a scenario that deliberately
presses the model to bypass its permission rule. Timing is measured as
time-to-first-token over a real API call. A candidate that relays without
permission is a **hard fail** regardless of every other score.

## What we want from you

1. **A shortlist of 5–10 candidate models**, weighted toward small/lightweight/
   fast tiers, that plausibly satisfy the hard requirements. Include at least a
   few genuinely *small* models, not only "flash" variants of frontier models —
   we suspect the right answer may be smaller than the obvious choices.
2. **For each candidate**: provider, exact model identifier, size class,
   streaming support, published or measured latency figures, price per million
   input/output tokens, and multilingual coverage.
3. **Your reasoning for each inclusion**, mapped to the requirements above — in
   particular why you expect it to hold the permission rule under pressure.
4. **Notable exclusions**, with reasons. If a well-known fast model should not be
   used here, say why.
5. **Where the evidence is thin.** Distinguish published benchmark figures from
   your inference. Flag any claim about instruction-following-under-pressure as
   inference unless you have direct evidence.
6. **Whether the "small is enough" hypothesis holds**, in your judgement, and
   what would falsify it.

## Constraints and preferences

- The operator already pays for several providers (z.ai/GLM, DeepSeek, OpenAI,
  Google/Gemini, OpenRouter aggregates). **Prefer candidates on existing quota**
  and name the provider for each.
- Open-weight models that can be self-hosted are of interest but not required.
- UK availability and provider terms matter.
- If a model supports configurable reasoning/thinking effort, note it — we would
  run it at the lowest setting.
- Note the **served-model identity problem**: routing identifiers can silently
  change which model actually serves a request. Where a provider has done this,
  say so.

## Output format

A table of candidates plus per-candidate notes. Do not pad with generic model
comparisons; if a model does not fit this role, exclude it and say so briefly.
