# Heap soak-test harness

Answers one question about production (`pi-web-ui.service`, one Node process,
`NODE_OPTIONS=--max-old-space-size=4096`): **after a forced full GC, does V8
heapUsed grow over 24h under production-like load, and if so, what retains
it?** heapUsed alone is not proof of a leak — it includes uncollected garbage
— so every reading here is taken immediately after `HeapProfiler.collectGarbage`.

## Safety model

- Never touches production. All isolation is enforced in code, not just by
  convention: `server/src/live-validation/heap-soak/isolation.ts` lists the
  guarded production paths (session registry, `~/.pi/agent/{models,auth,settings}.json`,
  notification opt-ins, …) and `assertOutsideProductionPaths` refuses to run
  if the harness's own run directory or isolated agent-config copy would
  alias any of them. Gate 0 checksums those paths before and after and fails
  if anything changed.
- Runs entirely through a **disposable validation server**
  (`npm run validate:server` machinery, `scripts/validation-server.ts`),
  started as a **transient systemd unit** (`pi-web-ui-soak-server-<run-id>`)
  so it survives the launching session ending, with `Restart=no` — this
  harness's whole point is a heap that is never silently reset, so the server
  is the one thing this code refuses to ever restart itself.
- The Pi agent config the disposable server uses is an **isolated copy**:
  `scripts/heap-soak/agent-dir.ts` copies only `auth.json`, `models.json`,
  `settings.json`, `extensions/` from `~/.pi/agent` into the run directory —
  never `sessions/`, `session-memory/`, `goal-engine/`, etc. `PI_AGENT_DIR`
  and `PI_CODING_AGENT_DIR` (the one the Pi SDK actually reads) both point at
  that copy.
- The only allowed production interaction is a Telegram ping via
  `scripts/notify.sh`, every title prefixed `[soak]`.
- Artefacts live under `~/.pi-web-ui/validation/heap-soak/<run-id>/` — never
  in the repo, never in `/tmp`.

## Architecture

| Piece | File | What it does |
|---|---|---|
| Launcher | `launcher.ts` | Builds the isolated agent dir, starts the server as a transient systemd unit with `--inspect=127.0.0.1:<port>` + the production heap cap, writes `run-state.json`. |
| Inspector client | `inspector.ts` | CDP over the Node inspector: forced GC, `process.memoryUsage()`, heap snapshots, a round-trip-time lag proxy. |
| Sampler | `sampler.ts` + `csv-io.ts` | One sample = forced GC → memory reading → lag proxy → capacity/health/session-count → disk check → CSV row + heartbeat file. |
| Driver | `driver.ts` + `lanes.ts` + `wave-target.ts` | Time-boxed waves of tool-using Pi children across model lanes; see **Load model** below. |
| Circuit breaker | `circuit-breaker.ts` | Per-lane consecutive-failure breaker with cooldown; pure state machine. |
| Orphan sweep | `orphan-sweep.ts` + `orphans.ts` | Reconciles the events log's `child_created`/`child_deleted` pairs once per cycle; deletes anything still open. |
| Supervisor | `supervisor.ts` | Runs sampler + driver loops concurrently as the `pi-web-ui-soak-supervisor-<run-id>` unit (`Restart=on-failure`); on (re)start, reattaches to the recorded server PID — **never restarts the server**. |
| Report | `report.ts` (pure) + `analyze.ts` (CLI) | Least-squares post-GC slope (overall + trailing + per-phase), idle-return-to-baseline, lane stats, verdict. |
| Snapshot summary | `snapshot-parse.ts` | Minimal `.heapsnapshot` structural parser (node/edge counts, total self-size) — not a full retainer-graph analysis; compare snapshots in DevTools for that. |

## Load model (owner amendment, 2026-09-26)

Free-tier models (OpenRouter, Command Code) are congested in practice — slow
or erroring — so **neither the run nor the verdict may depend on them**:

