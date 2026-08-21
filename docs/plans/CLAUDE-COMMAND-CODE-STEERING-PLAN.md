# Claude + Command Code Steering Implementation Plan

**Date:** 2026-08-20 · **Status:** complete — implemented, unit-tested, and live-validated on the real browser WebSocket protocol for both runtimes (Claude via GLM SDK profile on a disposable server; Command Code via the extended fixture). · **Scope:** bring the Pi-style mid-run
steering UX (composer stays live while streaming: `steer` / `follow_up`) to the
Claude (SDK backend) and Command Code runtime paths.

## Research conclusions (empirically verified 2026-08-20)

### Claude Agent SDK (installed 0.3.185 driving system claude 2.1.235)
- Streaming-input mode (`query({ prompt: AsyncIterable<SDKUserMessage> })`) is
  required for steering; string prompts close stdin and cannot be interrupted.
- `SDKUserMessage.priority` semantics verified by wire probe against the real CLI:
  - `'next'` → injected at the next tool boundary, joins the CURRENT turn
    (num_turns grows, single result). At turn tail it degrades gracefully to a
    follow-up turn; while CLI idle (stream open) it starts a new turn. Never dropped.
  - `'now'` → aborts the in-flight tool call, turn ends, message runs as its own turn.
  - `'later'` → current turn runs to completion, message runs as its own turn.
  - omitted → **silently dropped** by CLI 2.1.235. Every mid-turn push MUST set a priority.
- `interrupt()` works (receipt w/ `interrupt_receipt_v1`) but produces an
  `error_during_execution` result; `priority:'now'` is the cleaner "immediate" path.
- Injected messages are NOT echoed back on the stream → the server must emit
  synthetic user `message_start` events so the UI transcript (and queued-chip
  clearing) works like Pi.

### Command Code (cmdc 1.28.4)
- Print mode (`-p`) reads stdin ONCE until EOF (30s timeout); no mid-run stdin
  protocol. Native steering queues exist inside the agent loop
  (`getSteeringMessages`/`drainSteering`) but are only wired to the interactive TUI.
- Therefore: **steer = abort current run + immediately send the steering text as
  the next prompt on the same native session** (`--resume`); **follow_up = server-side
  queue drained when the run ends** (FIFO, chained).

## Design

### Server — Claude SDK (`claude-sdk-service.ts` + new `claude-steer-stream.ts`)
- `SteerablePromptStream`: pushable AsyncIterable + `end()`, `scheduleEnd(ms)`
  (cancelled by push), `hasPending()`.
- `sendPrompt` passes the stream as prompt; on each `result`, if no pending
  pushes, `scheduleEnd(STEER_END_GRACE_MS)` closes stdin after a short grace so
  late follow-ups still land in the same query; query loop then finishes and the
  existing agent_end/onComplete path runs (unchanged lifecycle).
- `steer(sessionId, text)` → push `{priority:'next'}` + synthetic persisted user
  message event; `followUp(sessionId, text)` → `{priority:'later'}` + same.
  Both return false when the session has no live steerable run.
- Transient-retry iteration drops the old stream (steers only exist once content
  streamed; pre-stream retry window never has steers).
- `ClaudeService` facade delegates `steer`/`followUp` to the SDK service
  (channel sessions: not supported → false).
- `connection.ts`: `handleSteer`/`handleFollowUp` route claude sessions to the
  facade; `handleClaudePrompt` busy-poll (30s) replaced with immediate
  `SESSION_BUSY` + steer hint (parity with the Pi path guard).

### Server — Command Code (`command-code-service.ts` + `connection.ts`)
- `CommandCodeService.waitForTurnEnd(sessionId)` exposes the in-flight turn promise.
- `connection.ts` keeps `commandCodeFollowUps: Map<sessionId, string[]>`:
  - steer while running → `abort()`, `await waitForTurnEnd()`, then send the
    steer text as the next prompt, then drain follow-ups.
  - follow_up while running → enqueue; drained after the current/steer run ends.
  - Stop (user abort) clears the queue.
  - steer while idle → plain prompt.

### Client
- `canSteerWhileStreaming`: `pi | claude | commandcode`.
- Runtime-aware composer labels/tooltips (Steer semantics differ per runtime).
- Queued-chip clearing already keys on the transcript echo → covered by the
  synthetic user message events both new paths emit.

## TDD + validation
1. Unit tests first: steer-stream helper, claude sdk service steer/followUp
   (mocked `query`), connection routing for both runtimes, CMD queue/abort chain,
   client `canSteerWhileStreaming`.
2. `npm run lint && typecheck && build`, workspace tests.
3. Live validation (disposable server): real Claude runtime steer + follow_up
   pivot scenario; Command Code fixture steer-interrupt + follow-up chain scenario.
4. Commit/push, production restart, prod smoke via CDP hard-reload.

## Out of scope
- Internal API `steer` mode stays pi-only (documented as such); OpenCode /
  Antigravity steering; Claude `priority:'now'` UI exposure (wire protocol has
  no mode field — matches existing Pi Web UI two-mode UX).
