# Drive Mode Two-Lane Plan — Voice Talker + Reasoning Worker

> **This plan implements an existing intent. It does not replace it.**
>
> **Intent file (canonical, preserved):**
> [`docs/VOICE-ORCHESTRATOR-FEASIBILITY.md`](../VOICE-ORCHESTRATOR-FEASIBILITY.md)
> — the 2026-09-10 findings record written with the operator. It stays intact and
> is the reference point for every intent check. This plan reconciles against it
> item by item in §2 and names every place where it deviates.
>
> **Status:** plan; Phase 0 (talker model evaluation) is **complete** — see §10.
> Phases 1–5 not started. Written 2026-09-10; §10 added 2026-09-12 from the
> Benchmark 3 results.
> **Operator authorisation:** extension/server lane approved; Pi + Claude SDK +
> Antigravity scope approved; intent file to remain frozen; voice confirmation
> chosen; model left open, decided by evaluation.
> **Nothing in this plan is authorised for production deployment** — that remains
> a separate, explicit owner gate (§8).

---

## 1. The intent, in the operator's terms

The operator wants to **orchestrate agent work by voice, in a conversation** —
and equally to *just talk to a coding session*, because the non-orchestration
case is not a degraded mode, it is a primary use.

> "The reasoning is very important when it comes to orchestrating… the talker is
> not the orchestrator of children — it relays me to the worker, back and forth,
> and the worker can be on pi, claude or antigravity — and that worker is the
> reasoning model that orchestrates children (or is just a coder / worker without
> children if we are not orchestrating, as that should be kept as the other use
> case here)."

The constraint that makes this hard: a reasoning worker takes a minute or more
per turn, so it cannot also hold the conversation. Real voice agents solve the
latency and lose the intent — they paraphrase the operator's words before
forwarding them, and they act on half-finished thoughts.

**The design answer is two lanes:** the worker keeps full reasoning; a separate
small, fast talker owns the conversation, relays the operator's own words with
high fidelity, and never acts without permission.

---

## 2. Intent reconciliation (drift check)

Read this table first in any future session. It shows every intent item from the
canonical file, where it lands in this plan, and its current status.

| # | Intent item (from the canonical file) | Where it lands | Status |
|---|---|---|---|
| I1 | Talk + work simultaneously; worker latency must not block the conversation | Phase 2 (side-completion talker), Phase 4 (talking-while-working) | **Planned** |
| I2 | Very high intent fidelity — the worker receives the operator's intent, not a re-planned version | Phase 2 rules; Phase 5 acceptance | **Planned** — the hardest requirement, and the one most likely to fail silently |
| I3 | Never act on an unfinished thought | Phase 2 confirmation gate; Phase 5 voice-confirmation cases | **Planned** |
| I4 | Conversation first: questions and thinking-aloud answered, nothing dispatched | Phase 2 (answer-only path) | **Planned** |
| I5 | Confirm before relaying | Phase 2 gate, Phase 5 | **Planned** |
| I6 | Reporting of worker completions and background wakes | Phase 2 (wake summarisation) | **Planned** |
| I7 | Allow-list, not model judgement | Phase 2 (explicit rule set + tests) | **Planned** |
| I8 | Keep OpenAI STT (dictation) and TTS (read-aloud) | Phase 4 (unchanged routes) | **Preserved** |
| I9 | Drive Mode no longer blocks in a single "agent working" phase | Phase 4 (phase machine) | **Planned** |
| I10 | A compact state view instead of the worker's full context | Phase 1 (contract), Phase 2 | **Planned** — shape prototyped in `agent-benchmarks/03-voice-relay` |
| I11 | No Gemini dependency required | Holds — OpenAI STT/TTS only | **Preserved** |
| I12 | Ruled out: Gemini app + custom MCP (UK unavailability) | — | **Preserved** |
| I13 | Lane 2 (ChatGPT Voice relay) kept as an optional half-day spike | Deferred; not in this plan | **Not planned** — deliberately dropped for now |
| I14 | **Talker is a pi-enhancement extension** | Phase 2/3 (server-side talker instead) | ⚠️ **SUPERSEDED** — see below |
| I15 | Talker covers the Pi runtime only | Phase 3 (three runtimes) | ⚠️ **SUPERSEDED** — see below |
| I16 | Rough size: extension ~1–2 days, Drive Mode ~1–2 days | Phase estimates in §6 | ⚠️ **INVALIDATED** — written before the delivery-path finding |
| I17 | Cheap, fast, minimal-thinking talker; "leaning GLM 5.3 Flash" | §10 — decision D7 | ⚠️ **PARTLY SUPERSEDED** — GLM is ruled out on latency; Gemma 4 26B A4B selected |
| I18 | Deployed as a pi-enhancement extension under `/root/pi-enhancement/` | Not applicable | ⚠️ **SUPERSEDED** by S1/S2 — see §10 measurement caveat |

### Named supersessions

Two intent items are no longer true. Stating both halves so they can be
adjudicated rather than quietly tripped over:

**S1 — I14 is superseded.** The canonical file places the talker in a
**pi-enhancement extension** that intercepts utterances through the Pi
`input` event. This session established that Pi Web UI delivers prompts and
steers by calling the agent session's `prompt` and `steer` methods directly,
so `pi.on("input")` handlers **never fire** for Pi Web UI operator input. The
talker as specified would have silently never heard the operator. Placement
moves server-side into Pi Web UI.

**S2 — I15 is superseded.** The canonical file scopes the talker to the Pi
runtime. The operator's stated scope is **Pi + Claude + Antigravity**. Because
Antigravity has **no extension surface at all**, an extension-based talker could
never serve that scope. This independently forces the same server-side placement
as S1.

**S3 — I16 is invalidated.** The "1–2 days" estimates predate S1/S2. They are
not a basis for scheduling.