- **Lane A is the backbone**: `zai/glm-5.3-flash`, thinking level low. The
  load target is a *count of completed children per wave* (`targetPerWave`,
  default 4). Whenever lane B (or C) fails, times out, or its circuit opens,
  lane A tops the wave up to the target. **Only the backbone lane failing
  (zero completions while the wave is under target) counts as the "all lanes
  down" anomaly** — B/C failures are logged and counted (`LaneStats`), never
  paged.
- **Lane B**: OpenRouter free models (`poolside/laguna-s-2.1:free`, fallbacks
  `nvidia/nemotron-3-super-120b-a12b:free`, `qwen/qwen3.8-27b:free`).
  Best-effort, capped at 2 concurrent children (`maxConcurrent`) so a slow
  free model can't pile up resident sessions.
- **Lane C**: disabled. Pi has no `commandcode` model provider — see
  **Lane C disabled** below.
- Every child has a **hard per-turn deadline** (`childTurnDeadlineMs`, default
  90s); a child not done by then is aborted (best-effort delete) and counted
  as a lane timeout — the wave never waits on it. Wave boundaries are
  strictly time-based (`waveMs`), independent of any straggler.
- The **verdict and slope come only from post-GC heap samples and the load
  the backbone lane actually delivered**; the report states this explicitly
  and shows B/C stats separately.

## Board-pollution fix / copied-extension isolation audit (owner amendment, 2026-09-26)

Early live runs flooded the REAL Agent OS board (`/root/agent-os/board-store`)
with ~80+ synthetic entries. Root cause: the isolated agent dir's copied
`extensions/agent-os-inject` extension spawns the real `agent-os` CLI for
every child turn (packet/vault reads, usage logging, `board heartbeat`),
and one of its writes (`recordMutationTouch`) hits the board store directly
in-process, with no subprocess at all.

**Fix (kept the extension loaded — its in-process code is part of the
realistic heap profile — made every side effect local):**

1. **`AGENT_OS_BIN`** points at `scripts/heap-soak/agent-os-stub.mjs`, a
   no-op that logs each invocation's argv+timestamp to
   `<run>/agent-os-stub.jsonl` and exits 0 with empty stdout. The extension's
   own fail-soft design (`classifyOutcome`, `callAgentEndDecision` in
   `~/.pi/agent/extensions/agent-os-inject/inject-client.ts`) already treats
   empty output as a safe no-op, never an error surfaced to the model. **No
   real `agent-os` process ever runs for a soak child.**
2. **Belt and braces**: `BOARD_STORE_DIR=<run>/board-store` and
   `AGENT_OS_INJECT_LOG=<run>/agent-os-inject.jsonl` — both env overrides the
   extension already honours, redirecting `recordMutationTouch`'s direct
   filesystem write (not routed through the CLI at all) and the journal.
3. **A fake `$HOME`** (`<run>/fake-home`) for the whole disposable server
   process. Node's `os.homedir()` reads `$HOME` first on POSIX (verified
   live), and an audit of every copied extension found several MORE
   os.homedir()-based leaks beyond agent-os-inject, none with their own
   override:
   - `memory/storage.ts`: `AGENT_DIR = path.join(os.homedir(), ".pi", "agent")` — hardcoded, no override.
   - `enhanced-plan-mode`: plans dir under `os.homedir()/.pi/plans` — hardcoded.
   - `commandcode-provider`: reads `~/.commandcode/auth.json` for the API key and a taste-learning file (read-only; moot anyway since Lane C is disabled).
   - `watch-wake`: falls back to the REAL `~/.pi-web-ui/internal-api.sock`/`internal-api-token` when its own overrides are unset — the one that could reach production most directly, so it also gets explicit overrides (`PI_WEB_UI_WATCH_WAKE_SOCKET`/`_TOKEN_FILE`, pointed at the disposable server's own socket).
   - `goal-engine`: falls back to `HOME` (has its own override `PI_WEB_UI_GOAL_HOME`, set explicitly too).
   - `compact-observability`: falls back to `os.homedir()/.pi/agent` (has `PI_COMPACTION_LOG`, set explicitly too).
   - `background-shell`: `PI_BG_TASKS_DIR` (has its own override, set explicitly too).

   The fake-`$HOME` fix and the explicit per-extension overrides are
   deliberately redundant (belt and braces): the fake home covers every
   os.homedir() call including ones not audited above by construction, while
   the explicit overrides are precise for the ones that matter most
   (board/watch-wake) and self-document what each extension actually does.
   No extension needed excluding.
4. **Production-write audit** (`prod-audit.ts` + `prod-audit-io.ts`), run in
   Gate 0, Gate 1, and (to be run at) the 24h run's end: a marker file's mtime
   at run start, then `find <roots> -newer <marker> -type f` (fast — the
   guarded roots are 726MB/~1.3GB/98MB, far too large for a Node.js recursive
   stat walk on every gate run) across `~/.pi/agent`, `~/.pi-web-ui` (excluding
   `validation/heap-soak/*`, our own artefacts), `/root/agent-os/board-store`,
   `/root/agent-os/memory-vault`. Any changed file's content is checked for
   the run id, run dir, or any child session id — content, not just mtime,
   because mtime alone isn't proof on a live shared host (see the
   session-registry.json finding below).
