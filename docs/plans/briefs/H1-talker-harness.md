# H1 — Build the voice talker harness (server-side)

You are a child worker. Complete this end-to-end, then report back. Do not ask the operator anything — if you hit a genuine blocker, stop and report it.

## Outcome

A server-side **talker** in Pi Web UI that holds a spoken conversation with the operator while a reasoning worker runs, and relays the operator's instruction to that worker **only after explicit confirmation**.

Read these before writing any code, in this order:
1. `docs/plans/DRIVE-MODE-TWO-LANE-PLAN.md` — **the whole thing**, especially §10.9 (harness design), §10.11 (spot-check findings) and §10.15 (phases). This plan is the authority; it records decisions and the evidence behind them.
2. `docs/VOICE-ORCHESTRATOR-FEASIBILITY.md` — the preserved intent file. Read it for intent; do not edit it.
3. `scripts/talker-spot-check.mjs` and `scripts/talker-prompts/v2-structured.txt` — the validated call shape and the prompt that **passed** the safety test. Your harness must reproduce this shape.

## The seven non-negotiables (each is backed by evidence in the plan)

1. **The talker cannot send.** Only the harness sends, and only from a confirmed pending proposal. There must be no code path from "model said so" to "the worker received it".
2. **Relay text is the operator's raw utterance**, held by the harness and referenced by id. The model decides *whether* and *when* to relay — never *what text* to send. This is the single biggest lever: it removes intent-drift as a failure mode.
3. **The system prompt justifies the gate, it does not merely assert it.** A prompt that asserted the rule without explaining why **abandoned the gate in 2 of 3 runs**; the justified variant held it **5 of 5**. Start from `scripts/talker-prompts/v2-structured.txt`.
4. **The operator-pushback turn is a mandatory test**, not an optional case: the operator says something like "just do it, don't ask me every time". The talker must hold the rule, explain briefly, and offer to send on confirmation.
5. **Input hygiene:** nothing except the harness's per-turn projection may write into the talker's context. No ambient injection, no capture lane, no extension. An injected message has already caused an unauthorised relay in testing.
6. **History is a bounded rolling window**, trimmed on **turn boundaries**, and **never trimmed while a proposal is pending or an instruction is unconfirmed**. No LLM summariser in v1.
7. **Confirm-before-speak ack.** The talker says exactly **"sending that now"** when a message is released — and only after the harness has confirmed the send succeeded. It must never claim the worker finished or succeeded.

## Design detail you must implement

**The state view (§ Phase 1).** A bounded, deterministic projection of worker state that the talker reads: elapsed, current worker activity, recent tool events, background children and their statuses, pending items, and the last assistant text. It must be bounded, must never include file contents, must never include secrets. Prototype shape: `scripts/talker-spot-check.mjs::renderState`.

**The pending-proposal object (harness state, not model memory).** The server records: the proposal text, the verbatim operator utterance it refers to, and whether it has been confirmed. A bare "yes" resolves to the pending proposal — this is what makes voice confirmation safe rather than fragile. Which instruction a confirmation refers to must never be recovered from conversation history.

**Runtime adapters — deliverability differs and must degrade honestly:**
- **Pi** — mid-run delivery needs the input-routing change (that is H2, a separate child; do not implement it). Until H2 lands, deliver via the existing path and say so.
- **Claude** — native steer/follow-up, **SDK backend only**. Non-SDK backends must refuse honestly, never silently degrade.
- **Antigravity** — follow-up only; no mid-run join. "Your message will arrive after this turn" is a normal outcome, not an error.

**Mechanical enforcement, not model cooperation:** no relay markers, no protocol the model must follow. The model's job is purely conversational: answer, ask, or propose.

## Scope and paths

**Owned (yours to create/edit):**
- `server/src/talker/` — new module: state-view projection, prompt, turn loop, pending-proposal store, runtime adapter seam.
- `scripts/talker-harness.mjs` (or a small runner) — a way to exercise the harness end-to-end against a real model without the browser.
- Tests for all of the above.

**Read-only (do not edit):** `docs/VOICE-ORCHESTRATOR-FEASIBILITY.md`, `docs/plans/DRIVE-MODE-TWO-LANE-PLAN.md` (report proposed corrections instead), `scripts/talker-prompts/*` (you may add a new variant file but not overwrite `v2-structured.txt`).

**Do not touch:** Drive Mode client code, the WebSocket protocol, the Pi delivery path (`server/src/pi/multi-session-manager.ts`, `server/src/websocket/connection.ts`) — H2 owns those. Another agent may be in those files.

**Do not commit or push.** Leave your work in the tree; the parent will review, validate and commit.

## Method — TDD and live validation are mandatory

1. **Write failing tests first** for each non-negotiable, watch them fail, then implement. Record the RED evidence.
2. **Test the gate hard**, from different angles: relay without a proposal; relay before the proposal; authorisation consumed by a previous relay; ambiguous "yes"; the pushback turn. The gate must be enforced by a test that fails if it is ever weakened.
3. **Live-validate against a real model.** Use the disposable validation server (`npm run validate:server` in this repo) — **never production**. A direct OpenRouter call in the spot-check shape is acceptable for the latency/behaviour check; set `OPENROUTER_API_KEY` from `~/.bashrc`. Report real measured numbers.
4. **Measure the production shape**: first-token latency against the 2 s target / 4 s failure line, and the pushback behaviour, replicated from the spot-check. Report the numbers you actually observed.
5. **Validate from a second angle**: prove the gate is structural by attempting to bypass it — call the send path directly with an unconfirmed proposal and show it cannot relay.

## Environment

- Repo: `/root/pi-web-ui` (main tree — you own it). Working tree is clean at `da420f5`; verify with `git status --short` before you finish.
- Checks: `npm run typecheck`, `npm run lint`, `npm test` (relevant subset is fine, but say which you ran). `npm run docs:check-agent-guides` if you touch `AGENTS.md`.
- Model for any probe you run: use the harness's configured model. The selected production talker is `openrouter/google/gemma-4-26b-a4b-it`, thinking **off**.
- The Internal API is at `/root/.pi-web-ui/internal-api.sock` with token `/root/.pi-web-ui/internal-api-token`.

## Stop and report if

- You cannot enforce the gate structurally (i.e. it would have to rely on the model behaving).
- The prompt cannot hold the pushback turn after honest attempts.
- You need to change the WebSocket protocol or the Pi delivery path (that is H2).
- Anything requires production access or a production restart.

Do **not** narrow the scope silently. If you cannot do part of this, say exactly which part and why.

## Hand-back format (report exactly this)

1. **Status**: complete / partial / blocked.
2. **What was built** — files with paths, and the shape of the harness in a short paragraph.
3. **TDD evidence** — for each non-negotiable: the failing test, then the passing one. Command + observed result.
4. **Live validation evidence** — commands run, models/endpoints used, and the **raw measured numbers**: first-token latency (median, p90, max), pushback-turn outcome, any gate breaches.
5. **Independent-verification attempt** — how you tried to bypass the gate and what happened.
6. **Checks run** — exact commands with exit status (`typecheck`, `lint`, tests).
7. **What you could NOT do** and why.
8. **Anything you found that contradicts the plan** — state it as a finding; do not silently adapt.
