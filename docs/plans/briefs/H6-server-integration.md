# H6 — Wire the talker into the server (Phase 3 integration)

You are a child worker. Complete this end-to-end, then report back. Do not ask the operator anything — if you hit a genuine blocker, stop and report it.

## Context

A complete, tested talker harness exists at `server/src/talker/` (10 modules, 108 tests passing). It is currently **a library with a CLI runner and no server integration** — `createDefaultDeliveries()` exists but nothing constructs a `TalkerSession` in the running server, so no operator turn can reach it.

Your job is the integration that makes it a real surface.

**Read first, in this order:**
1. `docs/plans/DRIVE-MODE-TWO-LANE-PLAN.md` — §10.9 (harness design), §10.15 (phases). The plan is the authority.
2. `server/src/talker/talker.ts` — the `TalkerSession` public surface (`handleOperatorTurn` is the only entry point).
3. `server/src/talker/delivery.ts` — `createDefaultDeliveries()` and the `PiDeliveryDeps` seam.
4. `server/src/talker/types.ts` — the contracts.
5. `scripts/talker-harness.ts` — a working example of constructing and driving a session.
6. `server/src/pi/multi-session-manager.ts` — what the Pi delivery needs, and note `steer()` was just fixed to emit the extension input event.

## Outcome

A running server can hold a talker conversation for a **Pi** worker session, end to end:

1. An operator utterance arrives → the talker answers conversationally from a fresh state view.
2. An instruction → the talker proposes; **nothing is sent**.
3. The operator confirms → the harness releases the operator's **verbatim** words through the Pi delivery adapter, and the fixed acknowledgement is spoken.
4. The worker actually receives the text.

## Requirements

1. **Wire `createDefaultDeliveries()` with a real `MultiSessionManager`.** The manager is *not* a module singleton — it is owned by `WebSocketConnectionManager`. Either supply it explicitly from that owner, or expose a narrow accessor. Do not create a second manager instance; that would target sessions the server does not manage.
2. **One talker session per worker session**, created on demand and retained with the same lifecycle discipline as other session state. Do not leak one per turn.
3. **Respect the existing security posture.** Operator utterances reach a model: run the **prompt-injection check** (`blockIfPromptInjection` or the shared equivalent) before forwarding, exactly as other operator input paths do. This is a non-negotiable repo rule — check `server/src/security/` and how `connection.ts` applies it.
4. **Surfaces must be honest about capability.** If a runtime's delivery adapter would refuse (Claude on a non-SDK backend, Antigravity with no running turn, an unwired Pi), the refusal must reach the operator as the acknowledgement, not be swallowed.
5. **Do not change the gate.** `release()` must remain the only send path and must remain reachable only from the confirm branch. If integration appears to require widening that, **stop and report it** — it is a design violation, not an integration detail.
6. **No production access.** Disposable validation server only.

## Scope and paths

**Owned:**
- A new integration module, e.g. `server/src/talker/session-registry.ts` (or similar) — talker-session lifecycle and wiring.
- The minimum edit at the existing construction site to supply the `MultiSessionManager` (likely `server/src/websocket/connection.ts` or the Pi service that owns it).
- Tests for the above.

**Do not touch:** `server/src/talker/talker.ts`, `pending-proposal.ts`, `history.ts`, `ack.ts`, `delivery.ts` internals, `state-view.ts`, `prompt.ts`, `utterance-classifier.ts` — their contracts are verified; integrate around them. If you find a defect in one, **report it, do not fix it**.

**Do not** add a WebSocket protocol message type or change the Internal API contract — out of scope. If you conclude either is genuinely required, stop and report.

**Do not commit or push.** Leave work in the tree for parent review.

## Method

1. **Write the failing integration test first** (RED): constructing the server's talker for a Pi session and delivering a relayed instruction should fail before your wiring exists.
2. Implement the minimum wiring.
3. **Test the gate through the integration**, not just the library: propose → nothing delivered; confirm → verbatim text delivered; second confirm → nothing; refusal paths surface honestly.
4. **Live-validate against a real Pi session on a disposable validation server** (`npm run validate:server`) — never production. Prove: an operator instruction, once confirmed, reaches a **busy** Pi worker, and the worker's received text matches the operator's utterance byte-for-byte. Report the actual received text.
5. Run the relevant existing suites — especially anything touching session lifecycle, the websocket manager, and the Pi delivery path — and report any regression.

## Environment

- Repo: `/root/pi-web-ui` (main tree). Clean at `e7fbc14`; verify `git status --short` before finishing.
- Talker tests: `npx vitest run server/tests/unit/talker/ --reporter=basic` (108 currently passing — they must stay green).
- Checks: `npm run typecheck` (exit 0), `npm run lint` (exit 0; repo has ~1700 pre-existing warnings, that is normal).
- Note: a child session's shell may leak `OPENCODE_ENABLED`/`PI_MAX_SESSIONS`, causing unrelated test failures. If you see failures in files you never touched, verify them against a clean environment (`env -u OPENCODE_ENABLED -u PI_MAX_SESSIONS`) before reporting them as regressions.

## Stop and report if

- Integration appears to require widening the gate's reachability (design violation).
- The `MultiSessionManager` cannot be reached without a circular dependency or a second instance.
- A protocol or contract change looks necessary.
- Live validation cannot be performed; report the structural result and say the live gate is unmet.

## Hand-back format (report exactly this)

1. **Status**: complete / partial / blocked.
2. **What you wired** — files, and how the talker session is created, retained and reached.
3. **RED→GREEN evidence** — the failing integration test, then passing.
4. **Gate-through-integration evidence** — propose/confirm/double-confirm/refusals, with actual outcomes.
5. **Live validation** — commands, and the worker's **received text** verbatim, compared to the operator utterance.
6. **Security check** — confirm the prompt-injection path applies, and how you verified it.
7. **Checks run** — exact commands with exit status, and how you ruled out env-leak failures.
8. **What you could NOT do** and why.
9. **Any finding that contradicts the plan** — state it; do not silently adapt.
