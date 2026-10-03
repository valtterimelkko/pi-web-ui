# E2a-3 harness — the four unrun D0 proofs, on production's topology (contained)

Lane E2a-3 of the orchestration-scaling E2 wave. Proves the four D0 claims nobody has
exercised yet (D0.md §11 last paragraph; plan §6 E2 R4 bullet):

1. **CPU burner on every core** → what a 16-worker burn at `CPUWeight=1` does to
   production's A2 lag (before/during/after), plus a disposable server's lag with a
   real `zai/glm-5.3-flash` child streaming, and the burn once placed through the
   child's own bash tool. Arm: `arm1-cpuburn.mjs` (+ guard flag `cpu-burner-window`).
2. **OOM victim selection** → (a) ranked `oom_score`/`oom_score_adj` readout of
   production's MainPID, anchor supervisor, a placed tool process, claude-rc, docker
   and a 3 GiB allocator in `e2a-3-oomread`; (b) a **contained** OOM inside
   `e2a-3-oomproof` (`MemoryMax=6G`, `MemorySwapMax=0`, `OOMPolicy=continue`): a -500
   allocator must survive, the 0-score one must be killed, the unit stays active.
   Arm: `arm2-oom.mjs`.
3. **`MemoryLow` eviction contrast** → inside `e2a-3-memlow` (`MemoryMax=8G`,
   `MemoryLow=4G`, `MemorySwapMax=0`), two file-backed sibling groups (1.5 GiB each),
   one protected by `memory.low` (with the ancestors' effective low), one not, plus an
   anon hog. Measure `memory.current`, `memory.stat`, `memory.events(low)` and
   re-read latency before/after. A crisp contrast or an explained null are both
   acceptable; an unexplained null is not. Arm: `arm3-memlow.mjs`.
4. **Orphans after a hard server crash** → disposable server (our topology,
   placement on in `e2a-3-tools-anchor.service`), one real GLM child running a long
   bash `sleep`, then `SIGKILL` of `e2a-3-server.service`: which tool processes
   survive, where, with which limits, for how long; what the next start's sweep does
   (D0.md §9 says it kills them — verify); child session state after restart; and a
   graceful-stop contrast. Arm: `arm4-orphans.mjs`.

## Gating (binding)

Every stress arm runs only when `e2/GUARD-LIVE` exists and under the cross-lane
stress lock, per `e2/STRESS-GATE.md` and `COMMON-BRIEF-e2.md` Host safety:

```sh
node scripts/e2a/gate.mjs --check                    # verdict + reasons
node scripts/e2a/gate.mjs --acquire --arm 2b         # gate + atomic lock in one step
node scripts/e2a/gate.mjs --release --token 'lane E2a-3'   # after the arm's units stopped; owner-checked (word-boundary match), refuses otherwise
```

Unit names are always `e2a-3-*` (host guard's stop path). Containment: every unit
carries `MemoryMax` ≤ 12G total per arm, `MemorySwapMax` ≤ 1G (0 where the proof
needs it) and a `RuntimeMaxSec`. Allocation code self-caps at 10 GiB. One memory
arm at a time.

## Order (lane brief)

`2b, 3, 4, 1` after GUARD-LIVE; `2a` (read-only ranking) anytime. Smokes stay inside
STRESS-GATE's allowance: `MemoryMax=2G`, `RuntimeMaxSec=300`, ≤ 2 model children, no
deliberate allocation or CPU burn.

## Disposable topology (lib/topology.mjs, lib/disposable-server.mjs)

`e2a-3.slice` (12G/1G swap) → `e2a-3-tools-anchor.service` (production's anchor
pattern: `Delegate=cpu memory pids`, `DelegateSubgroup=supervisor`,
`OOMPolicy=continue`, `ExitType=cgroup`, `OOMScoreAdjust=-1000`, ExecStart
re-enables its subtree controllers) + `e2a-3-server.service` (the worktree build via
the disposable validation-server entrypoint, `--compiled`, isolated socket/token,
fake HOME, isolated agent dir, placement env via `--env-file` — the wrapper strips
inherited `PI_TOOLS_*` unconditionally). Boot asserts the resolved tools root is
ours, never production's.

## Tests

```sh
node --test scripts/e2a/tests/*.test.mjs
```

Pure logic only (gate evaluation, metric windows, OOM ranking, memory parsing,
orphan reconciliation, topology argv builders, agent-dir credential filter).
