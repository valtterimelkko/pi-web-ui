# Recurring-defect ledger

Stage E1 of the [orchestration-scaling plan](./plans/ORCHESTRATION-SCALING-READINESS-PLAN.md) (§6 E1): stop
the 74% of operator-reported problems that recur instead of re-fixing them one at a time. The rule:

> When a defect of a listed class recurs, or a new class appears, **add the regression test before the
> fix**, then record the class, its instances and the test paths here. A linked regression test must fail
> on the pre-fix code — that is what makes it a regression test.

Sources for the first table: the 2026-09-26 operator-reports evaluation run
(`/root/jev-session-eval/runs/piwebui-operator-reports-v3`, spec
`/root/jev-session-eval/specs/piwebui-operator-reports.toml`) and its review,
[`docs/reviews/2026-09-26-INTERNAL-API-DEEP-REVIEW.md`](./reviews/2026-09-26-INTERNAL-API-DEEP-REVIEW.md)
§4.6 (206 malfunction prompts; 74% described as recurring; severity mean 1.20 on 0–2; in-session fix rate
37%, performance lowest at 24%). The second table lists the cross-cutting mechanism classes named in
plan §6 E1. Fixes land in the lanes of the orchestration-scaling plan; the plan file stays the authority
on step status — this ledger only records classes, instances and tests.

## A. Classes from the 2026-09-26 operator-reports run

Counts are the run's `failure_kind` distribution over 206 prompts (run `report.md`); "n / 206" is the
item-level count from the run, not an estimate.

| Class | n / 206 | One-line description | Instance examples (from the run) | Plan coverage | Regression tests | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Orchestration | 58 (28%) | Parent/child orchestration malfunctions: children cut off or never started, lost lineage, polling parents, dispatch surprises | child "cut off" verdicts (24% of children, dropped as a capture artefact, contract 1.47.0 `a8864898` 2026-09-25); 149 of 322 children without `parentSessionId`; never-started runs surfacing only after 900 s | C4 dispatch preflight, C5 lineage; C2 busy follow-ups & never-started runs; C1/C3/C6 outstanding | [`server/tests/unit/internal-api/dispatch-preflight.test.ts`](../server/tests/unit/internal-api/dispatch-preflight.test.ts), [`server/tests/unit/internal-api/dispatch-preflight-routes.test.ts`](../server/tests/unit/internal-api/dispatch-preflight-routes.test.ts) (C4, 2026-09-29); [`server/tests/unit/internal-api/parent-resolver.test.ts`](../server/tests/unit/internal-api/parent-resolver.test.ts), [`server/tests/unit/internal-api/session-routes-c5-lineage.test.ts`](../server/tests/unit/internal-api/session-routes-c5-lineage.test.ts) (C5, 2026-09-29) | partly fixed — C4/C5 linked above; C2 open (see B3 below); C1/C3/C6 open |
| Voice | 38 (18%) | Voice/Drive Mode malfunctions: relay failures, arbiter and lane faults | `pi:01a0b4c2…#p4` (2026-09-18) native-voice relay; `pi:01a0a978…#p7` (2026-09-16) lane relay | outside this plan — owned by the Voice Mode corpus ([`VOICE-MODE-INDEX.md`](./VOICE-MODE-INDEX.md)) | — | open |
| Other | 29 (14%) | Reports that name no single mechanism (mixed/operator-environment) | `antigravity:03ea223e…#p7` (2026-09-17) CI + ledger housekeeping | triage per report; no single mechanism | — | open (by nature heterogeneous) |
| Performance | 28 (14%) | Unresponsiveness and slowness: heap growth, event-loop stalls, host-wide stalls | `commandcode:783d5a4e…#p1` (2026-09-02) "pi-web-ui is slow, almost non-responsive"; `pi:01a08d52…#p1` (2026-09-10) host unresponsive | A1/A2/B1/B2 shipped (retainer fixes, telemetry, heap/lag-aware admission) | [`server/tests/unit/pi/session-release-paths.test.ts`](../server/tests/unit/pi/session-release-paths.test.ts), [`server/tests/integration/pi-extension-exit-listener.test.ts`](../server/tests/integration/pi-extension-exit-listener.test.ts) (B1); [`server/tests/unit/pi/session-watcher-retention.test.ts`](../server/tests/unit/pi/session-watcher-retention.test.ts) (B1.1); [`server/tests/unit/internal-api/admission-heap-lag.test.ts`](../server/tests/unit/internal-api/admission-heap-lag.test.ts), [`server/tests/unit/internal-api/admission-disposal-routes.test.ts`](../server/tests/unit/internal-api/admission-disposal-routes.test.ts), [`server/tests/unit/internal-api/admission-lag-wiring.test.ts`](../server/tests/unit/internal-api/admission-lag-wiring.test.ts) (B2) | fixed for the diagnosed retainer/heap classes; recurrence watched via A2 telemetry and E2's final re-measure |
| Session stuck | 24 (12%) | Sessions stuck after compaction or otherwise unresponsive ("failed at compacting", silent stalls) | `pi:01a0b6d7…#p1` (2026-09-18) "This session failed at compacting"; `pi:01a0a068…#p18` (2026-09-14) "last activity 15 minutes ago doesn't sound it's actively working" | partial: restart interruption/reconciliation (B4.1) makes restarts stop silently killing stuck work; compaction-failure root cause is **not** in this plan | [`server/tests/unit/internal-api/restart-reconciliation.test.ts`](../server/tests/unit/internal-api/restart-reconciliation.test.ts), [`server/tests/unit/internal-api/drain-controller.test.ts`](../server/tests/unit/internal-api/drain-controller.test.ts) (B4/B4.1) | open — compaction-failure root cause unowned |
| Runtime-specific | 19 (9%) | Defects specific to one runtime integration (catalogue, adapters, per-runtime flags) | `pi:01a0801b…#p12` (2026-09-08) weekly-refresh test failure notice; `antigravity:1de6598c…#p6` (2026-09-09) | addressed per runtime outside this plan; Command Code single-turn limit is a plan small item | — | open |
| Lost state | 7 (3%) | Work or state lost across restarts/rescues | `pi:01a02d61…#p14` (2026-08-23) memory-state verification; `pi:019fe2d5…#p4` (2026-08-08) "what happened? will restart corrected window help?" | B4/B4.1 boot reconciliation records and replays interruptions (same tests as above) | [`server/tests/unit/internal-api/restart-reconciliation.test.ts`](../server/tests/unit/internal-api/restart-reconciliation.test.ts) | partly fixed for restart-time state; otherwise open |
| UI display | 3 (1%) | Dashboard/selector display inconsistencies | `claude:22cf96bb…#p3` (2026-09-09) quota display mismatch | none | — | open (low severity, small n) |

