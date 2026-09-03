# Plan: Pi model binding durability across rehydration (contract 1.33.0)

## Intent and rationale

Incident 2026-09-03 (MuseSpark benchmark, conductor session `01a0688d`): 6 of 8
detached dispatches to freshly created Pi sessions ran on `zai/glm-5.3`
(the runtime default) instead of the requested `commandcode/*` model. The
conductor detected only 4; two contaminated runs were never caught (one
completed, one still running).

Root cause chain, all server-side — not fixture drift:

1. **Create-time binding is memory-only.** `POST /sessions` (pi) applies
   `setModel`/`setThinkingLevel` to the live AgentSession but never persists the
   binding. (`claude` already persists via `patchSessionMeta`; `pi` never did.)
   The control `set_model`/`set_thinking_level` handlers for pi do not persist
   either, so even manual rebinds are lost.
2. **Eviction is routine.** Production runs the session manager at
   `maxSessions=4` with a 60s sweep; headless creates idle until dispatched and
   are prime eviction candidates ("Unloading oldest idle session to enforce
   limit" precedes every drift).
3. **Rehydration cannot restore the binding.** On next dispatch,
   `subscribeClient` → `piService.createSession` → SDK `createAgentSession`
   restores a history binding only when the session has ≥1 message
   (`hasExistingSession = messages.length > 0`). A message-less session falls to
   `findInitialModel()` → server default. The default-pair `model_change`
   written at rehydrate time is the drift signature; server logs pair it with
   every "Rehydrating session from disk" line. Deterministic given eviction —
   the conductor's "~50% race" framing was wrong.
4. **Silence.** Receipts record the model observed at accept time
   (`currentRunModel(entry)` — the live, possibly drifted model), nothing
   verifies served-vs-intended, and no broker event fires on re-bind. Detection
   required hand-scraping child JSONLs (unreliable: it missed 2 of 6 drifts).

## Changes (pi runtime only; additive contract 1.33.0)

- **C1 — create persists the binding.** The pi create case writes
  `model` (the applied selector) and `thinkingLevel` (as requested) to the
  registry via `patchSessionMeta` after successful bind.
- **C2 — control persists rebinds.** pi `set_model` and `set_thinking_level`
  write the same fields (thinking level stores the clamped read-back value).
- **C3 — dispatch re-binds from the registry.** In `executePrompt`'s pi case,
  inside the existing per-session model lock and before the turn starts, compare
  the live model against `entry.model`; on mismatch resolve + re-apply
  (`piService.setModel`, then `setThinkingLevel` when the stored level differs),
  re-check provider policy first. No `entry.model` → unchanged behaviour
  (sessions that never requested a model legitimately use the default).
- **C4 — loud failure, never silent default.** An unresolvable stored binding
  fails the run with `MODEL_NOT_APPLIED` (new `PiModelBindingError`, mapped in
  `executePromptWithReceipt`); a blocked provider fails with
  `PROVIDER_NOT_ALLOWED` (existing class). The prompt never starts on a model
  the operator did not ask for.
- **C5 — receipts carry served truth.** New `recordServedModel(runId, model,
  rebound)` on the run receipt manager; receipts gain additive `servedModel` and
  `modelRebound` fields so receipt reconciliation (runbook §4.5) detects drift
  without scraping session files.
- **C6 — broker visibility.** A `model_rebound` control event is published when
  C3 re-binds (broker key = pi sessionPath, consistent with publishers).

Contract: `INTERNAL_API_CONTRACT_VERSION` 1.32.0 → **1.33.0** (additive
receipt fields + new event type). agent-os mirror resyncs in lockstep
(client constant, pin test, contract doc).

## TDD gates

New `server/tests/unit/internal-api/session-routes-model-binding.test.ts`
(RED before each GREEN):

1. create with model+thinkingLevel persists both via `patchSessionMeta`.
2. dispatch with live ≠ registry re-applies setModel + setThinkingLevel before
   `prompt()`, receipt carries `servedModel` + `modelRebound: true`, and a
   `model_rebound` event reaches the observer.
3. dispatch with live == registry performs no `setModel` (no spurious churn).
4. dispatch with no stored `entry.model` leaves behaviour unchanged.
5. unresolvable stored binding → receipt failed `MODEL_NOT_APPLIED`, no prompt.
6. blocked-provider stored binding → `PROVIDER_NOT_ALLOWED`, no prompt.
7. control `set_model` / `set_thinking_level` (pi) persist via `patchSessionMeta`
   (level = clamped read-back).
8. run-receipt-manager: `recordServedModel` persists and surfaces publicly;
   unknown/terminal run is a safe no-op.

## Validation

- Focused suites, then `npm run lint`, `typecheck`, `build`, full `npm test`.
- Disposable-server live validation replaying the incident: create with a
  non-default model, force eviction (small maxSessions / sweep), dispatch,
  assert the child log shows no default-pair `model_change` after dispatch and
  the receipt reports the intended `servedModel`.

## Deploy gates

- agent-os mirror resync + full agent-os validation.
- Production restart is separately gated: pre-checks (activeTurns 0, no
  nonterminal receipts) **and** no active benchmark children — the conductor
  session's wave must have settled first.

## Out of scope

- SDK-side restore for message-less sessions (upstream @earendil-works
  contribution draft — separate decision).
- Capacity policy changes; eviction becomes semantics-preserving with C3.
- Non-pi runtimes (claude already persists; opencode/commandcode bind at spawn).