**The intent that did *not* change:** two lanes, worker owns reasoning and
orchestration, talker relays with high fidelity and never acts without
permission. Only the talker's *placement* moved.

---

## 3. Architecture decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | **Worker owns reasoning and any orchestration.** The talker holds no tools, no children, no dispatch authority. | Operator statement (§1). Also a containment win: a relay with no authority cannot cause work. |
| D2 | **The talker lives server-side in Pi Web UI**, with per-runtime adapters. | Forced by S1/S2 (Antigravity has no extension surface; the Pi input event does not fire for Web UI delivery). |
| D3 | **Runtimes: Pi, Claude (SDK backend), Antigravity.** | Operator scope. OpenCode and Command Code are out of scope. |
| D4 | **Confirmation gate is mandatory and voice-driven**, with a text fallback that echoes the exact proposal. | Operator chose voice confirmation. The fallback exists because a misheard confirmation is the one failure that defeats the design's purpose. |
| D5 | **The talker model is decided by evaluation, not assumption.** | Operator: leave it open; test several models including genuinely small ones. |
| D6 | **The eval precedes build.** | Latency determines whether this is a conversation or just a quieter wait, and it is unmeasured. |
| D7 | **Talker model: `openrouter/google/gemma-4-26b-a4b-it`, thinking OFF**, served by OpenRouter on the **paid** route. | Benchmark 3 leader (86.4%, zero gate breaches) at the lowest cost of the top cluster. Full rationale in §10. |

### Per-runtime delivery reality (verified this session)

| Runtime | Mid-run delivery | Consequence for the talker |
|---|---|---|
| **Pi** | Needs the input-routing bridge (Phase 1); then steer joins at a tool boundary | Medium work; a bounded change in Pi Web UI |
| **Claude** | Native steer + follow-up, **SDK backend only** (`supportsSteer: backendMode === 'sdk'`) | Gate on backend mode; the channel backend must refuse honestly rather than silently degrade |
| **Antigravity** | **Follow-up only — no mid-run join**; the agy protocol cannot | The talker must present "your message will land after this turn" as a first-class outcome, not an error |

---

## 4. Phases

Each phase is TDD-first: a failing behavioural test exists before implementation.
Each phase states its own live-validation gate. No phase is "done" on unit tests
alone.

### Phase 0 — Model evaluation (pre-flight, decides D5) — ✅ COMPLETE

**Outcome:** `gemma-4-26b-a4b-it` at thinking OFF, via the OpenRouter paid route.
See §10 for the decision record and the benchmark signposts.

**Still outstanding from Phase 0:** the bare side-completion spot-check (§10.7).
The benchmark's latency figures carry a ~0.4 s harness tax and ~4.3k tokens of
ambient context, so they rank candidates fairly but do not state production
latency. The spot-check is small and should happen before Phase 2 completes.

<details>
<summary>Original Phase 0 definition (for reference)</summary>

**Deliverable:** `agent-benchmarks/benchmarks/03-voice-relay/` run against 5–10
candidates; a results table; a chosen talker model with its measured latency
profile.

**Why first:** the ≤2 s first-token target is the plan's central promise and is
entirely a property of the model and provider. If no candidate reaches it, the
talker design changes (sentence chunking becomes mandatory, or the target moves).

**In:** the benchmark harness (already built), candidate shortlist from
`docs/TALKER-MODEL-REQUIREMENTS.md`, provider headroom check.
**Out:** a concrete model selector + thinking level, its median and p90
time-to-first-token, its cost per exchange, and its hard-fail behaviour under
`s4-permission-gate`.

**Gate:** at least one candidate that does **not** hard-fail the permission gate
and whose median first-token is within target. If none qualifies, stop and
report — do not proceed to Phase 1 on an assumption.

**Gate result:** PASSED — four candidates cleared the gate with zero hard fails,
and the winner cleared it in every scenario including the pressure sequence.

</details>

### Phase 1 — Compact state view contract (server-side)

**Deliverable:** a bounded, documented projection of worker state that the talker
reads: current activity, recent tool events, background children and their
statuses, pending items, last assistant text, elapsed time.

**Why it must be explicit:** this is the talker's entire world. If it is
unbounded, the talker's context and cost explode; if it is too thin, the talker
invents progress. The prototype shape is already pinned in
`agent-benchmarks/03-voice-relay/talker_runner.py::build_turn_message`.

**TDD:** projection tests over real session records — the view must be
deterministic, bounded, and must never include file contents or secrets.
**Gate:** live check against a real running Pi session and a real Claude session;
the projection reflects tool activity within a bounded lag.
**Blocked on:** nothing.

### Phase 2 — The talker (server-side, runtime-agnostic core)

**Deliverable:** the talker loop — operator speech arrives, the talker answers
from the state view via a side completion, and relays only after confirmation.

**The rule set is the specification.** These are enforced in code, not left to
model judgement:

1. Answer conversationally from the state view; never dispatch.
2. Never relay on first hearing; restate and ask permission.
3. Each instruction requires its own permission; an earlier yes does not carry.
4. Relay the operator's own words — condense permitted, re-plan forbidden.
5. Ask when ambiguous, self-contradictory, or referentially unclear — and do not
   over-ask on clear instructions.
6. Never claim an action the talker did not take, and never present the worker's
   action as its own.
7. Speak in short, TTS-safe prose.

**TDD:** the rule set is tested against the same five scenario shapes as the
benchmark (`s1`–`s5`), run as unit/contract tests with a stubbed model, so
regressions are caught without spending tokens.
**Gate:** live check with a real worker mid-turn — the operator's question is
answered while the worker is busy, and a relay lands only after confirmation.
**Blocked on:** Phase 0 (model), Phase 1 (state view).

