# Injection marking — orchestration checkpoint

**Parent session:** `01a0a978-2057-7282-9c91-3aa0f1f3df46` (bare Pi CLI, tmux)
**Board identity:** `pi-01a0a978` (declared); child registered as `inject-marking-child`
(dispatcher-sourced, parent `pi-01a0a978`).
**Child session:** `01a0aa8f-6aeb-77eb-8ae8-7fdda68ad7dc` · runtime `pi` · model
`zai/glm-5.3-flash` (verified from `/evidence`, not from the create echo) · thinking `high` ·
cwd `/root/pi-web-ui-wt-inject` · goal-armed at creation (`armed: true`) · durable retention lease
`ba0f57e8-1a3c-4973-8ed1-c9c45353be6b` to 2026-09-17T14:12Z.
**Kickoff run:** `1d884e23-ff0c-4af5-b96e-1f8f976d1642` (`mode: follow_up`, detached) — the brief
queued behind the goal's own kickoff turn, which was already running (`SESSION_BUSY`).

## Supervision rails

| Rail | Value |
|---|---|
| Wake watch | `ww_1_1789567960236` — conditions `goal_end` + `goal_state{paused}`, both `dataMatch`-filtered on the exact objective string, `once:false`, 60 s interval, max 3 wakes |
| Backstop | `deadline-961684b4-4324-4e1d-904c-cff748c92633` armed for 2026-09-16T14:37:46Z (model-free; expiry is not completion) |
| Coordination dir | `/tmp/injection-marking-coord/` — `01-questions.md`, `02-blocked.md`, `03-complete.md`, plus non-waking `status.md` |
| Handback contract | `operations/injection-marking-20260916/complete.md` in the pi-web-ui worktree, with commands, exit codes, evidence paths, commit ids in both repos |

The objective string used by the watch filter (must match exactly):

> Routine Agent OS injections are structurally marked at the emitter and excluded from the talker's
> spoken context only, with the zero-UI-regression proof (tests plus disposable-server live
> validation) recorded in operations/injection-marking-20260916/complete.md.

## Workspaces (isolated, single-writer)

- `/root/pi-web-ui-wt-inject` — branch `task/injection-marking`, base `d27e75c` (master)
- `/root/pi-enhancement-wt-inject` — branch `task/capture-marking`, base `f4ed617` (master)

Only the brief is copied into the pi-web-ui worktree so far. Neither branch is to be merged by the
child; deployment and merge are the parent's decisions.

## Verified facts at dispatch

- `/root/.pi/agent/extensions/agent-os-inject` → `/root/pi-enhancement/agent-os-inject`.
- Packet/reground/workset lanes already return `{message: {customType:'agent-os', display:false}}`
  from `before_agent_start` — already structurally marked.
- The capture lane uses `pi.sendUserMessage(..., {deliverAs:'followUp', triggerTurn:true})` →
  indistinguishable from the operator's own prompt. This is the lane to mark.
- In the pi docs, `pi.sendMessage({customType, content, display}, {triggerTurn, deliverAs})` is
  documented as *"Custom messages participate in LLM context"* → the marking keeps the behaviour.
- Pi Web UI's talker history builder already keeps only `role user|assistant`, so a marked capture
  prompt leaves the talker's history by construction; the spoken **digest decision is client-side**
  (`client/src/components/DriveMode/useAnswerReader.ts`) — that is the seam needing the marker.

## Next moves on wake

1. Reconcile: coord dir, goal status, receipts, worktree git state, watch ledger.
2. Independently re-verify the child's claims (RED/GREEN runs, live-validation evidence, diff
   confinement) — never accept its report at face value.
3. Decide on merge + deploy (drain gate from `/sessions` **and** the `voiceMode.lanes` check), then
   Telegram, then memory capture.

## Incident 14:27Z — the dispatch brief was lost, then re-delivered