5. **Board check** (`board-check.ts`): `agent-os board who --json`
   (read-only), filtered to entries whose `scope.repos` references the run
   dir — run while the disposable server is still active, expecting zero.

**Existing board pollution from before this fix**: ~97 synthetic entries
(ids listed in the harness's own investigation, ids like `pi-01a0dc...`)
remain on the real board from the runs before the stub was wired in. `board
leave --id <X>` is the correct verb, but Claude Code's own safety classifier
blocked a bulk cleanup script across all ~97 as "Interfere With Workloads" —
per its own instructions, that block was respected rather than routed around
(no per-id loop, no different tool). Each entry carries `ttlMinutes: 120` and
should age out of `board who` on its own; the id list is preserved for the
operator to clean up directly if wanted, and the check above proves no
*further* entries appear once the fix is in place.

## zai quota guard (owner amendment, 2026-09-26)

The owner uses zai for other work during the soak, so lane A (which runs on
`zai/glm-5.3-flash`) must stay a polite consumer of the shared zai pool.

- **Source**: `npm --prefix /root/agent-os run -s agent-os -- provider-usage --providers zai-glm --json`
  (read-only, spends no tokens). `server/src/live-validation/heap-soak/zai-quota.ts`
  parses the `zai-glm` row's `windows` ("5h left N%"), `resets` ("5h resets
  \<ISO\>"), and the top-level `peakWindow.active` flag.
- **Polling**: every `HEAP_SOAK_QUOTA_POLL_INTERVAL_MS` (default 30s in the
  micro schedule, 10 min in the full run) via the sampler loop, **and**
  unconditionally once before every wave via the driver loop
  (`scripts/heap-soak/supervisor.ts`).
- **States** (`nextQuotaState`, hysteresis): **normal** (>50% left) →
  **throttled** (≤50%: lane A's per-wave target drops to a minimum, default 1)
  → **paused** (≤30% left, or `peakWindow.active`: lane A stops entirely —
  excluded from the wave's organic dispatch and its top-up target is 0; free
  lanes, sampling, and the Internal API client keep going). Only returns to
  **normal** at ≥60% left, or once the 5h window has reset AND the reading has
  recovered above the throttled threshold — plain hysteresis, not a single
  bouncy threshold.
- **Failure handling**: a failed poll keeps the current state (logged as an
  `anomaly` lane event); 3 consecutive failures move a `normal` state to
  `throttled` until a good reading arrives.
- **One Telegram ping per state change**, not per poll (`quota_state_change`
  lane event + a `milestone`/`blocked` ping).
- **CSV**: `quotaState`, `quotaPercentLeft`, `quotaPeakActive` columns on every
  sample row. The report (`perQuotaStateSlopes`/`quotaStateDurations` in
  `report.ts`) fits the post-GC slope independently per quota state and states
  how long the run spent in each — the heap-vs-uptime question stays
  answerable even while load is intentionally reduced.
- **Test seam**: `HEAP_SOAK_INJECT_QUOTA_SEQUENCE` (env, a JSON array of
  `ZaiQuotaReading`) substitutes the real command in `quota-poll.ts` — each
  call advances one step, holding on the last entry once exhausted. Used by
  Gate 1 to drive normal → throttled → paused → normal deterministically.

## Lane C disabled

A live `commandcode` Pi provider **does** exist — registered at runtime by
the `~/.pi/agent/extensions/commandcode-provider` Pi extension (confirmed
live: the disposable server's boot log lists `commandcode` under "Available
providers (with auth)", meaning a Command Code API key resolved on this
host). Lane C is disabled anyway, for reasons more specific than "no
provider":

1. Of the 3 free model ids named for lane C, only `poolside/laguna-s-2.1-free`
   actually resolves in the live-generated catalogue
   (`~/.pi/agent/extensions/commandcode-provider/models.ts`, 47 models).
   `stealth/space-bunny-alpha` and `ling-3.0-flash-sante:free` are **absent**
   from it — the lane can't be built as specified (with fallbacks) regardless.
2. That catalogue reports `cost: {input:0,output:0}` **uniformly for every one
   of the 47 models**, including unambiguously paid ones (Kimi-K3, GLM-5.3,
   Qwen3.8-Max, DeepSeek-v4-Pro, …) — there is no machine-checkable signal
   this harness could use to *guarantee* a 24h unattended run only ever
   dispatches the one free id and never a paid one.
3. The Command Code account has **~7% monthly credit left**. An accidental
   paid call (a future catalogue regeneration reordering ids, a routing
   quirk) is a real financial risk for a lane that is best-effort and
   non-load-bearing by design (per the owner amendment above).

Disabling is the conservative call the task explicitly allows ("if lane C
cannot work cleanly, disable it and report why"). Lane C's weight is
redistributed to A and B by `pickLane`'s normal "exclude unavailable lanes"
behaviour (any disabled lane is simply never a candidate) — see
`applyForcedBadLanes`/`enabledLanes` in `lanes.ts`.

## Commands

```
npx tsx scripts/heap-soak/cli.ts preflight                     # Gate 0
npx tsx scripts/heap-soak/cli.ts micro                         # Gate 1 (~20 min + teardown)
npx tsx scripts/heap-soak/cli.ts start [--run-id <id>]          # the real 24h run
npx tsx scripts/heap-soak/cli.ts status --run-id <id>
npx tsx scripts/heap-soak/cli.ts stop  --run-id <id>            # stop both units; run dir is kept
npx tsx scripts/heap-soak/cli.ts report --run-id <id> [--mode micro|full]
```

Artefacts for a run: `~/.pi-web-ui/validation/heap-soak/<run-id>/` —
`samples.csv`, `events.jsonl`, `run-state.json`, `snapshots/*.heapsnapshot`,
`report.md`, `report.json`, `sampler.heartbeat`.

## Test seam (Gate 1 only)

`HEAP_SOAK_FORCE_BAD_LANE=<A|B|C>` (env, read by `applyForcedBadLanes` in
`server/src/live-validation/heap-soak/lanes.ts`) forces the named lane's model
id to an invalid one so every attempt fails — used to demonstrate the
circuit-breaker + backbone-top-up behaviour end to end. It refuses to target
the backbone lane. Never set this outside an explicit Gate 1 exercise.

## Known limitations

- `eventLoopLagMsProxy` is a CDP round-trip time, **not** a measurement of lag
  inside the target process's own event loop (Node exposes no CDP method for
  that as a passive read); it is a reasonable proxy but is always labelled as
  such in the CSV column name, sampler code, and report.
- Snapshot comparison is limited to headline totals (node/edge counts, total
  self-size) per snapshot; a full first-vs-last retainer/constructor diff is
  left to DevTools' own snapshot comparison view — `report.ts` says so rather
  than fabricating one.
- Command Code (Lane C) is disabled; see above.
