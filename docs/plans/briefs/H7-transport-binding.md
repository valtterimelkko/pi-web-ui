# H7 — Transport binding: make the talker reachable from the browser

You are a child worker. Complete this end-to-end, then report back. Do not ask the operator anything — if you hit a genuine blocker, stop and report it.

## Context

The voice talker is built, tested and wired into the server:

- `server/src/talker/` — the harness (state view, pending-proposal store, delivery adapters, the structural gate). Its only entry point is `TalkerSession.handleOperatorTurn(utterance)`.
- `server/src/talker/session-registry.ts` — `TalkerSessionRegistry`, constructed by `WebSocketConnectionManager` with the `MultiSessionManager` that class owns, reachable via `getTalkerSessionRegistry()`. **Its `handleOperatorTurn({workerSessionId, utterance, runtime})` has no caller yet.**

**That missing caller is your job.** Today an operator utterance cannot reach the talker from the browser at all.

Read first: `docs/plans/DRIVE-MODE-TWO-LANE-PLAN.md` §10.9 (harness design), `server/src/talker/session-registry.ts`, `server/src/talker/talker.ts` (the entry point), and the WebSocket router in `server/src/websocket/connection.ts`.

## Outcome

An operator can hold a talker conversation from the browser against a worker session, and the gate holds end to end:

1. The browser sends an operator utterance → the talker replies conversationally (no dispatch).
2. An instruction → the talker proposes; **nothing reaches the worker**.
3. The operator confirms → the harness releases the operator's **verbatim** words through the delivery adapter, and the fixed acknowledgement is returned.
4. The reply reaches the browser so it can be spoken.

## Required

1. **A transport path** from the browser to `registry.handleOperatorTurn(...)`. Prefer the **existing WebSocket message mechanism** — add a message type (e.g. `talker_turn`) and a response/callback shape consistent with the protocol's conventions. Read `shared/src/protocol-types.ts` and `server/src/websocket/protocol.ts` before choosing; follow the established patterns rather than inventing a parallel one.
2. **Return the turn result** so the client knows what happened: at minimum the reply text, whether something was released, and the delivery outcome. The client must be able to distinguish "answered", "proposed", "released", and "refused".
3. **Preserve the gate.** `release()` stays private and reachable only from the confirm branch. If your transport work appears to require widening it, **stop and report** — that is a design violation, not a transport detail.
4. **Input hygiene.** The utterance must pass the registry's existing prompt-injection check before any model call (the registry already does this — do not bypass it by calling `TalkerSession` directly).
5. **Client-side minimum.** A way for the browser to send an utterance and receive the reply. A minimal, testable surface is enough — this is the transport seam, not the finished Drive Mode UI. **Drive Mode UI work is out of scope.**
6. **Do not break existing messages.** The WebSocket router serves every runtime; add without altering existing behaviour.

## Scope and paths

**Owned:**
- `shared/src/protocol-types.ts` (additive message types only)
- `server/src/websocket/connection.ts` (router case + handler)
- `server/src/websocket/protocol.ts` if that is where validation belongs
- The minimal client wiring needed to drive it (`client/src/hooks/useWebSocket.ts` or a small dedicated hook)
- Tests for all of the above.

**Do not touch:** `client/src/lib/websocket.ts` and `client/src/hooks/useDriveModeDictation.ts` — **another child is working on client socket durability in those files right now.** If your client wiring needs to live near them, put it in a separate file and say so.

**Do not touch:** the talker library internals (`talker.ts`, `pending-proposal.ts`, `delivery.ts`, `model-client.ts`, etc.) — their contracts are verified. Report defects rather than fixing them.

**Do not commit or push.** Leave work in the tree for parent review.

## Method — TDD

1. **RED first**: a test that sends the browser message and asserts a talker reply comes back must fail because no route exists.
2. Implement the minimum path, then green.
3. **Test the gate through the transport**, not just the library:
   - instruction → reply says it is proposed, and a delivery spy records **nothing**;
   - confirm → release happens with the **verbatim** utterance, and the acknowledgement is exactly `sending that now`;
   - a second confirm → nothing further released;
   - a refused delivery surfaces the refusal honestly rather than being swallowed;
   - an injection utterance is refused before any model call.
4. **Live-validate on a disposable validation server** (`npm run validate:server`) — never production. Drive a real browser message through the real server against a real Pi worker session, and report the **worker's received text** compared byte-for-byte against the operator utterance. If a real browser is impractical, drive the WebSocket directly and say exactly what you did.
5. Run the existing websocket and talker suites and report any regression.

## Environment

- Repo: work in the tree given to you. Verify `git status --short` first.
- Talker suite: `npx vitest run server/tests/unit/talker/ --reporter=basic` (138 currently passing).
- Checks: `npm run typecheck` (exit 0), `npm run lint` (exit 0; pre-existing warnings normal).
- A child shell may leak `OPENCODE_ENABLED`/`PI_MAX_SESSIONS` — rule those out with `env -u OPENCODE_ENABLED -u PI_MAX_SESSIONS` before calling anything a regression.

## Stop and report if

- The transport appears to require widening the gate.
- A protocol change beyond an additive message type is needed.
- Concurrent edits appear in `client/src/lib/websocket.ts` (the other child owns it).

## Hand-back format (report exactly this)

1. **Status**: complete / partial / blocked.
2. **The transport shape** — message types added, the request/response contract, and where it is handled.
3. **RED→GREEN evidence** — the failing route test first.
4. **Gate-through-transport evidence** — propose / confirm / double-confirm / refusal / injection, with actual outcomes.
5. **Live validation** — commands, and the worker's received text verbatim vs the operator utterance.
6. **Regression check** — which existing suites you ran and their results.
7. **Checks run** — exact commands with exit status.
8. **What you could NOT do** and why.
9. **Any finding that contradicts the plan** — state it; do not silently adapt.
