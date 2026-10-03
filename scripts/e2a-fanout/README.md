# E2a-4 fan-out harness

Lane E2a-4 (+E2a-2): does the B2 event-loop-lag gate latch when a parent fans
out 8–10 creates, and does it refuse the parent's own children? Then D0 under
real load on production. Evidence lane — no product code changes.

## Layout

- `lib/a2.ts` — health-metrics JSONL (A2 telemetry) parsing.
- `lib/latch.ts` — the B2 latch model (300 ms trigger / 150 ms recovery / 2
  sustained readings) replayed over a p99 series; pi-orch retry derivation
  (exit 10 = Retry-After budget exhausted; success after ≥15 s = derived retry).
- `lib/analyze.ts` — arm-A answer synthesis (latch windows, refusals inside vs
  outside windows, documented-refusal-shape check).
- `lib/settings.ts` — production admission settings parsing (unit `Environment=`
  line) + live `/capacity` gate values; the mirrored disposable-server env
  names every copied value and states its two deviations (A2 cadence 1 s;
  `PI_TOOLS_SLICE` at the lane's own anchor).
- `lib/units.ts` — systemd-run argv for the anchor/server units (all `e2a-4-*`,
  `e2a-4.slice`, MemoryMax ≤ 8G, MemorySwapMax 1G, RuntimeMaxSec).
- `lib/spawn-plan.ts` — child specs and pi-orch argv (arm A: 10+10 GLM flash
  high with `--route-limit 'zai/glm-5.3-flash=10'`; arm B: 8 GLM + 2 Luna
  `openai-codex/gpt-6-luna` max; never plain `openai`).
- `lib/hostsample.ts` — /proc/meminfo, /proc/pressure, `ps -eo pid,cgroup,args`
  parsing (the placement proof).
- `lib/agentdir.ts` — isolated agent dir: extensions + settings byte-identical
  (sha256 manifest), auth.json FILTERED to `zai` only, models.json never copied
  (it holds apiKey entries).
- `driver.ts` — smoke (`--mode smoke`: 2 children, pass-2 parallel shape only,
  2G/300 s units) and arm A (`--mode arm-a`: pass 1 = 10 sequential creates,
  pass 2 = 10 parallel; 8G server unit).
- `run-arm-b.ts` — production fan-out + D0 observation (5 s samplers: prod
  `/capacity`, service + tools-slice cgroups, host memory, CPU PSI, placement
  proof; 20-min bound; owned-sessions ledger; full cleanup). Built now, live
  only after the parent's go.

## Tests

```bash
env -u PI_MAX_SESSIONS -u OPENCODE_ENABLED NODE_ENV=test \
  npx vitest run --config scripts/e2a-fanout/vitest.config.ts
npx tsc -p scripts/e2a-fanout/tsconfig.json
npm run lint:ratchet -- --base ee660d4f
```

## Run (smoke, no stress lock needed — STRESS-GATE smoke allowance)

```bash
systemd-run --scope --quiet --collect --unit=e2a-4-smoke-driver \
  -p MemoryMax=2G -p MemorySwapMax=1G -- \
  node --import tsx scripts/e2a-fanout/driver.ts --mode smoke \
  --run-root /root/e2a-runs/a4/smoke-<ts>
```

Arm A is the same with `--mode arm-a`, a `-p MemoryMax=4G` driver scope, the
server unit at 8G/3600 s, and the stress lock taken by the driver itself.
Arm B: `node --import tsx scripts/e2a-fanout/run-arm-b.ts --run-root ...` under
an `e2a-4-arm-b-driver` scope, only in the lane's scheduled lock slot.

## Sequencing per pass

Create burst first (the thing under test), then the tiny task prompt on every
child, a bounded `wait --all`, then `cleanup` — so the route cap (10) can never
be what refuses the next pass and `PI_MAX_SESSIONS` headroom (40 on the
disposable server, a stated deviation) can never masquerade as a lag-gate
refusal.