## B. Mechanism classes named in plan §6 E1

These are recurring *ways engineering fixes go wrong*, found during the plan's own reviews.

| Class | One-line description | Instances (date, commit) | Regression tests (fail on the pre-fix code) | Status |
| --- | --- | --- | --- | --- |
| A fix claims every path but wires one | A fix routes one of several equivalent paths through new behaviour while the other paths silently keep the old behaviour | (1) 2026-09-05, `91effe69` — the per-session reference release fixed one of three PiService dispose/unload paths; found at R1 2026-09-27, re-done per-path by B1 | [`server/tests/unit/pi/session-release-paths.test.ts`](../server/tests/unit/pi/session-release-paths.test.ts) (per-path, GC-collectable), [`server/tests/integration/pi-extension-exit-listener.test.ts`](../server/tests/integration/pi-extension-exit-listener.test.ts) (host listener count) | fixed (B1, 2026-09-29 in production) |
| | | (2) 2026-09-28, `5b4d1d51` (corrections through `7ab25c14`) — the session watcher stopped retaining state for deleted files on its unlink path only; read and churn paths were separate work (B1.1) | [`server/tests/unit/pi/session-watcher-retention.test.ts`](../server/tests/unit/pi/session-watcher-retention.test.ts), [`server/tests/unit/pi/session-watcher-coalescing.test.ts`](../server/tests/unit/pi/session-watcher-coalescing.test.ts) | fixed (B1.1) |
| | | (3) 2026-09-29, B5 (`770fec96`, tests `51b1c175`; corrections `24cd3c08`/`9507969d`) — extension `session_shutdown` had to be emitted from every dispose path, routed through one helper | [`server/tests/unit/pi/session-shutdown-emission.test.ts`](../server/tests/unit/pi/session-shutdown-emission.test.ts) (per-path emission), [`server/tests/unit/pi/session-pool-shutdown.test.ts`](../server/tests/unit/pi/session-pool-shutdown.test.ts) (pool paths, exactly-once) | fixed (B5) |
| A mechanism sees only what it meters | A mechanism observes only the work it started itself (admission-metered turns, run receipts) and is blind to equivalent work started elsewhere | 2026-09-29 — B4's drain counted admission turns and nonterminal receipts only, so a goal-engine/extension/browser turn was invisible: live-confirmed drain settling in 3 ms during an in-flight child (lane v2b); fixed by B4.1 `354e6464` (busy sessions counted via the SDK's public streaming state), correction `3e57ba0b` (browser fence, snapshot freshness, association, self-drain; contract 1.52.0) | [`server/tests/unit/internal-api/drain-controller.test.ts`](../server/tests/unit/internal-api/drain-controller.test.ts), [`server/tests/unit/internal-api/drain-routes.test.ts`](../server/tests/unit/internal-api/drain-routes.test.ts), [`server/tests/unit/internal-api/restart-reconciliation.test.ts`](../server/tests/unit/internal-api/restart-reconciliation.test.ts), [`server/tests/unit/drain-restart-scripts.test.ts`](../server/tests/unit/drain-restart-scripts.test.ts), [`server/tests/unit/websocket/prompt-boundary.test.ts`](../server/tests/unit/websocket/prompt-boundary.test.ts). Two further B4.1 test files are pending the `orch/b41` merge into the integration base (not present at this ledger's base commit — verify at merge): `server/tests/unit/pi/multi-session-manager-busy-sessions.test.ts`, `server/tests/unit/internal-api/drain-busy-source.test.ts` | fixed (B4.1 + correction 01) |
| A response is lost after the receipt is terminal | A run's terminal receipt is recorded but the client-visible response never arrives, so the caller waits on work that has already ended | 2026-09-26 — the 17.8 MB dispatch whose response never arrived (deep review §1/§5; plan §1) | — | open — C2 scope; not yet reproduced |

## Using this ledger

1. A recurring operator report that matches a class above gets its class's regression test written or
   re-run **before** the fix (plan §4: strict TDD), and the instance is appended here with its date and
   commit.
2. A new recurring pattern becomes a new row: one-line description, first instance, `open` until a fix
   with a failing-then-passing test exists.
3. "Fixed" rows keep their test paths forever: the tests are the class's tripwire. If a row's tests can
   no longer fail on the pre-fix code (e.g. the code moved), re-anchor them before removing anything.