- The kickoff dispatch (`runId 1d884e23`, `mode: follow_up`, accepted 14:12:28Z) **never reached the
  child**: it was queued behind the goal's own long-running turn and terminalised at 14:27:28Z as
  `TURN_STALLED` (`watchdog.reason: no_activity`, `idleTimeoutMs: 900000`) with no activity ever
  observed. A `follow_up` dispatch to a **busy, goal-driven session** has no activity of its own
  until its turn starts, so a turn longer than 15 min starves and kills the queued run.
- Recovery: re-dispatched as `mode: steer`. Delivery **succeeded** (verified: the preamble + brief
  is the session's 2nd user entry, and a new run `5f24c163` started at 14:31:22Z), but the HTTP
  response hung past 180 s on the busy session — so **an HTTP timeout on `mode: steer` does not mean
  non-delivery; verify against the session file or transcript, never the response alone.**
- Consequence to watch: because a goal-armed child is rarely idle, plain prompts will keep hitting
  `SESSION_BUSY` and `steer` responses may keep hanging. The reliable pattern is `mode: steer` +
  independent verification of the session file.
- Child's own correct design call (adopted): the capture lane needs its **own** customType
  (`agent-os-capture`), distinct from the packet lane's `agent-os`, so a marked injection cannot
  bound/silence a real work turn.

## Progress observed at 14:34Z (verified from the child's session file, not its report)

- `/root/pi-enhancement-wt-inject/agent-os-inject/index.ts` edited (twice) and `emitter.ts`
  (`EmitterHooks` gains `env`); the child reported GREEN 7/7 on its new tests and moved on to the
  full extension suite. This is the Phase A (emitter) work in progress.
- No commits yet in either worktree; `/tmp/injection-marking-coord/` still empty (expected).
- Child goal status `running` (`runs: 0`, `maxRuns: 4x`); session `running`, lastActivity 14:34:20Z.

## Parent review at 15:19Z (independent, read-only — from the diffs, not the child's summary)

Child's own heartbeat (`/tmp/injection-marking-coord/status.md`) reports A and B complete and Phase D
(disposable live validation) starting. Commit ids:

- `/root/pi-enhancement-wt-inject` `5c67c9d` — `feat(inject): mark the routine capture lane structurally (agent-os-capture)`
- `/root/pi-web-ui-wt-inject` `f596f07` — `feat(talker): exclude marked Agent OS capture injections from the spoken turn only`

Diff footprint: 10 files / +460 −12 (three test files; the rest is the predicate, the turn scan, and
type-honest carry of `role:'custom'` + `customType` through the store).

**Verified by reading the code (endorsed):** the structural predicate is exactly

```ts
message.role === 'custom' && message.customType === 'agent-os-capture'
```

and the scan treats a marked injection as an **upper bound** while continuing below it — so the
operator's work between their message and the injection is still spoken, the injection-triggered
turn is not, and the packet lane's `agent-os` type (which rides *inside* the operator's turn) is
deliberately not a boundary. Other custom types cannot silence a turn. No text heuristic anywhere.

### Merge blockers / verification items I own

1. **Unrelated local-environment churn in `f596f07`.** `package.json` gains an `allowScripts` block
   naming host-specific pinned versions (esbuild/bcrypt/better-sqlite3/node-pty/protobufjs/genai)
   plus a `package-lock.json` line — this worktree's install artefact, not the feature. Must be
   dropped before merge (verify the build/tests still pass without it).
2. **"Pre-existing failure" claim to verify.** The child reports the extension suite as 429/430 with
   the single failure being a host-state check that also fails on clean base `f4ed617`. Not yet
   independently verified.
3. **Product question for the operator (not yet asked).** Because every rendered projection drops
   `role:'custom'` by construction, the routine capture prompt will stop appearing as a user bubble
   in the chat session view (it still reaches the model and still lives in the session file). That is
   a deliberate, visible change to the surface the operator asked to keep unchanged, so it needs
   their yes/no — either "it should vanish" or "render it as a subtle housekeeping line". Collect the
   child's measured before/after first, then ask one crisp question.
