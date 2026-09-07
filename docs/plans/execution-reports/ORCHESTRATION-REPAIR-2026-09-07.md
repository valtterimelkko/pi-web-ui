# Orchestration repair — 7 September 2026

Status: implementation and full disposable composition verified; final broad gates,
integration and independent review pending. No production deployment by this task.
This report records evidence, not permission to restart a service or load extensions.

## Intent and scope

Make parent/child supervision robust at the existing boundaries rather than add
another scheduler: cancellable Goal Engine continuation, honest pause state,
owner/generation-safe watches, bounded local deadlines, and current operational
guidance. Capacity/admission/SSE/validation teardown repairs were a separate
programme; this work starts from its accepted `3688297` baseline and preserves it.

All implementation children used Pi through the Internal API: Sol/medium for goal
and watch work, Luna/max for the deadline core. A/B local work and C's core were
independently reviewed. Pi Web UI changes used a detached worktree; shared
extension/skill commits were parent-owned and path-limited. The parent retained
its known-good wake relay and independent backstop until candidate activation
could be separately authorised.

## Delivered source

- Pi Enhancement: `aa9346c` goal lifecycle; `078806d`/`0bbb559` local watch lifecycle;
  `44fd9dd` deadline core; `c091af3` deadline host; `c0d4df6` capability-gated CAS
  client. Earlier transport bootstrap `f5fb7d6` and real-Pi tool proof `4504185`.
- Server: `79b5167` generation preconditions and plain Pi pause reasons;
  `011b78c` malformed-body/migration correction; `9914bb2` immutable durable-cache
  rollback correction. Contract metadata moves to 1.35.0 with this report.
- Canonical skills: `e49306e`, preserving intervening capacity, steering,
  native-discovery and multi-phase guidance rather than applying a stale draft.

The [watch contract](../../INTERNAL-API.md#watch-long-horizon-validation) and
[contract changelog](../../INTERNAL-API-CONTRACT.md) are the protocol references.
The [watch-wake companion](https://github.com/valtterimelkko/pi-enhancement/tree/master/watch-wake)
is authoritative for the local tool and its activation/legacy limits.

## TDD and independent correction evidence

Parent probes were added before fixes, not merely after a child's green report:

- disposed deadline cancellation could append into an old host; a queued stale
  callback could hide a replacement timer from disposal;
- shutdown during local startup/capability discovery could allow later work to
  mutate or persist through a closed factory;
- a DELETE generation JSON body needed explicit Node HTTP framing to reach the
  server; unit-level argument inspection alone missed this;
- malformed/null chunked DELETE could become unconditional legacy deletion;
- failed legacy migration could be skipped on retry because cache already looked
  migrated;
- durable rollback could capture a mutable record after I/O rather than the
  serialized payload, or overwrite cache owned by a newer queued write.

Focused acceptance at server `9914bb2`: 14 new tests plus 113 adjacent tests and
server typecheck passed. The extension gate covers core deadlines, actual loaded
factory/tools, Unix transport, generation-aware client behaviour, existing watch
regressions and persistent real Pi tool execution. Source/store parity remains a
separate activation check; accepted source differing from an undeployed mirror
is not permission to deploy merely to make that test green.

## Full disposable real-runtime composition

The parent executed a real Pi Web UI server and three persistent Pi AgentSessions
with deterministic **local provider responses**. This tests real runtime/protocol
behaviour, not external model judgement, and makes no subscription calls for the
fixture. The final scenario passed at server `9914bb2` / extension `c0d4df6`:

1. Parent writes a useful artefact, registers two child watches and a deadline,
   then deliberately pauses its goal.
2. A child's question/pause wakes the parent without auto-resuming its goal or
   spending paused goal turns.
3. Watch replacement changes generation; stale server preconditions and an old
   local cancellation handle cannot delete the replacement.
4. An isolated API restart preserves generation/firings as detached history,
   plus the parent's paused goal and local deadline.
5. Actual Pi compaction completes while the parent remains paused.
6. Both children achieve and produce artefacts; **two individually matched**
   registrations each consume a firing. No vacuous empty-list assertion.
7. Explicit parent resume completes the goal and cancels its current watches
   and deadline.

The last proof records compaction input of 1,336 tokens, source commits, per-child
watch witnesses and actual process environments. Both owned server groups were
verified gone by the repaired stopper and independently checked again; temporary
fixture directories and dependency links were removed. No production validation.

Harness corrections were kept separate from product defects: the driver itself
needed DELETE Content-Length, and private SDK settings required
`PI_CODING_AGENT_DIR` **as well as** server `PI_AGENT_DIR`. Goal home, ownership
leases and browser preferences were private too; actual process environment was
checked rather than inferred from requested options.

Private bounded evidence/checkpoint: `orchestration-repair-20260907` under the
operator's Pi Web UI operations directory, especially `parent/ACCEPTANCE.md`,
`parent/composition-result.json`, the RED/GREEN logs and per-child frozen reports.
Raw sessions, runtime state, credentials and fixture artefacts are not committed.

## Limits and remaining release gates

- Legacy clients can omit preconditions; their operations remain non-CAS.
  Conditional operations are atomic inside one server, not distributed consensus.
- A local deadline cannot rescue a blocked event loop/dead parent. Channel
  acceptance is not processing; a crash before persistence can replay a wake.
- Reusing a child goal can emit an old-goal clear during start. Operational
  guidance filters goal identity and retains a recovery backstop; a first firing
  is never acceptance.
- No extra orchestration daemon/job store was added: existing goals, watches,
  deadlines, receipts and a checkpoint provide the needed mechanical surface.
- Final broad gates and a fresh read-only Sol/medium integrated review remain
  pending. The child's initial full server run reported six environment-sensitive
  admission/OpenCode failures; parent must resolve their gate disposition, not
  silently count them as green.
- Production extension activation and service deployment remain separately
  permission-gated. A source commit, copied file or passing fixture does not
  prove that an already-running host loaded the new code.
