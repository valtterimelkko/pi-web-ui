# E2a-6c crash-recovery harness

Measures what is actually lost when the disposable Pi Web UI server dies or
drains under **real goal children** doing real worktree work, and what it takes
to get them working again — wave K's entry evidence (lane E2a-6c; brief:
`/root/orch-ops/orchestration-scaling/e2/E2a-6c/brief.md`).

## Layout

| File | Role |
|---|---|
| `paths.ts` | Run-dir layout under `/root/e2a-runs/a6c/<run-id>/`, unit names `e2a-6c-*` |
| `analysis.ts` | Pure parsing/counting logic (transcript diff, duplicates, watch ledger, orphans, tables) — **TDD-covered by `analysis.test.ts`** |
| `fixture.ts` | Fixture repos: trimmed `/root/pi-orch` copy + injected `npm run build` step + `TASK.md`; one repo per child |
| `agent-dir.ts` | Isolated agent dir: real extension set as byte-identical materialised copies (goal engine + auto-compact-75 included), **zai credential only** |
| `server.ts` | `e2a-6c-tools-anchor.service` (production anchor properties, own slice) + `e2a-6c-server.service` (disposable validation server, placement ON at OUR anchor, asserted isolated) |
| `dispatch.ts` | `pi-orch` wrappers (spawn/watch/status), Internal API transcript + drain calls, /proc process snapshots |
| `driver.ts` | Arm orchestration: work phase → interruption (SIGKILL / drain-timeout) → restart → 10 min no-parent-action observation → prescribed parent action → observation → per-child evidence |
| `cli.ts` / `harness-status.ts` | Entry points |

## One-command flows

```bash
node --import tsx scripts/e2a-crash/cli.ts prepare      --run-id a6c-r1 --fixtures 6
node --import tsx scripts/e2a-crash/cli.ts start-server --run-id a6c-r1 --mode arm   # smoke|arm
PI_ORCH_PARENT=<session-id> node --import tsx scripts/e2a-crash/cli.ts smoke      --run-id a6c-r1
PI_ORCH_PARENT=<session-id> node --import tsx scripts/e2a-crash/cli.ts kill-arm   --run-id a6c-r1 --children 4
PI_ORCH_PARENT=<session-id> node --import tsx scripts/e2a-crash/cli.ts drain-arm  --run-id a6c-r1 --children 4
node --import tsx scripts/e2a-crash/cli.ts analyse --run-id a6c-r1 --arm kill
node --import tsx scripts/e2a-crash/cli.ts stop-server --run-id a6c-r1
node --import tsx scripts/e2a-crash/cli.ts status
```

Tests: `node --import tsx --test scripts/e2a-crash/analysis.test.ts` (14 tests).

## Safety properties

- All units named `e2a-6c-*` inside `e2a-6c.slice` (`MemoryMax ≤ 12G` on the
  server, `MemorySwapMax=1G`, `RuntimeMaxSec`, `OOMScoreAdjust=-500`,
  `OOMPolicy=continue`, `KillMode=control-group`); the anchor copies
  production's anchor properties (Delegate, DelegateSubgroup, OOMPolicy,
  OOMScoreAdjust=-1000, ExitType=cgroup, Restart) but lives in OUR slice.
- `assertPlacementRootIsolated()` fails the start when the resolved placement
  root is not under the e2a slice or aliases production's tools anchor.
- The server is the repo's disposable validation server entrypoint: isolated
  socket/token/dirs, J6 strip of inherited `PI_TOOLS_*`, explicit env-file
  channel for `PI_TOOLS_PLACEMENT`/`PI_TOOLS_SLICE` (+ per-run disposable
  `JWT_SECRET`/`AUTH_PASSWORD` randoms — never production values).
- Agent OS interception: `AGENT_OS_BIN` stub + PATH stub + `AGENT_OS_VAULT_ROOT`
  + fake `$HOME` (same pattern as `scripts/heap-soak/launcher.ts`).
- Notifications disabled; watch-wake socket pinned to the run's own socket.
- Fixtures are rebuilt per arm so side-effect counts never mix runs.

## Known deviation (measured, flagged to the parent)

STRESS-GATE's smoke allowance says `MemoryMax=2G`; at 2G the server's own
admission preflight refuses **every** model turn (`memory_pressure`,
emergencyMode: base RSS ≈ 0.94 GiB + 512 MiB reserved/turn leaves projected
headroom 673 MiB < the 1.6 GiB minimum — `GET /api/v1/capacity` evidence). The
smoke therefore ran at `MemoryMax=6G` — the smallest cap that admits ≤2 small
children — keeping the rest of the allowance (RuntimeMaxSec=300, ≤2 children,
no deliberate allocation or CPU burn, `e2a-*` unit). The arms run at 12 G
(where admission passes with ~10 GiB projected headroom).