### Phase 3 — Runtime adapters (Pi, Claude, Antigravity)

**Deliverable:** per-runtime delivery.

- **Pi** — route mid-run operator input through a path that emits the extension
  `input` event, so the talker's relay reaches the worker and so any future
  extension can observe operator input. *(This is the S1 fix; it is the one
  change inside Pi Web UI's delivery path.)*
- **Claude** — use the native steer/follow-up; refuse honestly on the channel
  backend rather than degrading silently.
- **Antigravity** — follow-up only; surface "this will arrive after the current
  turn" as a normal outcome.

**TDD:** one delivery test per runtime, plus an explicit refusal test for the
Claude channel backend and an explicit "queued for next turn" test for
Antigravity. The Pi change must not alter delivery semantics for any existing
caller — a regression test pins the current behaviour first (RED), then the
change satisfies both.
**Gate:** live validation against all three runtimes on a disposable server —
each must show a relayed operator instruction reaching a *busy* worker by the
mechanism that runtime actually supports.
**Blocked on:** Phase 2. **Note:** the Pi part touches Pi Web UI's input path;
treat it as the riskiest single change in this plan.

### Phase 4 — Reply channel and Drive Mode

**Deliverable:** the talker's replies reach the operator as speech, and Drive
Mode stops blocking.

- **Reply channel** — extend the existing extension-UI observer/bridge pattern
  (the precedent is the background-task bridge) so the talker's conversational
  replies reach the browser rather than being swallowed.
- **Anti-duet rule** — the worker's final answer and the talker's conversational
  replies must not both be read aloud. Decide the rule explicitly and test it.
- **Drive Mode phase machine** — a talking-while-working state replaces blocking
  in `agent-working`; TTS is sentence-chunked so speech starts early.
- **Voice confirmation** — the talker catches the operator's confirmation while
  the worker is mid-run; the exact proposal is echoed on screen as a fallback,
  and an ambiguous confirmation does not act.

**TDD:** phase-machine transitions; chunked-TTS start-latency; the anti-duet
rule; confirmation accepted, rejected, and ambiguous.
**Gate:** end-to-end on a disposable server against a real worker — hold a
conversation while the worker runs, relay one instruction by voice, and confirm
the worker received the operator's own words.
**Blocked on:** Phase 3.
**Preserved:** `/api/dictation` and `/api/tts` are unchanged in this phase
(intent I8).

### Phase 5 — Live validation and documentation

**Deliverable:** the full acceptance evidence, plus documentation corrections.

- Run the five scenarios end-to-end against a live worker on each in-scope
  runtime.
- Independent verification that a relayed instruction arrived semi-verbatim —
  compare the operator's utterance to the worker's received text, not to the
  talker's account of it.
- Update the canonical intent file's Lane 1 section **without rewriting it**: add
  a pointer to this plan and a note recording S1/S2. *(Correction of the
  artefact is the owner's call; propose the edit rather than assume it.)*
- Update the orchestration skill with the voice pattern.

**Gate:** evidence table with per-scenario pass/fail, the verbatim-relay
comparison, and any known gaps stated plainly.
**Blocked on:** Phases 3–4.

---

## 5. Acceptance criteria

| # | Criterion | Evidence required |
|---|---|---|
| A1 | Talker replies start within the agreed target (`≤2 s` first token, p90 unless Phase 0 revises it) | Phase 0 measurement table |
| A2 | A relayed instruction preserves the operator's content words | Recall comparison against the worker's received text |
| A3 | Nothing relays without confirmation — ever | The `s4-permission-gate` scenarios plus a live attempt to talk the talker out of it |
| A4 | Ambiguity produces a question, not a guess | Scenarios from `s2-clarification` and `s5-sparse-state` |
| A5 | The talker never orchestrates | `s1`/`s3` role checks; no child created by the talker |
| A6 | Replies are speakable | Length/latency scoring plus operator listening check |
| A7 | Worker's final answer and talker's chatter do not both speak | The anti-duet test |
| A8 | Per-runtime delivery is honest | Three live runtime runs, including the Antigravity queue case |

---

## 6. Size estimate

Deliberately not given in days until Phase 0 reports. What is known:

- **Phase 3 (Pi input routing) is the riskiest bounded change** — it alters a
  delivery path every Pi session uses, so it carries the strictest regression
  requirement.
- Phase 4 is the largest by surface area (browser + server + speech).
- Phases 0 and 1 are small and independent.

---

## 7. Risks

| Risk | Consequence | Mitigation |
|---|---|---|
| No model reaches the latency target | The premise fails | Phase 0 gated before any build; fall back to larger chunking or revise the target with the operator |
| The Pi input-routing change regresses existing delivery | Every Pi session affected | RED-first regression tests pinning current behaviour before the change |
| The talker relays a *wrong* confirmation (misheard voice) | The design's core failure, acted on | Text fallback echoing the exact proposal; ambiguous confirmation must not act |
| Intent fidelity drifts silently | The plan looks successful while defeating its purpose | A2 requires comparing the operator's words to the worker's received text — never to the talker's account |
| State view too thin, so the talker invents progress | Operator misled | Phase 1 projection contract + explicit "I can't tell from here" behaviour, scenario-tested |
| Antigravity's queue semantics feel like a malfunction | Operator confusion | Present it as a first-class outcome in the UI, tested |

---

## 8. Authorisation boundary

- **Approved and in scope:** the eval (Phase 0); Pi Web UI changes for the
  server-side talker, the Pi input routing and the reply channel; Drive Mode
  changes; the benchmark in `agent-benchmarks`.
- **Not approved:** any production deployment or restart. Phase completion stops
  at disposable-server validation; production is a separate explicit owner gate.
- **Propose, do not assume:** edits to the canonical intent file. The owner asked
  for it to be preserved; corrections are proposed.
- **Separate, not covered here:** publishing Benchmark 3 to the benchmarks
  leaderboard; any change to OpenCode or Command Code; the Lane 2 ChatGPT Voice
  spike.

---

## 9. Canonical references

- Intent file: [`docs/VOICE-ORCHESTRATOR-FEASIBILITY.md`](../VOICE-ORCHESTRATOR-FEASIBILITY.md)
- Shipped Drive Mode behaviour: [`docs/DRIVE-MODE.md`](../DRIVE-MODE.md)
- Talker model search brief: [`docs/TALKER-MODEL-REQUIREMENTS.md`](../TALKER-MODEL-REQUIREMENTS.md)
- Talker evaluation harness: `agent-benchmarks/benchmarks/03-voice-relay/`
- Worker model evidence (which model should reason): `agent-benchmarks/benchmarks/02-orchestrator-governance/`
- Orchestration practice the voice lane drives: `/root/.pi/agent/skills/pi-web-ui-internal-api-orchestration/`
- Extension source of truth (if any future extension work returns): `/root/pi-enhancement/AGENTS.md`

---

## 10. Talker model decision (Phase 0 outcome, 2026-09-12)

### 10.1 The decision

| | |
|---|---|
| **Model** | `openrouter/google/gemma-4-26b-a4b-it` |
| **Thinking** | **OFF** (the decisive setting — see §10.4) |
| **Route** | OpenRouter, **paid** tier |
| **Benchmark result** | **86.4%**, zero permission-gate breaches, 1,796 ms median TTFT (harness-inflated) |
| **Reason in one line** | Best measured quality in the field, tied-fastest latency, roughly half the cost of its nearest competitors, and a routing/commercial shape that is legitimate and resilient in production. |

### 10.2 Evidence

Signposts — read the report before quoting any number from it:

- **Full report:** `/root/agent-benchmarks/benchmarks/03-voice-relay/FINAL-REPORT-2026-09-12.md` — results, thinking-level experiment, harness-compatibility findings, and a latency-attribution section that must be read before quoting timings.
- **Standings and discard reasons:** `/root/agent-benchmarks/benchmarks/03-voice-relay/runs-manifest.json` (105 runs, 17 models).
- **Published leaderboard:** https://united-voyage-ex39.here.now/
- **Harness:** `/root/agent-benchmarks/benchmarks/03-voice-relay/`

Top of the field (average across the five scenarios, 600 points):

| Candidate | Thinking | Avg % | Gate breaches | Median TTFT* |
|---|---|---|---|---|
| `openrouter/google/gemma-4-26b-a4b-it` | **off** | **86.4** | **0** | 1,796 ms |
| `google/gemini-3.6-flash` | minimal | 85.0 | 0 | 1,923 ms |
| `deepseek/deepseek-flash` | off | 83.7 | 0 | 1,836 ms |
| `openai/gpt-4o-mini` | off | 81.5 | 0 | 1,489 ms |
| `zai/glm-5.3-flash` | low | 76.8 | 0 | 5,168 ms |

\* Harness-inflated; see §10.6.

### 10.3 Why Gemma 4 26B A4B

1. **It leads on measured quality** — 86.4% across all five scenarios, including the permission-gate pressure sequence, with **zero** gate breaches. Gate discipline is the property this whole design rests on, and it held.
2. **Latency is in the pack** — 1.8 s median in a harness that taxes every candidate equally.
3. **The cost profile is the differentiator.** The other top contenders score comparably but cost roughly **double or more** for the same job. This candidate is markedly cheaper *without* a quality give-up, which matters because these are high-frequency exchanges.
4. **The routing shape is production-grade.** It is an open-weights model, so many inference providers can serve it. On the paid route that means provider redundancy, high measured uptime, and no dependence on a single vendor's free tier.
5. **It is a legitimate commercial use.** The model is served through a general inference provider on a paid route, so building a product feature on it is within terms. See §10.5 for why this is load-bearing.
6. **It has genuine general ability** — this family is well regarded for coding as well, which matters because the talker may be asked to *discuss* work without doing it.

### 10.4 Ruled out: thinking at any level, and the larger sibling

The thinking experiment is the most useful negative result in the whole benchmark.

| Variant | Avg % | Gate breaches | Median TTFT (max) | Output tokens |
|---|---|---|---|---|
| Gemma 4 26B, **off** | **86.4** | 0 | **1,796 ms** (3.5 s) | 1,764 |
| Gemma 4 26B, minimal | 80.1 (−6.3) | 0 | 3,733 ms (15 s) | 16,049 (**×9**) |
| Gemma 4 31B, off | 76.4 | 0 | 3,911 ms (133 s) | 1,336 |
| Gemma 4 31B, minimal | 64.9 (−21.5) | **2** | 13,568 ms (140 s) | 14,531 |

**Thinking made it worse on every axis.** Quality fell, latency roughly doubled or worse, output tokens grew about ninefold, and the worst variant began breaching the permission gate. The weak scenarios were not thinking-starved — thinking simply did not help them.

The larger 31B is **not** the stronger option here. The dense 31B scores 76.4 against the fast-MoE 26B's 86.4 *at the same thinking setting*, and its latency grows badly. More parameters did not buy a better talker.

**Decision:** run the talker with thinking **off**. This is not a cost compromise — it is the best-measured configuration on quality *and* latency.

### 10.5 Ruled out: alternatives and why

| Rejected | Reason |
|---|---|
| **`zai/glm-5.3-flash`** (the original candidate) | ~5 s to first spoken token at low thinking makes it unusable as a voice talker. Its gate and honesty behaviour was impeccable — **it remains the worker-lane model**, not the talker. |
| **GLM on any coding-subscription endpoint** | That endpoint is for interactive coding use. Serving a product feature from it is a **terms-of-service problem**, not a tuning problem. This alone rules the route out regardless of performance. |
| **Google's own API for the same model** | Rate limits even on paid calls, experienced directly. The same provider is also less generous on limits than an aggregator serving the same weights. |
| **OpenRouter free endpoint** | Only one inference provider behind it, its own free quota, ~97% measured uptime, and heavier limits. Not a sound dependency for a production feature. |
| **The paid OpenRouter route for other candidates** | Comparable quality at roughly double the cost. |

**The general lesson, worth carrying past this decision:** provider choice is not only a cost/latency question. It is a **terms, limits and uptime** question, and a route can be disqualified commercially or operationally no matter how good its numbers are.

### 10.6 Measurement caveat — read before quoting latency

Every figure above was measured through the **Pi coding agent harness** on the Internal API, which was chosen because it was the lowest-barrier way to build the benchmark. That harness adds a fixed per-turn tax before the model generates anything:

- an Agent OS memory-injection CLI subprocess, awaited on the dispatch path — **~0.4 s per turn**, plus a second call after each turn;
- the user-level `AGENTS.md` loaded per session (~3.4k tokens);
- an Agent OS context packet injected per session (~0.9k tokens);
- Pi tool schemas and a skills index in every prompt, bringing harness input to **~38–46k tokens per turn**.

**Production shape is different and cheaper.** The talker will be a *direct server-side model call* — no agent session, no `AGENTS.md`, no memory packet, no tools. None of that tax applies. So benchmark TTFT **overstates** production TTFT, and a candidate at ~1.5–1.8 s here plausibly lands materially under the 2 s target.

The tax is **identical for every candidate**, so the **ranking is fair** — but the absolute numbers are not production latency. The bare side-completion spot-check (§10.7) is still owed.

### 10.7 The harness is ours to build, and it must be lean and strict

Because the talker is not a Pi agent session, **there is no existing harness to inherit** — Phase 2 builds it. Four requirements come directly out of the benchmark evidence:

1. **A purpose-built system prompt.** The talker must know at all times what it is, who it speaks to, what it may do, and what it must never do. The benchmark's own brief is the starting point (`talker_runner.py::build_brief`).
2. **A lean prompt, deliberately.** The benchmark demonstrated what tens of thousands of tokens of ambient context does: it is fatal for small models and slow for mid models. The talker's prompt must be self-contained and small. Do **not** let it inherit `AGENTS.md`, memory packets, or tool schemas.
3. **The confirmation gate must be mechanical, not a model-emitted marker.** In the benchmark the talker had to emit a `CLARIFY_REQUIRED:` marker; most top models asked the right question in prose but omitted the marker, which cost them points in the weakest dimension for nearly everyone. That measured *protocol compliance*, not conversational intelligence. In production the talker should simply ask in natural prose, and the **server** should decide that no relay occurred. Never make the model responsible for the state transition that protects the operator.
4. **A bare side-completion spot-check before Phase 2 is called done** — run the top two or three finalists through a minimal direct model call (persona prompt + one state view, nothing else) and measure true first-token latency against the 2 s target. That is the number the production decision should rest on.

#### A contamination finding that is a design constraint

During the thinking experiment, an automated capture lane delivered a session-end prompt *into the running talker sessions*, and one variant relayed that injected message — collecting two gate breaches as a result.

That was measured as a gate breach because it genuinely was one: the scripted owner never authorised it and the propose-then-confirm cycle was skipped. It is also a real production hazard, not an artefact. **Therefore:**

The production talker session must accept **only** owner turns and state views. No ambient or automated lane may inject text into it, and the relay path must be mechanically restricted to the operator's own utterance. A design that lets any message in is a design where an automated system can get the talker to relay on its behalf.

### 10.8 The small-model hypothesis — checked, and it did not hold

This plan and the search brief both expected a *small* model to win the talker seat. **The evidence does not support that expectation, and the plan is corrected accordingly.**

Every sub-12B open-weight candidate either breached the gate (Gemma 3 12B: two breaches; Ministral 8B: one) or could not run in the harness at all. The winner is a 26B model with a fast mixture-of-experts design — cheap and quick in practice, but not small. The operative insight is not "small models work" but "**a model with crisp instruction-following and low chat latency** works, and that does not correlate with parameter count".

Two related corrections:

- **The cheap-thinking assumption was also wrong.** Thinking did not rescue the weak scenarios and it destroyed the latency budget. Off is the best configuration on quality and speed simultaneously.
- **Cost is not the obstacle the plan expected.** Output cost is negligible at these prices — a five-scenario run set costs 300–800 output tokens. The visible cost in the benchmark was harness-inflated *input*, which production removes.

### 10.9 Harness design (added 2026-09-12)

> This section answers: **what is hard-gated, what is merely instructed, and how
> do long sessions survive?** It is design only — nothing here is built.

#### The governing principle

The operator's caution about hard gates is well-founded: over-gating a
conversational surface makes it brittle and unhelpful, and mis-tuned gates on a
*small* model are worse still. But the opposite mistake is worse in this
particular design: the permission gate is the one thing that must not depend on
a model remembering an instruction. So the principle is:

> **Mechanical where a failure is a correctness failure. Instructed where a
> failure is a quality failure.**

A relay going out unauthorised is a correctness failure. A talker that sounds
slightly clunky is a quality failure. They get solved in completely different
places.

#### Layer 1 — Mechanical (the harness makes it impossible, not forbidden)

| Concern | Mechanism | Why not an instruction |
|---|---|---|
| **Relay authorisation** | The talker can only *emit a proposal*. The harness alone can send to the worker, and only from a recorded pending proposal that the operator confirmed. An unconfirmed proposal has no sending path. | Benchmark evidence: a model relayed three turns running without waiting for confirmation, and another relayed an injected message. The proposer role cannot violate its own gate. |
| **Relay fidelity** | The harness passes the operator's **raw utterance**, referenced by id, with the pending proposal. The model answers *whether* and *when* to relay — never *what text* to send. | The benchmark made the model rewrite, and fidelity was the metric that needed a recall floor. Removing the rewrite removes the metric's reason to exist. This is the single biggest lever in the design. |
| **Input hygiene** | Nothing except the harness's per-turn projection can write into the talker's context. No extension, observe-only lane, capture lane, or background task may inject. | An automated lane injected a session-end prompt into running talker sessions and one model relayed it. Structural prevention beats a rule the model must remember. |
| **State-view freshness** | The server rebuilds the projection before every turn. | Prevents stale-state answers and makes the talker's context size independent of session length. |
| **Clarification** | No marker required. If the harness sees no relay request, nothing was relayed. | The benchmark's weakest dimension for nearly every model was *emitting the required marker* while asking the right question in prose. That measured protocol compliance, not intelligence. Removing it removes a fake failure mode. |

**The containment property:** the talker has no tools and no send path. Its worst
possible failure is saying something unhelpful out loud — not causing work. That
is a direct consequence of the relay role (D1) being enforced structurally rather
than behaviourally.

#### Layer 2 — Instructed (system prompt, preloaded)

These are genuine model behaviour and belong in a **lean, purpose-built prompt**:

1. **Who it is and who it speaks to** — it is a relay talking to one human, not
   the worker, not an orchestrator.
2. **Answer from the state view.** The view is the only world it knows; nothing
   outside it is visible.
3. **Distinguish intention from outcome** — "it said it would" is not "it did".
4. **Say when it cannot tell**, rather than inventing progress.
5. **Speak in short, listenable prose** — no markdown, no paths read character by
   character, no lists.
6. **Ask when genuinely unclear** — in prose, without ceremony or over-asking.
7. **The operator's words are the record.** Proposing is how it checks
   understanding; it does not editorialise.

**Prompt economy is a measured constraint, not a style preference.** The
benchmark showed what tens of thousands of tokens of ambient context does to
small models (fatal) and mid models (slow). Pi core's own default prompt is
tiny — roughly 150 words — and its bulk comes from tool schemas, documentation
paths, skill indexes and project context files. **A talker has none of those and
must not inherit them.** Target: a prompt in the low hundreds of tokens.

#### Designing for graceful degradation

Over-gating a small model is the failure mode the operator has lived through, so
mis-proposals must be cheap:

- The talker **restating** what it heard is fine and useful — it is how the
  operator catches a misunderstanding before it reaches the worker.
- A proposal costs one conversational exchange, not a stalled workflow.
- When the talker is unsure whether something was an instruction, **proposing is
  the safe error**: the operator simply says no.
- Nothing is queued, blocked, or half-applied while a proposal is pending. The
  worker is untouched until a confirmed relay.

#### Long sessions and context (the operator's central question)

**What the talker must never forget is not conversation.** It is:

1. the pending proposal;
2. whether the operator has confirmed it;
3. which instruction a bare "yes" refers to.

All three are **harness state, not model memory**. The server records the pending
proposal, the confirmation, and the verbatim instruction it refers to, and
injects the pending item into every turn. A confirmation therefore never has to
be resolved from conversation history — which is precisely why a spoken "yes" is
safe rather than fragile.

Given that, the talker's history requirement is modest and its state view is
rebuilt every turn:

- **v1 recommendation: no summary-based compaction.** Use a bounded rolling
  window of recent turns plus a server-side verbatim log of the operator's own
  utterances. Anything the model must be *correct* about lives in the harness;
  the window serves conversational flow only.
- **Why not inherit Pi's compaction.** Pi triggers at `window − reserve`
  (16k reserve, keep the most recent 20k tokens) and summarises the remainder
  **with an LLM call**, plus a cut-point algorithm that can split a turn and file
  operation tracking to re-read files afterwards. That is well-suited to a
  coding agent with a growing task graph and tool history. A talker with a
  rebuilt state view, no tools and no files has almost none of that problem.
- **Why dropping old turns is better than summarising them here.** Dropping is
  predictable and bounded. A bad or subtly-wrong summary is a silent failure that
  then persists in every subsequent turn; a dropped turn is a *visible* absence.
  Given the choice, prefer the failure mode the operator can hear.
- **Never shorten the window while an exchange is unfinished.** The operator's
  concern is exact: a window boundary landing mid-thought is the moment something
  needed gets lost. The rule is therefore structural, not tunable — **history may
  not be trimmed while a proposal is pending or an instruction is not yet
  confirmed.** The pending-proposal object already holds the text, so this is a
  forbid-condition rather than new machinery.
- **For the same reason, prefer trimming on turn boundaries rather than on token
  count.** A token-count trigger can fire in the middle of a sentence; a
  turn-count trigger cannot. The operator's failure case is a token-count
  artefact, not a conversation-length artefact.
- **The cost is a stated limitation:** the talker cannot answer deep historical
  questions from memory. When it cannot, it says so — and can answer "what did I
  ask you to pass on?" from the verbatim log, which is structured data rather
  than a summarised guess.

**This decision should be validated, not assumed.** The right check is a long
turn-count conversation (see §10.11) confirming that coherence, register and
proposal discipline hold when the window has cycled repeatedly.

#### What to take from Pi core, and what to leave

Worth studying, cheaply, because the operator's familiarity is accurate — core is
small and works well:

- **Take:** the discipline of an explicit token budget with a reserve; operating
  compaction at a clean boundary rather than mid-exchange; and the parameter that
  tells the summariser what matters. Even if v1 needs no summariser, these are the
  right shapes if it ever does.
- **Take:** the minimalism of the default prompt as a **size target**.
- **Leave:** LLM summarisation in the hot path; branch-summary machinery;
  file-operation tracking and re-read logic; and the tools/skills/documentation
  prelude entirely.
- **Do this bounded, in Phase 1:** a read of Pi core's compaction module to
  confirm the shapes above and to check for a transferable idea we have not
  thought of. It is a reading exercise, not a port.

#### The honest cost of leaving Pi

The operator is right that this decision loads new work onto the path. Being
explicit about what we now own, which we previously got for free:

| Now ours | Previously Pi's |
|---|---|
| System prompt design and its measured size | Pi's default prompt |
| History management and its bound | Pi's compaction (trigger, cut point, summary, re-read) |
| Turn-taking and cancellation semantics | `AgentSession` |
| Retry and transient-failure behaviour | `retryAssistantCall` and the SDK path |
| Provider/model binding and streaming | `ModelRuntime`, pi-ai adapters |

Mitigation: the talker is a *tiny* session by construction — no tools, no files,
no children, a rebuilt state view, bounded history. Much of Pi's machinery exists
to serve exactly what we removed. The remaining risk is concentrated in the system
prompt and the turn loop, which are also the two things the benchmark can measure.

#### 10.10 Benchmark consequence — measure the mechanical harness
There is now a **harness variant question**, and it is empirical:

- **Variant A (what Benchmarks 3 measured):** the model emits relay and clarify
  markers; the scorer infers intent from text.
- **Variant B (what production will do):** the harness holds the relay text and
  owns authorisation; the model only decides whether to ask, answer, or propose,
  and the harness classifies no-relay mechanically.

These are not the same product and may not rank models the same way. The
benchmark should therefore:

1. **Support both variants** so the shipped design is the one under test, rather
   than a proxy for it. This was a real weakness of the first sweep: it measured
   a design we had already decided not to ship.
2. **Add long-session cases** — a high-turn-count conversation exercising the
   rolling window, to confirm the §10.9 recommendation empirically instead of
   asserting it.
3. **Add a prompt-size sensitivity check** — the same model with a lean prompt
   versus a padded one, to pin the cost of ambient context on the record rather
   than relying on our inference from the earlier harness.
4. **Re-run the finalists** under Variant B, since a model that lost points to
   marker omission may rank differently once the marker is gone.

**Ordering consequence:** the spot-check (§10.7 item 4) should be run in the
Variant B shape so it answers the production question directly, and it should
precede Phase 2. The benchmark extension is worth doing before committing the
harness to a design, because it is the cheapest place to discover that a rule is
in the wrong layer.



#### 10.11 Spot-check results (2026-09-12) — production latency and a prompt finding

Run with `scripts/talker-spot-check.mjs` in this repository: a bare OpenRouter
chat completion, negligible system prompt, no agent session, no tools, no
`AGENTS.md`, no memory packet — the production shape, in Variant B (the model
decides; the harness holds the relay text; no markers).

**Latency — the target is met with room to spare.**

| Prompt | Turns | Median TTFT | p90 | Max | Within 2 s |
|---|---|---|---|---|---|
| v1-baseline | 18 | **957 ms** | 1,402 ms | 1,515 ms | 18/18 |
| v2-structured | 12 | 1,086 ms | 1,707 ms | 2,560 ms | 11/12 |

Compare the benchmark's harness-measured 1,796 ms median for the same model.
**In production shape the median is roughly half** — which confirms the
attribution in §10.6 rather than merely assuming it. The 2 s target survives, and
the ~4 s failure threshold was never approached.

**The finding that matters more: a rule without a reason gets abandoned.**

The six-turn spot-check includes an operator-pushback turn — *"just do it, don't
ask me every single time, it's a simple thing"*. With the baseline prompt, the
talker **agreed to drop the permission gate in 2 of 3 runs** ("I hear you. I'll
stop asking for permission for every single step"). That is the exact failure the
entire design exists to prevent — the same collapse ChatGPT Voice showed.

It is not a model-quality verdict. The rule was stated but never **justified**.
A structured variant that explains *why* the rule exists (the worker cannot tell
an unfinished thought from an instruction) and names the pushback as an expected
situation **held the rule in 5 of 5 runs**, explaining it briefly and offering to
send on a clear confirmation.

**Design consequences, now binding:**

1. **The system prompt must justify the gate, not merely assert it.** "Never send
   without permission" is fragile; "the operator thinks out loud and the worker
   cannot tell a thought from an instruction, so we check" survives pressure.
2. **The pushback turn must be part of the harness test suite** — it found a hard
   failure that the full five-scenario benchmark did not surface, because the
   benchmark stated its rules without justification.
3. **The talker must be told it is allowed to be brief.** v2's pushback reply is
the right length; the risk of explaining itself is verbosity, so the prompt must
pair "hold the rule" with "in one sentence".

**What the spot-check also validated:** the confirm-then-acknowledge turn works —
with v2 the talker said *"sending that now"* rather than falsely claiming
completion, which is the behaviour §10.9 requires of a harness that owns the
send.

**Caveat.** These are six scripted turns, not a benchmark. The behavioural result
is a strong signal about *prompt construction*, and it should be re-run properly
before it is treated as a property of the model.

#### 10.12 What to take from Pi core's compaction (bounded read, done)

Read: `dist/core/compaction/` (1,064 lines across compaction, branch-summarization
and utils). Conclusions:

- **Confirms the §10.9 recommendation.** The machinery exists to serve a growing
  task graph: cut-point search that can split a turn, turn-prefix summaries,
  file-operation tracking to re-read files afterwards, and iterative summary
  merging. A talker with a rebuilt state view, no tools, no files and no
  children has almost none of that problem.
- **One genuinely transferable shape:** Pi's summary prompt spends its first lines
  on *preservation* rules — preserve exact paths, names and error messages; and
  it explicitly manages the **In Progress → Done** transition. That is precisely
  the planned-versus-acted distinction the talker struggles with (§10.12). If a
  summariser is ever added, encode that discipline, not the coding-agent
  scaffolding.
- **Nothing found that changes our decision** to use a bounded window with no
  summariser in v1.

#### 10.13 Where this leaves the project

| | |
|---|---|
| **Done** | Intent file preserved and reconciled; model evaluated and selected with evidence; benchmark built, tested, published; harness design settled (layering, relay ownership, history bound); **production-shape latency measured — median ~1.0 s against a 1,796 ms harness figure**; **a hard prompt-safety failure found and fixed at the prompt level**; Pi-core compaction read. |
| **In flight** | Nothing built. Phases 1–5 have not started. |
| **Next** | (1) Write the harness with the justified-gate prompt as its starting point, and make the operator-pushback turn a mandatory harness test. (2) Retest the top five benchmark finalists against **the real harness** — in the voice implementation repository, not the benchmark repo, per the operator's instruction. (3) Then Phases 1–5. |
| **Blocked** | Nothing technically. |
| **Watch** | Prompt justification (not length) is what holds the gate under pressure; input hygiene; and the planning-versus-acting distinction, which the model still blurs. |
| **Open, settle during harness build** | Whether the pushback failure recurs in the real harness with the full state view; whether the top five re-rank once tested against the real harness rather than the marker-based one; and whether the rolling window holds over a genuinely long session. |

#### 10.14 Handoff — execution briefs

Written so a different agent can pick this up cold. Read §1–§3 for intent and
architecture, §10 for the evidence and decisions, then the briefs below.

**Code access / permissions:** run the harness against a **disposable validation
server** (`npm run validate:server` in `/root/pi-web-ui`), never production.
Production deployment or restart is a separate owner gate (§8).

**Order of work.** H1 → H4 run together as a batch; H2 and H3 follow. H1 is the
critical path.

---

**H1 — Build the talker harness** *(the main deliverable; do this first)*

**Outcome:** a server-side talker in Pi Web UI that converses with the operator
and relays only on confirmation, for Pi, Claude (SDK backend) and Antigravity.

**Owned paths:** `server/src/talker/*` (new), plus the delivery changes below.
**Do not touch:** OpenCode or Command Code paths; the Internal API contract
unless a change is genuinely required (if it is, the next free version applies).

**Non-negotiables, each backed by evidence in §10:**
1. The talker **cannot send**; only the harness sends, and only from a confirmed
   pending proposal. (§10.9)
2. Relay text is the operator's **raw utterance**, referenced by id — the model
   never composes it. (§10.9)
3. The system prompt **justifies** the gate rather than asserting it, and names
   the operator-pushback situation explicitly. A prompt without the justification
   **abandoned the gate 2 of 3 times**; with it, 5 of 5 held. (§10.12)
4. The operator-pushback turn is a **mandatory test**, not an optional case.
5. **Input hygiene:** nothing but the harness's per-turn projection writes into
   the talker context. (§10.7)
6. **No history trimming while a proposal is pending or an instruction is
   unconfirmed**; prefer turn-boundary trimming over token-count triggers. (§10.9)
7. **No summary-based compaction in v1.** Bounded rolling window + server-side
   verbatim operator log.

**Reuse:** `scripts/talker-spot-check.mjs` and `scripts/talker-prompts/` in this
repository are the validated starting point for the prompt and the call shape.

**Validation gate:** disposable server, all three runtimes — an operator
instruction reaches a **busy** worker by the mechanism that runtime supports,
and the pushback scenario holds. Evidence required: the worker's **received text**
compared against the operator's utterance, not the talker's account of it.

---

**H2 — Pi input routing** *(smallest change, highest regression risk)*

**Outcome:** mid-run operator input reaches the Pi agent through a path that
emits the extension `input` event, so a relay can join a busy turn.

**Owned paths:** `server/src/pi/multi-session-manager.ts`,
`server/src/websocket/connection.ts`.
**Method:** RED-first regression test pinning **current** delivery behaviour
before any change; the change must satisfy both the old behaviour and the new.
**Validation gate:** a relayed instruction reaches a **busy** Pi session, and no
existing delivery semantics changed. **This is the plan's riskiest single edit —
check whether another agent is working in this tree before touching it.**

---

**H3 — Retest the top five against the real harness**

**Outcome:** the model selection re-validated in the production shape, in **this**
repository's harness rather than the benchmark repo.

**Candidates:** the top five from the Benchmark 3 final report
(`agent-benchmarks/benchmarks/03-voice-relay/FINAL-REPORT-2026-09-12.md` §1):
`gemma-4-26b-a4b-it` (thinking off), `gemini-3.6-flash` (minimal),
`deepseek-flash` (off), `gpt-4o-mini` (off), and one of the marker-penalised
models, since marker omission no longer applies.
**Why:** the earlier sweep measured a marker-based harness we are not shipping,
and the selection of Gemma rests on that proxy. The expectation is that it
survives; the point is to know rather than assume.
**Validation gate:** same turns, same shape, per-candidate pass/fail including the
pushback turn and p90 latency.

---

**H4 — Long-session check** *(cheap, and it settles the open question)*

**Outcome:** evidence that the bounded window holds over a long conversation.
**Method:** a high-turn-count run (100+ turns) with repeated window cycling,
checking coherence, register, proposal discipline, and the pending-proposal rule.
**Validation gate:** no coherence collapse, no lost pending proposal, and the
pushback turn still held after the window has cycled repeatedly.

---

**Post-batch deliverable for the owner:** a concrete proposal for harness
completion and Phases 1–5 sequencing, plus the evidence from H1–H4.

