# H2 — Pi mid-run input routing (isolated worktree)

You are a child worker. Complete this end-to-end, then report back. Do not ask the operator anything — if you hit a genuine blocker, stop and report it.

## Why this exists

Pi Web UI delivers operator input to a Pi session by calling the SDK's agent methods **directly**:

- `MultiSessionManager.prompt()` → `agentSession.prompt(message)`
- `MultiSessionManager.steer()` → `agentSession.steer(message)`, called from `connection.ts::handleSteer`

The Pi extension **`input` event is emitted only from `AgentSession.prompt()`** via the extension runner. Calling `agentSession.steer()` directly bypasses it. The consequence: an extension can never observe operator input delivered through Pi Web UI, so the voice talker's relay cannot reach a busy session through the extension seam, and any future extension is blind to Web UI input.

Your job is the narrow, careful fix: route mid-run operator input through a path that **emits the input event**, without changing delivery semantics for existing callers.

## Outcome

Mid-run operator input to a Pi session passes through a code path that emits the extension `input` event, so an extension can observe it — **while every existing caller's behaviour is preserved**.

## The load-bearing constraint

`AgentSession.prompt()` already accepts `streamingBehavior: "steer" | "followUp"` and emits the input event before queueing. So the fix is likely: at the steer call site, prefer a call shape that emits the event rather than one that bypasses it.

Verify this yourself against the installed SDK source before choosing an approach. **Do not assume** — read `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js` and confirm where `emitInput` is called and what `prompt()` requires when streaming.

## Method — RED first, and this is the riskiest change in the programme

1. **Write the failing regression test FIRST.** Prove that today, an extension's `input` handler does **not** fire for a Web UI-delivered steer. That is the RED evidence for the defect.
2. **Pin existing behaviour before changing anything.** Add tests that assert current delivery semantics for every existing caller: a normal prompt starts a turn; a steer joins mid-run; a follow-up queues; each produces the same observable outcome as today. These must pass before and after your change.
3. Implement the minimum change at the steer call site.
4. **Re-run everything**: your new input-event test must now pass, and every pinned behaviour test must still pass.
5. **Live-validate** against a real Pi session on a **disposable validation server** (`npm run validate:server` in this repo) — never production. Prove two things:
   - an operator steer delivered while a session is busy **does** now reach an extension's `input` handler (the new behaviour);
   - the session still behaves exactly as before from the operator's perspective (the message lands, the turn continues or finishes correctly).
6. If a live check cannot observe the extension event, report that honestly rather than claiming success — the structural proof (test) and the live proof are separate claims.

## Scope and paths

You are in an **isolated worktree**: `/root/pi-web-ui-wt-h2`, branch `talker/pi-input-routing`. `node_modules` is symlinked from the main tree. Do not edit anything outside this worktree.

**Owned:**
- `server/src/pi/multi-session-manager.ts`
- `server/src/websocket/connection.ts`
- Their tests, plus any new test file for the input-event behaviour.

**Do not touch:** `server/src/talker/` — that is H1, a parallel child working in the main tree. Do not touch Drive Mode client code, the WebSocket message protocol, or the Internal API contract. If you believe a protocol change is required, **stop and report** — it is out of scope.

**Do not commit or push.** Leave the work in the worktree; the parent will review and merge.

## Constraints

- **No behaviour change for existing callers.** This path is used by every Pi session. A regression here is the worst outcome of this programme.
- **No new public API** unless strictly required; prefer the smallest possible change at the existing call site.
- Preserve the existing error handling and the `blockIfPromptInjection` guard on the steer path.
- Preserve the busy-check semantics in `prompt()` (`already busy` error) — do not let a new code path silently start a second concurrent turn.

## Environment

- Worktree: `/root/pi-web-ui-wt-h2` (branch `talker/pi-input-routing`, based on `da420f5`).
- Checks: `npm run typecheck`, `npm run lint`, `npm test` — at minimum the suites covering `multi-session-manager`, websocket connection and session lifecycle. Say exactly what you ran.
- Validation server: `npm run validate:server`, then drive a real Pi session; see `docs/LIVE-VALIDATION.md`.
- Internal API: `/root/.pi-web-ui/internal-api.sock`, token `/root/.pi-web-ui/internal-api-token`.
- Model for any probe: `zai/glm-5.3-flash` (thinking `high`) is fine for a busy-session probe.

## Stop and report if

- The change cannot be made without altering observable delivery semantics for existing callers.
- There is no SDK call shape that both emits the input event and preserves steer semantics.
- You conclude a WebSocket protocol or Internal API contract change is genuinely required.
- A live validation cannot be performed in the time available (report the structural result and say the live gate is unmet).

## Hand-back format (report exactly this)

1. **Status**: complete / partial / blocked.
2. **The defect, proven** — your RED test and its output, showing the input event did not fire before the change.
3. **The change** — the exact call site and diff shape, and why this preserves semantics.
4. **Pinned-behaviour evidence** — which tests prove existing callers are unchanged, and their result before and after.
5. **Live validation** — commands run, what you observed for both claims (extension sees the event; operator-visible behaviour unchanged). Raw output, not a summary.
6. **Checks run** — exact commands with exit status.
7. **What you could NOT do** and why.
8. **Risk assessment** — your honest view of what could still break in production, and what you would watch.
