# Internal API capacity repair — 7 September 2026

**Scope:** targeted execution-accounting, validation-teardown and SSE repairs.
**Deployment boundary:** source changes and disposable validation only; production restart/configuration and cleanup of pre-existing processes require separate operator permission. This does not resume the paused resource-scaling programme's Phases 8–9.

## Delivered behaviour

- Busy Pi/Claude steering retains request receipts without consuming another execution permit. Short delivery uses the existing control lane; direct steering preserves the emergency memory floor. A joined observer's cancellation, timeout or disconnect cannot abort the underlying owner's turn.
- Claude events shared between a prompt callback and joined observers reach the broker once, while request-local evidence remains available.
- The receipt lifecycle owns permit release. Known pre-dispatch rejection releases after its durable transition; uncertain failed/cancelled execution drains or retains quarantined debt. Route `finally` blocks no longer defeat that fence.
- PID refusal messages explain actual, reserved and projected tasks from the same deciding sample. No defaults, limits or structured API fields changed.
- SSE output is bounded to 4 MiB per response, including UTF-8 accounting, heartbeats and completion. A slow/oversized response closes explicitly; detached execution survives observer loss and attached owner streams retain documented cancellation semantics.
- The validation launcher creates and verifies a dedicated process group. The stopper checks identity/start time, bounds its grace period, preserves uncertain evidence and verifies group cessation. Stop evidence is written before live identity is removed; failed process inspection is not treated as an empty group. Documentation no longer recommends wrapper-only or command-pattern kills.

Canonical behaviour: [Internal API](../../INTERNAL-API.md), [live validation](../../LIVE-VALIDATION.md), [observability](../../OBSERVABILITY.md), [troubleshooting](../../TROUBLESHOOTING.md).

## RED-first evidence

| Behaviour | Observed failing baseline | Subsequent focused evidence |
|---|---|---|
| SSE bound | Four failures: stalled queue, oversized completion, slow sibling and heartbeat exceeded bounds | Existing and new helper/route tests pass; real HTTP paused-reader fixture also passes |
| Joined execution ownership | Five failures: extra permit, duplicate event, wrong abort, early release and pre-dispatch debt; additional disconnected-steer failure | Ownership and adjacent route/receipt suites pass |
| Dedicated teardown | Real `npx tsx` launcher recorded PID instead of PGID; stopper exited successfully while listener remained | Real-launcher cycles, forwarded cancellation, TERM-ignoring member, identity/refusal and repeat-stop tests pass |
| Teardown review corrections | Malformed/live tombstones falsely succeeded; invalid timeout was unbounded; exit/fallback could lose evidence | Thirty focused lifecycle/stopper/env/options tests reported and subsequently included in parent full-suite validation |
| Emergency floor | Joined steer returned 202 rather than required 503 under critical memory | New actual-route regression passes |
| PID explanation | Refusal lacked deciding arithmetic | New test passes and asserts one PID telemetry read |
| Unknown process inspection | Child exit deleted identity when process inspection failed | Real child-entry regression preserves identity |
| Stop-evidence write failure | Stopper falsely returned success and child discarded identity after a failed tombstone write | Two deterministic I/O-failure regressions pass |

No raw prompts, credentials, session dumps or machine-specific process inventories are committed. Parent-owned private logs retain the command chronology and detailed disposable evidence.

## Independent review

A separate GLM 5.3/max reviewer inspected the integrated candidate and returned **ACCEPT-WITH-LIMITS**, followed by one pointed revalidation confirming that verdict after the stop-evidence ordering fix. No critical/high finding remained.

The parent rejected a suggested last-resort permit release that would bypass the durability/drain fence. The reviewer corrected its initial claim: a transient receipt-write failure can be retried by the existing watchdog; persistent unwritability deliberately keeps permits held. Restore storage access rather than adding another reconciler or forcing false capacity release.

The reviewer also ran focused process fixtures during its first review despite a narrower no-server brief. Those were disposable fixtures, not production probes; the parent separately executed full suites and a resource-isolated real-runtime proof. The follow-up remained code-only. Review output was not used as sole completion evidence.

## Disposable real-runtime proof

The test server ran in a uniquely owned transient systemd unit, separate from production, with 6 GiB maximum memory, 4500 MiB high watermark, 1024 tasks, no swap and a bounded lifetime. Its own socket, registry, receipts, Claude configuration and browser preferences were verified isolated. Existing native Claude subscription access was reused only in the process environment; no pay-per-use Anthropic key or new native credential file was present.

- **Pi / z.ai GLM 5.3 Flash:** a steer changed the final reply during a real Bash tool interval. Before/after admission occupancy remained **1 → 1**. Both request receipts completed; the broker recorded one terminal event.
- **Claude SDK / native Sonnet subscription:** the same proof passed: **1 → 1**, redirected final output, both receipts completed and one broker terminal event.
- **Four concurrent Pi turns with a bounded test-worker burst:** a finite barrier synchronised tool execution. Two real Node test processes wrote machine-produced PID/start/end/context evidence; their overlap coincided with four active admission permits in four sampled observations. With a **128-task reservation on the disposable server only**, sampled peaks were **50 tasks**, **1,289,654,272 bytes** of service memory and **17.2 ms** for capacity reads. No memory-high/OOM/OOM-kill event increment occurred.
- All **12** recorded runtime request receipts across the initial and attested runs completed. Owned sessions were deleted without cleanup errors; final admission count returned to zero and task count to the 22-task server baseline.
- The stopper verified its group gone; the unit was collected, the server PID disappeared and the socket was closed. Only after these checks was the disposable directory removed.

This is controlled-workload evidence, **not** a guarantee that four unbounded full builds fit. The initial mixed run was supplemented with machine-produced worker/overlap evidence rather than treating a requested command or marker alone as proof of actual test-worker execution.

## Quality gates

At the first integrated gate: guides, typecheck and build passed; **3403 server + 941 client + 197 shared tests** passed. Lint reported zero errors (existing warnings remain).

Final gate after the additional stop-persistence regressions and documentation updates: **pending final run**.

A worktree-only dependency mismatch was diagnosed rather than patched around: root-hoisted Zod differed from the server workspace version. Matching workspace package links while keeping generated caches local restored canonical dependency resolution; unrelated preferences/worktree source was not changed.

## Remaining limits and operational next step

- Production still needs its separately approved build/restart and post-release checks. Contract **1.34.0** is unchanged; a contract version alone does not identify whether these fixes are deployed.
- Default reservation remains **256**. **128** is supported by the bounded disposable sample and is a candidate for a separately approved, observed rollout—not an automatic configuration change or unrestricted-concurrency promise.
- Existing old validation/process groups were not terminated. Any cleanup requires current ownership checks and operator authority.
- Browser/native-CLI execution and autonomous goal continuations are not comprehensively represented by Internal API permit counts. Ordinary Pi execution remains in-process; no worker migration or new scheduler was introduced.
- Process groups are not daemon-proof containment. The trusted validation wrapper's short PID-reuse fallback window remains a parent-accepted residual limit; resource-pressure validation uses its own stronger unit boundary. This is not a blanket operator waiver or permission to target unrelated processes.
- A single SSE event larger than the response budget closes an attached stream and may cancel its owner run; durable content remains available through the normal evidence paths. Use detached answers for disconnect-safe orchestration.
