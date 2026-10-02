# Observability

> Canonical reference for Pi Web UI server logging, diagnostics, error codes, and
> the fast test loop. Read this instead of rediscovering log format, levels,
> namespaces, correlation IDs, or the diagnostics endpoint each time.
>
> Linked from [`../AGENTS.md`](../AGENTS.md) and [`MAINTAINER-INDEX.md`](./MAINTAINER-INDEX.md).

## TL;DR for an agent debugging something

1. **Where are the logs?** In production: `journalctl -u pi-web-ui -f`. In a
   disposable validation server: its stdout (capture when you boot it). You can
   also pull recent logs over the API — see [Diagnostics](#diagnostics).
2. **Too noisy / too quiet?** Set `LOG_LEVEL=error|warn|info|debug` and/or
   `DEBUG=<component>[,<component>…]` (e.g. `DEBUG=ClaudeService,opencode*`).
3. **One prompt's whole story:** accepted turns carry `requestId`, `runId`,
   `sessionId`, runtime, and execution-instance context where available. Filter
   diagnostics by `runId` for the durable turn identity; use `requestId` for the
   originating HTTP request.
4. **What went wrong on the wire?** Every Internal API error carries a stable
   `code`; the actionable ones also carry a `hint`.
5. **Fast test loop:** see [Fast test loop](./TROUBLESHOOTING.md#fast-test-loop-for-agents).

---

## Logging

Server runtime code uses one central logger (`server/src/logging/logger.ts`),
not `console.*`. Get a logger per component:

```ts
import { createLogger } from './logging/logger.js';
const logger = createLogger('ClaudeService');
logger.info('Loaded N models');
logger.errorObject('failed to list models', err, { sessionId }); // message + stack + context
```

The `no-console` ESLint rule is **error** for `server/src/**`, so ad-hoc
`console.*` sprawl cannot regrow. Worker crash evidence also flows through the
central structured logger and the aggregate diagnostics snapshot.

### Levels (`LOG_LEVEL`)

Env: `LOG_LEVEL=error|warn|info|debug` (default `info`), parsed in
`server/src/config.ts`.

| Level | Meaning |
|---|---|
| `error` | Failures needing attention |
| `warn` | Recoverable anomalies |
| `info` | Lifecycle milestones (default) |
| `debug` | Per-operation detail (request logs, etc.) |

### Component namespaces (`DEBUG`)

Env: `DEBUG=<component>[,<component>…]`, comma-separated, `*` wildcard,
case-insensitive (default: off). When set, unmatched **info/debug** records are
suppressed, while warnings and errors always remain visible. Combine with
`LOG_LEVEL=debug` for full detail on one subsystem.

```bash
DEBUG=ClaudeService            # only ClaudeService
DEBUG=claude*                  # all Claude components (ClaudeService, ClaudeChannel*, ClaudeSdkService, …)
DEBUG=claude,opencode* LOG_LEVEL=debug
```

Canonical components (the names actually used in code): `AntigravityService`,
`Auth`, `ClaudeChannel`, `ClaudeChannelService`, `ClaudeEventNormalizer`,
`ClaudeProfiles`, `ClaudeProcessPool`, `ClaudeSdkService`, `ClaudeService`,
`ClientVoice`, `Config`, `Connection`/`WebUI`, `EventForwarder`, `Extensions`, `Fatal`,
`Files`, `Health`, `InternalAPI`, `JSONRPCToRPCConverter`, `MergeCoordinator`,
`Models`, `MultiSessionManager`, `NotificationManager`, `NotificationStore`,
`NotificationsRoutes`, `OpenCodeProcessManager`, `OpenCodeService`,
`OpenCodeSSE`, `PiService`, `Preferences`, `RPCProtocolBridge`, `Server`,
`SessionCleanup`, `SessionOrchestrator`, `SessionPool`, `SessionRegistry`,
`SessionRPCClient`, `SessionWatcher`, `SessionWebSocket`, `Stt`, `TerminalManager`,
`Transfer`, `Tts`, `Usage`, `VoiceLive`, `VoiceMode`, `Worktrees`.

Voice Mode uses three of these: **`VoiceLive`** is the native live path (lane
lifecycle, the structured `voice-kernel` evidence lines, the engine-selection
record at mount construction, and the bridge's own diagnostics), **`VoiceMode`**
is the talker/harness turn records, and **`ClientVoice`** is the uploaded
client error reporter. The two server components are separate on purpose — a
live-lane problem is separable from the WebSocket traffic that shares `WebUI`:

```bash
DEBUG=VoiceLive LOG_LEVEL=debug     # only the native live path
DEBUG=VoiceMode                     # only the talker turn records
# …or via the diagnostics route: ?component=VoiceLive / ?component=VoiceMode
```

### Format (`LOG_FORMAT`)

Env: `LOG_FORMAT=pretty|json` (default `pretty`).

- **pretty** (default, human): `[Component] message [req=… sid=… rt=…]`. Preserves
  the existing `[Tag]` convention; existing `grep` patterns still work.
- **json** (machine): one object per line with stable keys:
  `ts, level, component, msg` + optional `requestId, sessionId, runtime, error`
  (+ any bound context). Cheapest for agents/tools to filter.

Error logs always include `error.message` + `error.stack` + context (use
`logger.errorObject(message, err, context)`).

### Correlation IDs

Every accepted prompt gets a durable `runId`; its in-process lifecycle also
carries the originating `requestId`, `sessionId`, runtime, and resolved
`executionInstanceId` where known. These are stamped via `AsyncLocalStorage`
(`server/src/logging/correlation.ts`). Batch prompts get child contexts rather
than sharing one ambiguous correlation identity.

```bash
# Send a prompt at json+debug, then reconstruct its whole lifecycle by id:
LOG_FORMAT=json LOG_LEVEL=debug npm run validate:server -- --dir /tmp/v …
grep '"requestId":"req_…' /tmp/v-server.log
```

> **Caveat:** the correlation context propagates across `await` boundaries
> **in-process**. The Pi Coding Agent runs its model turn in a **worker process**,
> so Pi's in-turn worker logs do not carry the `requestId` (the in-process
> request/dispatch/complete logs do). Claude/OpenCode/Antigravity/Command Code turns are more
> in-process, so their adapter logs correlate more fully.

## Diagnostics

The logger's ordinary sink and diagnostics tap share the same bounded safety
projection: at most 8 KiB per record, 256 fields and six nested levels. Oversized
strings are dropped whole rather than partially retaining a credential. Known
credential/payload fields and token patterns are scrubbed; this is not a guarantee
that arbitrary prose cannot contain sensitive information. Do not log payloads.

The process-local ring retains at most 1,000 records / 2 MiB. `summary.retention`
reports its process identity/start time, retained bytes/records, limits, window
timestamps and eviction/truncation/insertion/tap-failure counters. These global
window counters are distinct from the filtered summary. Read results are detached
copies. Counters are not durable history across restart.

`operational.pipeline.eventLoopLagWindow` retains at most 120 samples from the
existing 500 ms monitor over 60 seconds. It reports `sampleCount`, `maxMs`,
nearest-rank `p95Ms`, `windowMs`, `maxSamples`, and the metrics owner's `resetAt`.
Samples at least 60 seconds old expire; a new owner starts empty. When count is
zero, zero-valued aggregates are placeholders, not proof of a lag-free interval.
This is process-local history, not durable telemetry. Latest-lag reporting and
existing shed/admission thresholds are unchanged; no extra sampler is started.

`operational.pipeline.brokerReplay*` gauges expose aggregate broker replay
retention: `brokerReplayRetainedBytes` (serialised retained bytes across all
sessions, bounded by a 32 MiB default global budget), `brokerReplayKeys`
(retained session keys) and `brokerReplayEvictedEventsTotal`. Cold
(subscriber-less) sessions are capped at 1,000 retained bookkeeping keys;
their replay history may be evicted whole, and the affected sessions' event
snapshot responses then carry `replayStatus: { incomplete: true }` so an
evicted history is never mistaken for "nothing happened". Live terminal and
control delivery is never suppressed to protect replay.

Responses are capped at 1 MiB; optional `responseTruncation` states how many
oldest log/error array entries were omitted and the byte limit. This does not
remove retained entries or change matching summary counts. If required registry
or visibility evidence is unavailable, the route returns **503
`DIAGNOSTIC_SOURCE_UNAVAILABLE`** with source status, not healthy empty counts.
Preserve corrupt registry bytes, investigate/repair the source, then retry; a
successful subsequent read can recover without replacing the registry manager.

Self-service recent logs over the Internal API (no `journalctl` needed). A
bounded in-memory ring buffer captures recent structured log lines, secret-scrubbed
on push (tokens/passwords/`Bearer …`/`sk-…`/sensitive keys → `[REDACTED]`;
`requestId`/`sessionId` preserved). See [`INTERNAL-API.md`](./INTERNAL-API.md).

```
GET /api/v1/diagnostics                       # logs/errors/summary + aggregate operational snapshot
GET /api/v1/diagnostics?limit=200&minLevel=warn
GET /api/v1/diagnostics?runId=<id>&runtime=pi&component=SessionWorker&since=<ISO>
GET /api/v1/sessions/:sessionId/diagnostics   # same filters, scoped to one session
```

Authed like every other internal-api route (only `/health` is exempt). The
`operational` snapshot is bounded and process-local: low-cardinality turn and
notification outcomes, latency buckets, adapter/subscriber/watch/worker anomaly
counts, aggregate session counts, and path-free worker crash totals. Contract
1.31.0 also exposes `pipeline.brokerPublishBytesTotal`,
`brokerEventsTruncatedTotal`, `brokerEventsCoalescedTotal`, and the current
`eventLoopLagMs`. The `InternalApiEventBroker` logs one warning per affected
session when its payload budget first truncates an event; `EventLoopShed` logs
transitions into ids-only overload shedding and back to normal delivery.
Shed mode is armed by sustained event-loop lag **or** heap pressure (the
MultiSessionManager memory check arms it at ≥ 80% of the real V8
`heap_size_limit` and disarms below 70%), and the same signal degrades browser
`message_update` sends to ids-only. The WS bounded-send path adds
`pipeline.wsUpdatesQueuedTotal` (updates queued under socket backpressure),
`pipeline.wsSlowClientsClosedTotal` (sockets closed 1013 as stuck consumers),
and `pipeline.memoryShedActive`. Browser slow-consumer closures are also
logged as `[Connection] Closed slow WebSocket consumer …` warnings.
The SSE helper separately logs `[SSEStream] Closing SSE connection: …` with
pending-byte and 4 MiB limit values when a slow response exceeds its outgoing
budget (or serialisation/write fails). No payload is logged. This is a transport
closure, not proof that a detached agent failed; attached streaming prompts
retain their documented disconnect/cancellation semantics.

The snapshot contains no prompts, transcripts, tool payloads, models, session
paths, tokens, or credentials. It is an operational snapshot, not a durable historical database;
the ring, counters, and latest runtime-health failures reset when the server
process restarts.

Diagnostics query selectors are `sessionId`, `requestId`, `runId`, `runtime`,
`component`, `since` (ISO timestamp), `minLevel`, and bounded `limit`. Use the
resolved internal session id from `npm run debug:where` for
`/sessions/:id/diagnostics`; use `runId` for one prompt's durable dispatch
identity and `requestId` for the originating HTTP request. The session-scoped
route narrows records but still returns the same process-level operational
snapshot.

On the disposable `validationMode` server only, Phase 7 shadow records add
bounded `phase7PolicyVersion`, `phase7Profile`, `phase7ReasonCodes`,
`phase7Affinity`, `phase7AffinitySessionId`, and `phase7ResourceIdentity` fields
to Pi Internal API prompt diagnostics. Normal development/production servers do
not enable this observation. The resource identity remains
`shared-service`/`pi-control-process` with `sessionScoped:false`; these fields do
not claim a per-session cgroup or contained worker and never include prompt
text.

For the shortest troubleshooting path, use the additive session evidence bundle:

```text
GET /api/v1/sessions/:id/evidence
GET /api/v1/sessions/:id/evidence?expand=diagnostics,transcript,screen,runs&limit=20
```

It resolves internal, path, and runtime-native identifiers in one read and
combines canonical metadata, exact runtime locators, one bounded process-local
log slice, and a durable run-receipt summary. The default omits prompt text,
raw transcript/JSONL bodies, tool payloads, and the global operational snapshot.
`expand=` is explicit and bounded. Diagnostics reset on restart; receipts and
runtime-owned files are the durable fallback.


## Runtime health

`GET /api/v1/health` keeps the legacy `runtimes` availability strings for
compatibility and adds `runtimeHealth` entries. Each entry reports `enabled`,
`available`, the selected backend, `checkStatus` (`ok`, `unavailable`, `error`,
or `disabled`), `checkedAt`, bounded `checkDurationMs`, and the latest scrubbed
failure when one exists. The top-level health status is primarily a
server/Pi-liveness compatibility signal; use `runtimeHealth` or
`GET /api/v1/capabilities` when deciding whether a specific optional runtime is
usable.

## Heap and lag telemetry (A2)

The server samples its own heap and event-loop health on a fixed cadence, appends
one bounded JSONL line per sample, and raises an operator alert with hysteresis
when heap or lag crosses a threshold. Added by A2 of the
[Orchestration Scaling Readiness Plan](./plans/ORCHESTRATION-SCALING-READINESS-PLAN.md)
so heap can be *seen* in production instead of reconstructed from the journal,
and so admission work (B2) has one reusable reading of the limits that actually
bind (`heap_size_limit`, not the committed heap).

Implementation: `server/src/observability/health-readings.ts` (one reading),
`health-metrics-file.ts` (bounded rotating sink), `health-alerts.ts` (hysteresis
latches), `health-telemetry-config.ts` (env resolution + alert delivery),
`health-telemetry.ts` (the sampler). The lag window comes from
`server/src/internal-api/event-loop-shed.ts` (`readEventLoopLagWindow()`, a
read-only 60 s ring; reading it never starts a monitor).

### The metrics file

The default location is `~/.pi-web-ui/metrics/health-metrics.jsonl`
(`OBSERVABILITY_METRICS_DIR` to move it). One line per sample, newest last:

| Field | Meaning |
|---|---|
| `at`, `atMs`, `uptimeSec` | When the sample was taken; process uptime (the leak axis). |
| `heapUsedBytes`, `heapTotalBytes` | `process.memoryUsage()`. |
| `heapLimitBytes`, `heapFraction` | The real V8 `heap_size_limit` and `heapUsed / limit` — the ratio the heap alert and B2 admission use. |
| `rssBytes`, `externalBytes` | Process RSS and external (buffer/native) memory. |
| `cpuPercentOfCore` | Process CPU (user + system, `process.cpuUsage()` deltas) over the interval, as a percentage of one core. `null` on the first sample (no interval yet). |
| `mainThreadCpuPercentOfCore` | Main-thread (event-loop) CPU over the same interval, percentage of one core. `null` on the first sample or when unmeasurable. |
| `mainThreadCpuSource` | Where `mainThreadCpuPercentOfCore` came from: `proc-thread-self` (read from Linux `/proc/self/task/<pid>/stat`, the main thread's own counters), `process-cpu` (the labelled process-wide fallback used when `/proc` is unavailable), or `unavailable`. |
| `lagP50Ms`, `lagP99Ms`, `lagMaxMs`, `lagWindowMs`, `lagSampleCount` | Event-loop lag percentiles over the last 60 s at the 500 ms shed-monitor cadence. |
| `activeTurns`, `activeTurnsByClass` | Active turns, by runtime label by default; by admission class (P0–P3) when admission registers its snapshot. `{}` means no source could see them — never a misleading zero per class. |
| `admissionActiveTurns`, `admissionTurnsByClass`, `admissionTurnsByRuntime` | J3: admission's own live counts (total, per class P0–P3, per runtime), recorded **beside** — never instead of — the operational counts above. The fields are absent (not zero) when admission is not wired, so unwired rows grow by zero bytes; wired rows grow by +170 bytes at most (measured over the retained live samples, compact `JSON.stringify` serialisation). |
| `admissionOldestActiveRunStartedAt` | J3: what admission exposes of the oldest still-active run's start (receipt-derived, overlaid by the `/capacity` route, usually absent — and always absent for a leaked permit, which holds no receipt). Absent when unexposed. |
| `residentSessions` | Sessions loaded in the Pi `MultiSessionManager`, registered by that manager. `null` when unmeasured. |
| `registryEntries` | Session-registry entries. `null` when no unique registry instance exists. |

### CPU in the sample

Heap and lag say how much room the process has and how late the loop is; the
CPU fields say how busy the one thread they share is. The Pi agents run in
process on the main event loop, so `mainThreadCpuPercentOfCore` is the quantity
to watch for “is the event loop CPU-bound right now?”. It is read on Linux from
`/proc/self/task/<pid>/stat` (a thread's TID equals the process pid for the main
thread, and the sampler runs on the main thread; the `stat` fields are located
from the last `)` because the process name may contain spaces). Where that is
unavailable — a non-Linux host, a restricted `/proc` — the process-wide figure
is reported instead and `mainThreadCpuSource` is `process-cpu`, because process
CPU can exceed main-thread CPU when worker threads exist. Both percentages are
computed from deltas against the previous sample against the same clock as the
reading, so the two are directly comparable; neither is client-visible (the
metrics file is a host file, not an Internal API field).

Rotation is size-bounded, not count-only: the current file is
`health-metrics.jsonl`, older generations are `health-metrics.1.jsonl`,
`.2.jsonl`, … Keeping at most `OBSERVABILITY_METRICS_MAX_FILES` generations, each
at most `OBSERVABILITY_METRICS_MAX_FILE_BYTES`, bounds the directory at roughly
`maxFiles × maxFileBytes` (a single line longer than the byte bound is never
split, so a JSONL line always parses).

```bash
# The last hour of heap and lag, one line per sample:
tail -n 120 ~/.pi-web-ui/metrics/health-metrics.jsonl | \
  jq -c '{at, heapFraction, lagP99Ms, residentSessions, activeTurns}'

# Heap ceiling actually in force (compare with --max-old-space-size):
tail -n 1 ~/.pi-web-ui/metrics/health-metrics.jsonl | jq '.heapLimitBytes'
```

`validate:server` sets `PI_WEB_UI_VALIDATION_MODE=true`, which moves the default
under the run directory (`<validation dir>/metrics`). An explicit
`OBSERVABILITY_METRICS_DIR` is honoured **only if it canonicalises inside that
run directory**; anything else — the real production metrics directory, any path
outside the run directory, or a path that reaches outside through a symlink —
**disables the sampler** and writes a loud line naming the refused path:

```
[HealthTelemetry] disabled: refusing to write /root/.pi-web-ui/metrics from a validation server: it is the production metrics path
[HealthTelemetry] disabled: refusing to write /srv/other/metrics from a validation server: it is outside the validation run directory (/root/a2-validation/run5/validation)
```

The production boundary is **not** `HOME`: a disposable child is given a fake
`HOME`, so `os.homedir()` would call the real production path “not production”.
The real production directory is derived from the account database
(`os.userInfo().homedir`), and containment is decided on resolved
(realpath-followed) paths.

### Alerts with hysteresis

Two independent latches, evaluated against the same reading:

| Alert | Arms when | Clears when |
|---|---|---|
| `heap_pressure` | `heapFraction >= OBSERVABILITY_HEALTH_ALERT_HEAP_FRACTION` (default `0.85` of `heap_size_limit`) | `heapFraction <= OBSERVABILITY_HEALTH_ALERT_HEAP_RECOVER_FRACTION` (default `0.75`) |
| `event_loop_lag` | `lagP99Ms >= OBSERVABILITY_HEALTH_ALERT_LAG_P99_MS` (default `500`) | `lagP99Ms <= OBSERVABILITY_HEALTH_ALERT_LAG_RECOVER_MS` (default `200`) |
| `turn_count_mismatch` (J3) | admission has held **more** active turns than the runtime telemetry for `OBSERVABILITY_HEALTH_ALERT_TURN_MISMATCH_READINGS` consecutive readings (default `3`) | agreement has held for `OBSERVABILITY_HEALTH_ALERT_TURN_MISMATCH_RECOVERY_READINGS` consecutive readings (default `2`) |

The third row is the J3 leak detector (plan §6 J3 — a detector, not a fix). On
2026-10-02 production's `/capacity` reported `activeTurns: 1` (class P2) for
about 19 minutes while no session was busy, the drain counted 0 turns and 0
nonterminal runs, and this metrics file's `activeTurns` read 0 throughout — a
permit that is never released shrinks capacity silently until a restart. The
sampler now records admission's counts (via `admissionCounts`, wired from the
Internal API server through the read-only `activeCounts()` getter — correction
02: `snapshot()` evaluates pressure and would move admission's heap latch)
beside the operational counts. Each reading is in one of three states: **leak**
(admission above the telemetry, by the total or any per-runtime count),
**equal**, or **reverse** (telemetry above admission, no leak anywhere).

The detector is **one-sided**: leak readings arm the alert and only equal
readings count towards recovery. Reverse readings — legitimate, because
receipts can be joined to another turn's permit (a steer onto a busy session
holds no permit of its own) — neither open nor close an incident, and a single
leak reading is a turn-boundary race that breaks the arm run. Three consecutive
leak readings (~90 s at the 30 s cadence) cannot be a turn-boundary race
(acquire → receipt-record and terminalise → release are one async hop, at most
one reading) nor the §11 quarantine fence (a cancel/fail with unconfirmed
cessation holds the lease at most 30 s past terminalise). A leaked permit
persists until a restart, so it pages. The alert message names admission's
non-zero classes, the per-runtime admission-vs-telemetry detail and — when
exposed — the oldest receipt-derived run's start (absent in exactly the leak
case). Admission behaviour is unchanged; the fix waits for an attributed
instance (owner rule: no fix without a reproduction).

Semantics: **one raw transition per crossing** (an `alert` when the high water
mark is crossed, a `recovery` when the low water mark is cleared), never one
transition per sample. Any value between the two thresholds is a dead band that
changes nothing, which is what stops a reading that oscillates around the
trigger from flapping. Because a recovery must be earned, a latch always has two
thresholds and a start-up validation refuses a band whose low water mark is not
below its high water mark.

Every raw transition is journaled, and every reading is written to the metrics
file. **Operator delivery is incident-grouped** (L1): the event-loop latch may
cross six times in twenty minutes while one host-wide stall unfolds, and the
operator gets one message when the incident opens and one when it closes.

### Incident grouping

One incident per kind (`heap_pressure`, `event_loop_lag`, `turn_count_mismatch`), with independent
state, so an open lag incident cannot silence a heap alert:

- **Open.** An incident opens after `OBSERVABILITY_HEALTH_ALERT_DEBOUNCE_READINGS`
  consecutive readings at or above the high water mark (default `2`), so a
  single spike never pages. A reading below the high mark breaks the run; the
  pending window itself (start, peak, crossing count) survives a dead-band
  reading until a genuine recovery at or below the recovery threshold, so a
  briefly interrupted excursion is still summarised whole. The one *alert*
  message is sent when it opens. The turn-count mismatch kind debounces with
  the alert reading count itself (default `3`) rather than this knob, so both
  layers require the same run and the operator page lands exactly at the Nth
  disagreeing reading — a lone boundary-race reading after a close can never
  open a new incident on its own.
- **Folded crossings.** Every further raw `alert` transition while it is open is
  counted, not delivered.
- **Close.** It closes only after the metric has stayed at or below its recovery
  threshold for the whole quiet period
  (`OBSERVABILITY_HEALTH_ALERT_QUIET_PERIOD_MS`, default 10 min). The one
  *recovered* message then carries start and end time, duration, peak value and
  the number of folded alert crossings.
- **Cooldown.** After a close, `OBSERVABILITY_HEALTH_ALERT_COOLDOWN_MS`
  (default 30 min) suppresses the next *alert* message for that kind. If the
  metric crosses again inside the cooldown, the incident reopens silently and
  its recovered message says so.
- **Restart.** Grouping state is in memory only: after a restart it starts
  fresh, so an incident that was open when the process stopped is reported as a
  new incident.

The metrics file and the B2 admission gate are unchanged — grouping changes only
what reaches the alert sink. The journal still records every raw transition, and
logs the grouped notifications beside them:

```
[HealthTelemetry] heap_pressure alert: heap pressure: 87.3% of the 4288 MB V8 heap limit (alert above 85.0%)
[HealthTelemetry] heap_pressure alert: heap pressure incident: 87.3% of the 4288 MB V8 heap limit (alert above 85.0%); further crossings will be folded into this incident
[HealthTelemetry] heap_pressure recovery: heap pressure incident recovered: peak 87.3% of the 4288 MB V8 heap limit, 2026-09-30T06:56:50.833Z → 2026-09-30T07:26:19.535Z (29m 29s), 6 alert crossings folded
```

Alerting does not depend on the metrics file: if an append fails (EACCES, ENOSPC,
an unreadable directory) the failure is logged, counted
(`HealthTelemetry.appendFailures`), and the latches are still evaluated and
delivered. A disk problem must never silence the alert that says the process is
in trouble.

Delivery reuses the notification layer — no second Telegram client:

- `OBSERVABILITY_HEALTH_ALERT_SINK=notifications` (the production default)
  writes a delivery-ready notification-ingress record that the server's own
  `NotificationManager` claims and delivers through the configured Telegram
  channel. If `NOTIFICATIONS_ENABLED` is false, the record stays in the bounded
  spool and nothing is sent.
- `OBSERVABILITY_HEALTH_ALERT_SINK=file:<absolute path>` appends JSONL to a
  capture file. This is the default under `PI_WEB_UI_VALIDATION_MODE=true`, and
  the startup line says so: `alerts → file:… (operator notifications suppressed)`.
- `OBSERVABILITY_HEALTH_ALERT_SINK=none` disables delivery (the log lines stay).

**In validation mode the sink is always non-delivering.** `notifications` is
ignored (with a warning naming the override) and any `file:` target must
canonicalise inside the run directory; one that escapes is refused and disables
telemetry. So a disposable server that inherits `NOTIFICATIONS_ENABLED` and
Telegram credentials still cannot message the operator:

```
[HealthTelemetry] OBSERVABILITY_HEALTH_ALERT_SINK=notifications is ignored in validation mode: alerts are captured to a file and operator notifications are suppressed.
[HealthTelemetry] disabled: refusing alert sink /root/.pi-web-ui/metrics/alerts.jsonl from a validation server: it is outside the validation run directory (/root/a2-validation/run5r2/validation)
```

### The `Memory:` journal line

`[MultiSessionManager] Memory:` used to be written on every 30 s memory check
whenever heap was above 500 MB or more than five sessions were resident — up to
120 lines per hour, which is why heap history had to be dug out of a 3.8 GB
journal. It now follows a significant-change-plus-heartbeat policy
(`server/src/observability/memory-journal-policy.ts`):

1. the first sample always logs, so every boot has a baseline line;
2. a heap change of at least `OBSERVABILITY_MEMORY_JOURNAL_MIN_DELTA_MB`
   (default `100`) logs;
3. crossing into or out of the “more than
   `OBSERVABILITY_MEMORY_JOURNAL_SESSIONS` resident” regime logs;
4. otherwise a heartbeat logs every
   `OBSERVABILITY_MEMORY_JOURNAL_HEARTBEAT_MS` (default 30 min) **while the
   server is worth heart-beating about** — heap at or above
   `OBSERVABILITY_MEMORY_JOURNAL_HEAP_MB` (default `500`) or many sessions
   resident.

An idle server therefore stays silent instead of trading a noisy gate for a
steady drip. Volume was measured on a disposable server under the same load
before and after (six resident Pi sessions, heap above 500 MB): 120 lines/hour
before, and a handful of *causal* lines (boot, session-regime, heap-change)
with no steady-state lines after. `journalctl -u pi-web-ui | grep 'Memory:'`
still answers “what was the heap?”, and
`~/.pi-web-ui/metrics/health-metrics.jsonl` now answers it per sample.

### Knobs

| Variable | Default | Bounds / allowed values | Meaning |
|---|---|---|---|
| `OBSERVABILITY_METRICS_ENABLED` | `true` | `true`/`false` | Master switch for the sampler. |
| `OBSERVABILITY_METRICS_DIR` | `~/.pi-web-ui/metrics` | absolute path; in validation mode must resolve inside the run directory | Directory for the metrics file. |
| `OBSERVABILITY_METRICS_INTERVAL_MS` | `30000` | `1000`–`3600000` | Sampling cadence. |
| `OBSERVABILITY_METRICS_MAX_FILE_BYTES` | `5242880` | `1024`–`268435456` | Rotation trigger per generation. |
| `OBSERVABILITY_METRICS_MAX_FILES` | `5` | `1`–`100` | Generations kept (including the current file). |
| `OBSERVABILITY_HEALTH_ALERT_HEAP_FRACTION` | `0.85` | `(0, 1]` | Heap alert high water mark (fraction of `heap_size_limit`). |
| `OBSERVABILITY_HEALTH_ALERT_HEAP_RECOVER_FRACTION` | `0.75` | below the high mark | Heap alert low water mark. |
| `OBSERVABILITY_HEALTH_ALERT_LAG_P99_MS` | `500` | `>= 0` | Lag alert high water mark (ms). |
| `OBSERVABILITY_HEALTH_ALERT_LAG_RECOVER_MS` | `200` | below the high mark | Lag alert low water mark. |
| `OBSERVABILITY_HEALTH_ALERT_QUIET_PERIOD_MS` | `600000` | `0`–`86400000` | Below-recovery time that closes an incident. `0` closes on the first recovery reading. |
| `OBSERVABILITY_HEALTH_ALERT_COOLDOWN_MS` | `1800000` | `0`–`86400000` | After a close, how long a new alert message is suppressed (per kind). `0` disables the cooldown. |
| `OBSERVABILITY_HEALTH_ALERT_DEBOUNCE_READINGS` | `2` | `1`–`100` | High readings inside one un-recovered window before an incident opens. `1` disables debounce. The `turn_count_mismatch` kind always uses the mismatch alert reading count instead. |
| `OBSERVABILITY_HEALTH_ALERT_TURN_MISMATCH_READINGS` | `3` | `2`–`100` | J3: consecutive leak readings before the mismatch alert arms. Bounded (correction 02): 1 would page on a single boundary-race reading; out-of-range values fall back to the default with a startup warning. |
| `OBSERVABILITY_HEALTH_ALERT_TURN_MISMATCH_RECOVERY_READINGS` | `2` | `>= 1` | J3: consecutive agreeing readings that clear the mismatch latch. |
| `INTERNAL_API_ADMISSION_TEST_LEAK_FILE` | (unset) | absolute path inside the validation record dir | J3, validation only: a JSON file `{ leakActiveTurns?, leakClass?, leakRuntime? }` naming a phantom admission permit the sampler decorates the counts with, so a disposable server can prove the mismatch alert end-to-end. Refused unless every `createValidationPressureOverride` identity gate passes (validation child flags, this process's identity record, socket and file inside the record dir, record dir outside the production state root); production cannot construct it. Admission behaviour is never changed. |
| `OBSERVABILITY_HEALTH_ALERT_SINK` | `notifications` | `notifications`, `file:<absolute path>`, `none` | Alert delivery target (forced to a capture file in validation mode). |
| `OBSERVABILITY_MEMORY_JOURNAL_MIN_DELTA_MB` | `100` | `>= 0` | Significant heap change for a `Memory:` line. |
| `OBSERVABILITY_MEMORY_JOURNAL_HEARTBEAT_MS` | `1800000` | `>= 1` | `Memory:` heartbeat interval. |
| `OBSERVABILITY_MEMORY_JOURNAL_HEAP_MB` | `500` | `>= 0` | Heartbeat only from this heap usage. |
| `OBSERVABILITY_MEMORY_JOURNAL_SESSIONS` | `5` | `>= 0` | Heartbeat only above this resident-session count. |

Out-of-range or non-integer sampling/rotation/grouping values **fall back to the
documented default and are logged as a warning** at start-up; the interval bound
exists because Node
clamps a `setInterval` delay above `2**31-1` ms to 1 ms (a 30 s sampler would
become a busy loop). A non-hysteretic alert band, a relative metrics directory or
an unknown sink value fail fast instead. An unreadable or failing source hides a
single field as `null`/`0`; telemetry never takes the control plane down.

### For admission work (B2)

`getHealthReadings()` returns the process-wide reading and
`readHeapPressure()` the narrow projection (`heapUsedBytes`, `heapLimitBytes`,
`heapFraction`, `lagP99Ms`, `lagMaxMs`) that admission needs; both are in
`server/src/observability/health-readings.ts`. Admission should import those
rather than re-deriving heap pressure from `process.memoryUsage()`.

### Attributing a lag spike (B1.2)

The A2 lag reading says *that* the loop stalled; it cannot say *what* was on the
loop. `server/src/observability/loop-stall-attribution.ts` adds that second half
with two measured, bounded instruments:

- **named spans** (`span()` for synchronous work, `spanAsync()` for an awaited
  operation) around the session-open paths — `pi.session.resource_loader`,
  `pi.session.open_file`, `pi.session.create_file`,
  `pi.session.create_agent_session`, `pi.multi.create_session`,
  `pi.multi.rehydrate_session`, `pi.browser.load_session_messages`;
- a **loop-stall sampler**: a self-rescheduling 25 ms timer measures how late it
  actually ran. A late tick *is* a blocked event loop (timers could not run),
  and the innermost active span label at that instant names what was on it.
  This is a measurement, not a timing correlation: it cannot attribute a stall
  to an operation that was merely happening nearby.

Correlation hygiene (G2, corrections 02–03): the sampler's timer chain runs
outside any logging correlation context, so no session's ids can stick to stall
lines through the chain (the pre-G2 defect: the first session's ids stamped
every later stall line). Ids are attributed only from the frames actually
blamed — completed or still-open spans whose window covers the missed instant,
plus stack frames entered before it — each with its own ids; when several runs
are blamed the stall carries none rather than a wrong one. Stalls are emitted
through a context-bound logger, so the ids are structured record fields:
`getRecentLogs({sessionId})` and `getRecentLogs({runId})` find them.

Known limit (correction 03): an `async` span stays open while it waits on I/O,
so when several blamed frames overlap the missed instant and any of them is a
still-open async span, the executing frame is NOT known. Such stalls are
reported as candidates — `candidates: <frame> [run=…], … (overlapping async
spans; the executing frame is not known)` with one structured record per
candidate context (marked `stallCandidate`, sharing a `stallId`) so every
involved session finds them — never as a certain blocker. Exact execution
attribution needs execution tracking (async-hooks per-resume enter/exit); that
is the R4 observability item in
[`plans/execution-reports/orchestration-scaling/G2.md`](./plans/execution-reports/orchestration-scaling/G2.md).

Recorded lines (rate-limited to at most one per label per 5 s, so a stall storm
cannot itself become the stall) go through the central logger and therefore land
in the diagnostics ring buffer — `GET /api/v1/diagnostics?component=LoopAttribution`:

```
[LoopAttribution] async span 696.4 ms: pi.session.resource_loader
[LoopAttribution] event-loop stall 716 ms attributed to pi.multi.rehydrate_session [req=req_ab1 run=run_9z sid=sess_7f rt=pi]
```

Bounds and cost: enter/exit is a stack push/pop with no allocation; two
`performance.now()` calls per span; only spans at or above 100 ms
(`spanThresholdMs`) and stalls at or above 50 ms (`stallThresholdMs`) are
retained, in 50-entry rings; label cardinality is capped (64, overflow folds
into `<other>`); the sampling timer is `unref()`d. The attributor is inert under
`VITEST` (the sampler runs, the logger is not wired) and is started lazily by
`getLoopStallAttributor()` on first use, exactly like the shed monitor.
`readLoopStallAttribution()` returns the snapshot without creating or starting
anything. Unit coverage and the measured bounds are in
`server/tests/unit/observability/loop-stall-attribution.test.ts`; the
reproduction harness is `scripts/lag-repro/run.ts` (see
[`plans/execution-reports/orchestration-scaling/B1.2.md`](./plans/execution-reports/orchestration-scaling/B1.2.md)).

### Extension-factory degradation (B1.2b)

The extension factory cache (see `docs/ARCHITECTURE.md`, "Global extension
loading") degrades **per session** to the plain uncached SDK loader when its
pipeline fails — an SDK version other than the validated `1.0.0`, an
unresolvable alias target, a jiti import failure, the override hitting frozen
or changed result objects, or a parity self-check mismatch. Sessions keep
working; session opens stay slow. Each degradation is observable two ways:

- a rate-limited warning (at most one per 5 s) through the central logger,
  hence in the diagnostics ring buffer:
  `[ExtensionFactoryCache] extension factory loading degraded to the plain uncached SDK path (reason: …)`;
- the bounded counter `getExtensionLoaderTelemetry()` from
  `server/src/pi/extension-factory-cache.ts` — `{ fallbacks, lastFallbackReason,
  lastFallbackAt }`. It is a module accessor, not a REST route; wire it into a
  diagnostics component or capacity read-out before alerting on it.

Per-scan importer failures (a broken extension, or a globally broken importer)
are aggregated into their own rate-limited warning listing the failed paths
(`… N extension import(s) failed this scan: …`) — at most one per 5 s, so
repeated opens cannot flood the log (correction 02).

Absence of both signals means every session opened through the factory path.
The loud counterpart lives in the tests:
`sdk-extension-importer.test.ts` pins the installed SDK version to the validated
one EXACTLY and fails on any SDK bump until the alias map and override are
re-validated.

### Re-running the A2 live proof

`server/tests/integration/health-telemetry-live-proof.mjs` (a manual
disposable-server driver, deliberately not a vitest test) boots under a lowered
threshold band and proves: the file grows at the configured cadence and rotates
within its bound; one heap alert and one recovery, driven by a real heap rise
and a real CDP-forced GC; alerts captured to a file rather than messaged; and
journal lines per hour under the same load as the pre-A2 gate. Its refusal mode
(`--mode refusal --expect-refusal-text <path>`) proves a forbidden metrics
directory or alert sink disables telemetry and writes nothing. See
[`plans/execution-reports/orchestration-scaling/A2.md`](./plans/execution-reports/orchestration-scaling/A2.md)
for the exact commands and the recorded numbers.

### Streaming-path telemetry (Hb3)

Each metrics reading carries an additive `streaming` field (Hb3, plan H3 item 2;
G2's R4 proposal) that summarises the Pi streaming path for that reading window,
so an 11:43-type stall can be attributed from the metrics file alone:

```json
"streaming": {
  "windowMs": 30000,
  "spans": { "count": 412, "p50Ms": 1, "p99Ms": 4, "maxMs": 22 },
  "providerGap": { "count": 398, "maxMs": 41000, "provider": "zai" },
  "providers": { "zai": { "chunks": 412, "bytes": 8131, "chunksPerSec": 13.7 } },
  "providersTruncated": false
}
```

- **`spans`** — receipt→dispatch time per provider chunk: stamped when the pi
  event funnel receives the chunk (`pi-service.ts`), closed where the pi path
  has handed the projected frame to every transport (`handleAgentEvent`'s
  browser + Internal-API-observer fan-out, or the single-client
  `EventForwarder` send). Bounded nearest-rank p50/p99/max over a 512-sample
  ring; `count` is exact. A span that grows with per-chunk delivery work
  (projection, enrichment, subscriber fan-out) names the server's delivery
  path — the path G2's LoopAttribution could not see.
- **`providers`** — per provider: chunk count, delta bytes, and chunks/s over
  the window, from the `text_delta` / `thinking_delta` / `toolcall_delta`
  events the provider actually sent (partial message's `provider`; `unknown`
  when absent). Capped at 8 providers — enforced at INSERT time (correction 02,
  review finding 1): the first 8 distinct providers keep their buckets and
  every later provider folds into a reserved `other` bucket, so the live map
  is bounded by construction and `providersTruncated` is set when folding
  happened. A real provider literally named `other` merges into that bucket.
- **`providerGap`** — the largest interval between consecutive chunk receipts
  inside one open message stream (reset by `message_start`/`message_end` /
  `agent_start`, so tool gaps between messages never count), with the count of
  observed intervals and the provider that closed the max gap.

**Attribution reading guide.** A provider that pauses mid-stream shows a large
`providerGap.maxMs` with flat spans and flat lag/CPU in the same reading. A
server-side stall shows large spans (delivery work), or a large gap **plus**
raised `lagP99Ms`/`mainThreadCpuPercentOfCore` — a blocked main thread delays
receipts too, so a gap alone is provider evidence only while the loop is
healthy. Read the three fields (plus lag/CPU) jointly.

**Boundaries.** The span ends at transport dispatch, before the WebSocket
outbound governor's backpressure queue (queued-frame delay is visible through
the existing queued-frame counters and belongs to the WebSocket lane) — a
boundary the lane review examined and the parent accepted as is (correction 02,
item 5). Cost:
per delta chunk O(1) map/counter work, no logging; percentiles are computed
once per window at sample time; when disabled the hooks are one boolean check
per event. The field is additive on the metrics FILE only (not the Internal API
wire); `getHealthReadings()` (B2 admission) never sees or drains windows — the
source is registered on the A2 sampler only. Disabled by
`OBSERVABILITY_STREAMING_TELEMETRY=off` (also requires the sampler itself to
be enabled). Unit coverage:
`server/tests/unit/observability/streaming-telemetry.test.ts`; the Hb3 live
attribution proof (real GLM turn, mock-provider pause arm, server-side stall
arm, on/off overhead) is recorded in
[`plans/execution-reports/orchestration-scaling/Hb3.md`](./plans/execution-reports/orchestration-scaling/Hb3.md).

## Manual browser diagnostic bundle

The browser keeps a small in-memory ring of connection lifecycle, abnormal
close, protocol-drift, storage-failure, React error, and **speech-scheduling**
evidence. It stores no chat text, tool payloads, session IDs, paths, auth
data, or raw malformed messages. If the React error boundary appears, **Copy
diagnostics** or **Download diagnostics** exports the bundle manually; nothing
is uploaded automatically. Reloading clears the ring.

## Voice Mode observability

What the server's voice talker (Voice Mode two-lane harness) did, and why. The
canonical feature doc — architecture, speech policy, reading levels, and the
voice field table — is [`docs/VOICE-MODE-INTENT.md`](./VOICE-MODE-INTENT.md); this section owns
the retrieval path and the record shapes.
Everything below rides the existing doctrine: the records are ordinary
central-logger records from the `VoiceMode` component, secret-scrubbed on
entry into the same diagnostics ring; counters ride the same operational
snapshot. No second buffer, no new endpoint. Records are process-local and
bounded (ring: 1,000 records / 2 MiB) — they reset on restart; the durable
evidence of a relay remains the worker transcript itself.

### The exact queries

Follow ONE spoken utterance end to end (records are correlated by
`voiceTurnId` = `runtime:workerSessionId:turnIndex`):

```bash
SOCKET="$HOME/.pi-web-ui/internal-api.sock"   # or the disposable server's socket
TOKEN="$(cat "$HOME/.pi-web-ui/internal-api-token")"
VTID='pi:<workerSessionId>:3'                 # the turn you are investigating

# 1. Everything recorded about that one turn (turn record + release/gate record):
curl -s --unix-socket "$SOCKET" -H "Authorization: Bearer $TOKEN" \
  "http://localhost/api/v1/diagnostics?voiceTurnId=$(node -p 'encodeURIComponent(process.argv[1])' "$VTID")"

# 2. Enumerate the whole voice conversation (newest last), then filter by
#    workerSessionId locally:
curl -s --unix-socket "$SOCKET" -H "Authorization: Bearer $TOKEN" \
  "http://localhost/api/v1/diagnostics?component=VoiceMode&limit=200" \
  | jq '.recentLogs[] | select(.workerSessionId == "<workerSessionId>")'

# 3. Machine-readable counters for the same story:
curl -s … "http://localhost/api/v1/diagnostics" | jq '.operational.voice'

# 3c. What did the live talker SAY, and why did it say it?
journalctl -u pi-web-ui.service | grep -E "talker_reply|talker_tool_call|worker_brief_injected"
#   voice-kernel {"event":"talker_reply","excerpt":"…","chars":N}        ← its actual reply
#   voice-kernel {"event":"talker_tool_call","tool":"relay_to_worker"}  ← why it relayed (the model decided)
#   voice-kernel {"event":"worker_brief_injected","mode":"full",
#                 "historyMessages":N,"historyTotal":M,"briefChars":C}     ← what it held
#   `mode` is the brief policy's decision: `full` (the whole session, under the
#   measured ceiling), `recent` (a bounded view that says what it omits),
#   `delta` (only what the model has not been told) or `none`.
#   Together with the existing
#   `operator_utterance` line (what the operator said, classified), these four
#   answer "what did I ask, what did it answer, what did it know" from the
#   server alone — the gap the 2026-09-18 "it says it has no access" report
#   exposed. Excerpts are single-line and length-bounded; the full transcript
#   stays in the browser by design.

# 3d. Did the talker read further back for itself, and did it find anything?
journalctl -u pi-web-ui.service | grep -E "worker_history_retrieved|worker_brief_unavailable|worker_brief_empty"
#   voice-kernel {"event":"worker_history_retrieved","queryChars":N,
#                 "matches":M,"searched":S,"chars":C}                 ← the read
#   voice-kernel {"event":"worker_brief_empty","conversationEntries":N} ← it held NO work
#   voice-kernel {"event":"worker_brief_unavailable","message":"…"}   ← the read failed
#   `searched` is how many messages the host could see and `matches` how many
#   matched, so "it said the session does not contain that" is checkable rather
#   than taken on trust. `worker_brief_unavailable` is the honest degraded state:
#   the talker then holds only the status line, and says so.
#   `worker_brief_empty` is the one to look for when the talker says it cannot see
#   the work: the lane was given a status line and nothing about the work at all.
#   It exists because on 2026-09-18 that condition was diagnosable only by
#   noticing which event was MISSING (an unloaded worker session read as an empty
#   one — since fixed: an unloaded session's file is read, see
#   `server/src/talker/session-file-history.ts`).

# 3b. Has a client reported a capture fault (a microphone that could not start)?
curl -s … "http://localhost/api/v1/diagnostics" | jq '.operational.voice.live.captureFaultTotal'
# → {"worklet_unavailable": 1} etc; unknown reasons bucket as "other". The same
#   report appears in the journal as a structured evidence line:
#   `voice-kernel {"event":"voice_capture_fault","laneId":…,"reason":…}`
#   This is how a failure that only the operator could see in their browser
#   console (the 2026-09-18 native-lane worklet failure) becomes server-side.

# 3a. Which provider model is the live engine actually on?
curl -s … "http://localhost/api/v1/diagnostics" | jq '.operational.voice.live.model'
# → "gemini-3.8-live" (the seat every `connect` sends); `null` means the server
#   has not stated it, never an assumed model. The live path also announces it
#   once per lane at the default log level: `voice live session ready {"model":
#   "gemini-3.8-live"}` on the `VoiceLive` component, emitted when the provider
#   reports `setupComplete` — the model is a recorded fact, not an inference.

# 3f. The model-driven relay (2026-09-22): what did the talker relay, and was it approved?
journalctl -u pi-web-ui.service | grep -E "talker_tool_call|promotion_authorised|item_parked"
#   voice-kernel {"event":"talker_tool_call","tool":"relay_to_worker"}    ← the model chose to relay
#   voice-kernel {"event":"promotion_authorised","proposalId":…,"sha256":…,
#                 "relayTextExcerpt":…,"via":"relay_to_worker"}            ← the candidate shown to the operator
#   voice-kernel {"event":"item_parked","workerBusy":true,
#                 "via":"relay_to_worker"}                                  ← the worker was busy; parked
#   voice-kernel {"event":"relay_duplicate_ignored","sinceLastRelayMs":N}   ← the model repeated one relay
#   A relay becomes a proposal (idle worker) or a parked item (busy worker). It
#   reaches the worker only through an explicit operator confirmation, whose own
#   receipt is the durable record. `relay_duplicate_ignored` is the bounded
#   integrity guard: an identical relay repeated within 5 s is dropped so the
#   operator can never approve the same message twice. Ordinary conversation
#   produces NO such line: the harness no longer classifies transcripts into
#   relay vs conversation — the model's `relay_to_worker` call is the only relay
#   signal.
```

`voiceTurnId` is a plain string match and composes with the existing
selectors (`component`, `runtime`, `since`, `minLevel`, `limit`).

The `VoiceMode` log lines also carry the correlation triple in the message
itself — `voice turn pi:<workerSessionId>:<turn>` (and `voice release …`,
`voice gate denied …`, `voice turn refused runtime=… worker=…`) — so the
worker session a lane is bound to is greppable from `journalctl` without a
JSON formatter (P24).

### The lane and the conversation (P24)

Voice records ride the shared diagnostics ring, which is bounded (1,000
records / 2 MiB): on a busy server the ring rotates and the documented
`?component=VoiceMode` read can legitimately return nothing. Two small
process-local stores in the talker's observability module therefore answer
the two ordinary operator questions directly, through the SAME diagnostics
route (no new endpoint, no second ring — the stores are written on the same
observation path and are reset on restart, exactly like the ring):

```bash
# 1. Which worker session is the voice lane attached to? (always in the response)
curl -s --unix-socket "$SOCKET" -H "Authorization: Bearer $TOKEN" \
  "http://localhost/api/v1/diagnostics" | jq '.voiceMode.lanes'
# → [{ runtime, workerSessionId, boundAt, lastTurnAt, turnCount }]

# 2. What was actually said — opt-in, bounded excerpts of the last n turns:
curl -s --unix-socket "$SOCKET" -H "Authorization: Bearer $TOKEN" \
  "http://localhost/api/v1/diagnostics?voiceConversation=10" | jq '.voiceMode.recentTurns'
# → [{ voiceTurnId, ts, phase, utteranceExcerpt, replyExcerpt, … }]
```

Privacy (a deliberate decision, vetoable by the operator): the conversation
store holds the operator's own utterances and the talker's replies — bounded
(50 turns; excerpts length-capped at 500 chars with `utteranceTruncated` /
`replyTruncated` disclosing truncation), secret-scrubbed on the same path as
every record, local runtime state only: never persisted, never committed,
never leaving the machine. It is write-only observation — nothing in the
talker reads it back, it feeds no draft and no release path, and the
confirm-release gate is untouched (`release()` keeps its single caller). The
DEFAULT diagnostics response carries lane metadata only; utterance text is
returned only behind the explicit `?voiceConversation=<n>` opt-in, so
ordinary agent-facing diagnostics traffic never carries operator speech.
Utterances the prompt-injection gate blocked are never excerpted anywhere.

### Record shapes (what healthy looks like)

Every operator turn emits one `voice turn` info record; a release or a gate
refusal adds a second, same-`voiceTurnId` record:

- **answered** — conversational turn; `modelCalled: true`, `phase:
  "answered"`.
- **proposed** — an instruction is now held (`draftAction: "accumulated"`,
  `draftSizeAfter` grows). The turn that OPENED the batch also shows
  `receiptAckEmitted: true` (the spoken "Noted — still holding that."). When
  the draft was opened by an ask-the-worker OFFER (P18: the talker could not
  answer the operator's question and proposed passing it on), the record also
  carries `askWorkerOfferEmitted: true`; the held text is still the operator's
  own question, never the model's paraphrase.
- **released** — the gate opened. The `voice turn` record has `phase:
  "released"`, and the companion **`voice release`** record carries what a
  confirmation actually sent: `releasedBytes` (UTF-8), `releasedSha256`
  (first 16 hex of the text digest), `releasedExcerpt` (≤120 chars), and the
  delivery adapter's own verdict: `deliveryOutcome` (`delivered` / `queued` /
  `refused`), `releaseMechanism` (`steer` / `prompt` / `follow_up`),
  `deliveryDisclosure`, and `deliveryError` on a refusal. Verify the exact
  text against the worker transcript with the digest/bytes — the full text is
  never logged.
- **refused** — the gate HELD. A **`voice gate denied`** record carries
  `gateDenialReason`: `nothing_pending` (a stray "yes"), `lapsed` (the
  confirmation window expired; the draft is re-surfaced, never silently
  dropped), or `ambiguous` (an ordinal selection that matched nothing).
  **These are healthy, not errors** — a thinking-aloud operator produces many
  `voice_gate_denied_total` and few releases.
- **cancelled** — the operator withdrew the draft; the denial record shows
  `gateDenialReason: "cancel_classified"`.

The `operational.voice` block mirrors the same story as counters:
`turnTotal{phase}`, `releaseTotal{"mechanism:outcome"}` (refusals have no
mechanism and count under `"none:refused"`), `gateDeniedTotal{reason}`,
`receiptAckTotal`, plus latency snapshots `turnDuration` (`voice_turn_duration_ms`),
`modelLatency` (`voice_model_latency_ms`), and `deliveryLatency` per mechanism
(`voice_delivery_latency_ms{mechanism}` — the delivery-adapter call duration).

### Common failure signatures

1. `phase: "error"` with an `error` message — the talker's model failed; the
   operator heard the fixed fallback line. `modelCalled: false`.
2. `voice release` with `deliveryOutcome: "refused"` + `deliveryError` — the
   gate opened but the worker adapter refused (e.g. non-SDK Claude backend).
   The operator heard "I couldn't deliver that…"; NOTHING reached the worker.
3. `voice release` with `deliveryOutcome: "queued"`, `releaseMechanism:
   "follow_up"` — the worker was busy; the utterance arrives after the
   current turn. Not an error.
4. `voice turn refused` (no `voiceTurnId` — it never became a talker turn):
   `refused: "prompt_injection"` (blocked before anything, and never
   excerpted), `"model_unconfigured"`, or `"deliveries_unavailable"`.
5. No records at all → the ring evicted or restarted since the interaction;
   fall back to `?voiceConversation=<n>` (P24, survives ring rotation for the
   last 50 turns), then to the worker transcript + run receipts (durable).

### Field-honesty notes

- `classifierReason` from the design's field table is **not emitted**: the
  mechanical classifier returns a class only, and observing may not change
  it. Omitted rather than invented.
- The correlation `sessionId` field is deliberately absent on voice records:
  the talker path runs on the browser WebSocket, outside the request
  correlation context, and `workerSessionId` (the runtime session id the
  client already holds) is carried as a record field instead. That is why the
  voice path is the plain `GET /api/v1/diagnostics` route — the
  `/sessions/:id/diagnostics` route filters on the internal registry id and
  will not match these records.
- The WebSocket `talker_turn_result.phase` remains `answered` for gate
  refusals (the transport is unchanged by observability); only the log
  record's `phase` says `refused`.
- Excerpts are bounded at 120 chars; no full utterance, draft, or reply body
  is ever logged, and the ring's existing scrubber redacts credential-shaped
  strings inside the excerpt fields on entry (verified by test).

### The client half — "why didn't I hear it?"

The speech arbiter records each scheduling decision into the browser
diagnostic ring above: events with `kind: "speech"` carry an `operation`
(`submit`, `drop`, `floor_held`/`floor_released` for barge-in,
`playback_failed`, `paused`/`resumed`/`stopped`), the `speechTier` (2 receipt
ack and release ack, 3 the answer — the worker's completed answer or, since
P18, the talker's elicited reply to a question the operator just asked — and
4 unprompted chatter), and a short bounded `state` reason for drops
(`busy`, `invalid`). Recover them with **Copy/Download diagnostics** and look
for `kind: "speech"` entries; a chatter tier dropped because an answer was
playing shows as `drop`/`busy`. No text, ids, or server round-trips: the
decisions stay in the browser ring, cleared on reload.

### Client error reports (P13 — the crash that survives a reload)

The manual bundle above is the fallback for survivable states. A crash is not
survivable: once the tab reloads, the browser ring is gone and the error
boundary's export is unreachable. Client errors of the voice surface are
therefore ALSO uploaded — by a small, additive, bounded client reporter — and
re-emitted server-side as ordinary `ClientVoice` central-logger records, so
they land in the SAME diagnostics ring as every other record (no second
buffer, no query surface).

What is uploaded: uncaught errors, unhandled promise rejections, React error
boundary catches (`react_render`), speech `playback_failed` (the barge-in
path), dictation errors (mic / STT pipeline), and talker-bus listener
failures. Each report is scrubbed client-side AND again by the ring's
scrubber on entry, length-capped (message 300 chars, stack 1500), and carries
up to 12 allowlisted recent browser-ring events as context — the barge-in
story (floor held/duck/playback) rides along with the failure it preceded.
Voice-surface reports carry `runtime` + `workerSessionId` (the same key
`VoiceMode` records use) so a client error joins the server-side story.
The client caps itself at 10 uploads per page load; the route sits behind
the shared `/api` rate limit and auth (cookieAuthMiddleware).

The documented retrieval path (same ring, one new component selector):

```bash
# Recent client error reports, newest last:
curl -s --unix-socket "$SOCKET" -H "Authorization: Bearer $TOKEN" \
  "http://localhost/api/v1/diagnostics?component=ClientVoice&limit=50"

# Scoped to the worker session the voice surface was bound to
# (workerSessionId is a plain record field — filter locally with jq):
curl -s … "http://localhost/api/v1/diagnostics?component=ClientVoice&limit=200" \
  | jq '.recentLogs[] | select(.workerSessionId == "<workerSessionId>")'
```

A report's `msg` is `client error report:`, `level` is `error`, `operation`
names the surface path (`uncaught_error`, `unhandled_rejection`,
`react_render`, `playback_failed`, `dictation_error`, `talker_listener`), the
conventional `error` object carries name/message/bounded stack, and
`recentEvents` is the preceding browser-ring tail. Absent fields were
absent — a global-handler report legitimately carries no session
correlation.

### Playback health (P13 gap fill — the lane that never played what it accepted)

A crash is only half of "why didn't I hear it?". The other half is a lane
that **accepted audio and never played it** — stranded or dropped speech, which
is what the operator hears as a sentence that stops or as two sentences on top
of each other. That used to live only in the surface's memory: the browser ring
is manual-only and dies with the tab, and the pipeline's faults and stats never
left the page at all. They now ride the SAME bounded upload and the SAME
`ClientVoice` component as the client error reports — no second store, no new
query surface:

```bash
# Recent playback-health records, newest last:
curl -s --unix-socket "$SOCKET" -H "Authorization: Bearer $TOKEN" \
  "http://localhost/api/v1/diagnostics?component=ClientVoice&limit=50"

# Just the lane outcomes (one record per lane that accepted any audio):
curl -s … "http://localhost/api/v1/diagnostics?component=ClientVoice&limit=200" \
  | jq '.recentLogs[] | select(.operation == "playback_health" and .reason == "lane_end")'
```
A playback-health record's `msg` is `client playback health`, `level` is
**`warn`** (not `info`: info records are namespace-filtered, and this evidence
must always reach the ring), `operation` is `playback_health`, and `reason` is
one of `playback_chunk_corrupt`, `playback_seq_gap`, `playback_overflow` (a
fault, uploaded the moment it happens) or `lane_end` (the summary, uploaded
once per period of playback activity). `stats` carries the bounded numbers at
that moment — `chunksScheduled`, `chunksDropped`, `pendingChunks`, `pendingMs`,
`queuedMs`, `ducked` — and the usual `runtime` + `workerSessionId` correlation
is attached when the surface knows it.

**How to read it.** At `lane_end`, `pendingMs` is the audio the lane accepted
and never played: a lane that played everything reports `pendingMs: 0` with a
`chunksScheduled` matching what it received, while a non-zero `pendingMs` is
stranded speech. `chunksDropped` counts what the backlog bound discarded.
Before this, answering that question required the purpose-built lane lab
([`VOICE-LANE-LAB.md`](./VOICE-LANE-LAB.md)); now the ordinary production query
answers it, and the lab remains the instrument for the shape of the schedule
itself.

What is uploaded is bounded and scrubbed exactly like an error report: `detail`
is capped at 300 characters and scrubbed client-side and again on entry, every
statistic is clamped to a finite non-negative integer (the client clamps before
it sends, so a bad number can never 400 the report), the recent-event context
is capped at 12 allowlisted entries, and the client caps itself at 20 health
uploads per page load (a SEPARATE budget from the 10 error uploads, so a long
lane with faults cannot starve crash reporting). No utterance text, no
transcript bodies, no cookies, no auth data. The route's schema is strict: an
unknown field is rejected rather than stored, so transcript content cannot be
smuggled in beside a health record.

## Run budgets (B3a + B3b)

Every in-process Pi session enforces a per-run budget on streamed tool-call
argument characters. The 2026-09-12 production stall (a runaway generation whose
tool-call arguments were re-parsed per streamed delta — quadratic, synchronous,
~11 minutes of unresponsive server) used to be bounded by a local `node_modules`
patch; that patch is removed and the bound now lives in pi-web-ui, leaving
`@earendil-works/pi-ai` pristine.

- **Where:** `server/src/pi/tool-args-budget.ts`, installed at the single
  `PiService.createSession` subscribe funnel — one guard per session, covering
  Internal API dispatches, browser sessions and hosted sessions alike.
- **Caps:** `PI_TOOL_ARGS_MAX_CALL_CHARS` (default `65536` per tool call) and
  `PI_TOOL_ARGS_MAX_TURN_CHARS` (default `262144` per run). `0` disables a cap;
  an invalid value, or a turn cap below the call cap, logs one warning and falls
  back to the defaults — configuration never stops startup.
- **On breach:** the guard emits one `tool_args_budget_exceeded` event on the
  session's normal stream (`data: { scope, capChars, observedChars,
  contentIndex? }`) and aborts the turn via the public `AgentSession.abort()`.
  Internal API receipts terminate `failed` with `RUN_BUDGET_EXCEEDED`; the
  synchronous dispatch answers `500` with that code and the `runId`.
- **What to look for:** log component `ToolArgsBudget` (a human-readable warn
  line per breach), the `tool_args_budget_exceeded` event on the session event
  stream (its `data` carries scope/cap/observed — the run receipt itself
  stores only the `RUN_BUDGET_EXCEEDED` code), and the code in the error-code
  catalog.
- **Calibration (B3a correction 02, 2026-09-29 — PACED measurements decide):**
  measured on pristine pi-ai 0.87.1, per-delta parse cost grows from ~0.37 ms
  at 4 KB accumulated to ~12.8 ms at 460 KB (linear per call, quadratic over a
  stream); one 460 KB fine-delta generation integrates to ~141 s of
  main-thread CPU. Pacing is what real generation does — the collapse needs
  parse-time × delta-rate ≥ 1 — so the default was re-decided with paced runs
  of the fine-delta fixture through a disposable pristine server, all aborting
  at the cap with `RUN_BUDGET_EXCEEDED`:
  - 64 KB at the incident's ~90 deltas/s: abort 184.6 s, lag p99 max **4 ms**
    over 185 samples, zero ≥300 ms;
  - 64 KB at ~300 deltas/s: abort 52.0 s, lag p99 max **10 ms** over 52
    samples, zero ≥300 ms;
  - 32 KB unpaced (for the record): abort 6.6 s, single lag sample 6,268 ms —
    the unpaced lab worst case pins the loop for its whole pre-abort window.
    Preserved correction-03 runs quantify that worst case at the default caps:
    64 KB unpaced aborts at the cap after 21.7 s with lag p99 max **10,615 ms**
    (`measure/corr03-64k-unpaced.json`), and the cap-off control — which never
    aborts — shows **p99 max 23,643 ms** (`measure/corr03-capoff.json`). Each
    reading comes from only two A2 samples (the sampler itself starves while
    the loop is pinned), so treat them as a floor; they are bounded by the
    abort in the cap-on case. This worst case is a residual risk of the 64 KB
    default; an operator who prefers the tighter bound sets
    `PI_TOOL_ARGS_MAX_CALL_CHARS=16384`.
  The cap-off positive control (unpaced) reproduces the stall class from the
  preserved correction-03 evidence (p99 max 23,643 ms, no abort;
  `measure/corr03-capoff.json`).
  Real tool arguments measured over 5,633 recent calls: p50 233 B, p90 ~2 KB,
  p99 ~9.8 KB, max 36.9 KB — the 64 KB default keeps patch parity and has
  zero observed false positives (the 16 KB alternative would have failed
  ~0.16% of calls, including large legit `write`s).

### Per-run output-token and streamed-byte budgets (B3b, contract 1.50.0)

Beside the tool-argument guard, every in-process Pi session enforces two more
per-run budgets against runaway generation (endless prose, thinking or tool
calls — the same 2026-09-12 class beyond its quadratic parse arm):

- **Where:** `server/src/pi/run-budget.ts`, one guard per session at the same
  single `PiService.createSession` subscribe funnel.
- **Caps:** `PI_RUN_BUDGET_MAX_OUTPUT_TOKENS` (default `1000000` per run) and
  `PI_RUN_BUDGET_MAX_STREAMED_BYTES` (default `4194304` = 4 MiB per run,
  UTF-8 bytes over text + thinking + tool-call deltas; re-sized from 16 MiB
  by B3c, see Calibration below). `0` disables a
  dimension; an invalid value logs one warning and falls back — configuration
  never stops startup.
- **What counts:** output tokens are summed from the public `usage.output`
  each assistant message reports at `message_end` (the runtime reports usage
  only in the final streaming chunk — the token cap therefore trips at
  message boundaries); streamed bytes count every `text_delta`,
  `thinking_delta` and `toolcall_delta` as they stream, which is the LIVE
  mid-stream bound within a message. Providers without usage reporting (37 of
  73,843 measured assistant messages) never trip the token cap; the byte cap
  still bounds them.
- **On breach:** one `run_budget_exceeded` event on the session's normal
  stream (`data: { budget: "output_tokens" | "streamed_bytes", cap, observed }`),
  then the public `AgentSession.abort()` with the same bounded retry pattern
  as B3a. Internal API receipts terminate `failed` with the SAME
  `RUN_BUDGET_EXCEEDED` code (which budget tripped lives on the event — the
  receipt persists only the code). B3a's `tool_args_budget_exceeded` event
  now also carries `data.budget: "tool_args"` (additive) so all three budgets
  share one discriminator.
- **What to look for:** the `run_budget_exceeded`
  event on the session event stream and the error-code catalog hint. (Log
  lines from component `RunBudget` appear only when abort retries fail — a
  clean breach is observable on the event stream and the receipt, not the
  log.)
- **Calibration (correction 02 — measured on the guard's real run boundary
  with the CORRECTED merge key; pi-agent-core's loop consumes queued
  follow-ups INSIDE one run, so persisted user-message segments are merged
  into one run when the segment's USER timestamp is within 2 s of the
  previous assistant end — v2 wrongly merged on the first assistant
  timestamp):** 735 files / 3,356 segments; the gap distribution is bimodal
  (921 gaps <2s vs 1,226 ≥30s). Merged at <2s: **918 joins → 2,382 runs** —
  output tokens per merged run p50 9,403, p99 148,540, p99.9 257,194, max
  **270,689**; streamed bytes p50 33,018, p99 537,833, p99.9 896,543, max
  **1,050,331**. Worst case at a 30s merge: 1,900 runs, same maxima.
  - output tokens: **0/2,376 merged runs breach 1,000,000** (3.7× the merged
    max; the 2× rule vs the worst case requires ≥541,378). Deliberately
    loose: the token cap fires only at message end, so it must not abort a
    legitimate long agentic loop — the byte cap is the live bound.
  - streamed bytes (B3c re-sizing, 2026-09-29): **0/2,382 merged runs breach
    the new 4 MiB default** (~4× the merged max, ≥2× rule). The default was
    re-sized from 16 MiB by live measurement: 12 pristine-harness
    `bytes`-scenario runs at the 1 s A2 cadence (5× 8 MiB, 5× 4 MiB, 2×
    16 MiB positive control; every per-run verdict and A2 sample kept with
    the B3c evidence) — worst single-sample end-of-run stall 209 ms at 8 MiB
    (over the frozen <200 ms sizing rule), 132 ms at 4 MiB (under), 180/187
    ms at the 16 MiB controls. The upstream finalisation stall scales with
    the finalised message size, so the smaller default bounds it well under
    the B2 lag threshold. (The original 16 MiB choice was ~16× the merged
    max with 0/2,382 breaches.)
  - real streaming rate (merged-run bytes/wall, includes tool time): p50
    143 B/s, p99 1,088 B/s, p99.9 2,710 B/s, max 6,583 B/s — the live-proof
    pacing is justified against these figures.
  History: the first-round segment view and the correction-01 v2 figures
  (wrong merge key: 3,273 runs at 2s) are preserved in the lane measure dir
  (`measurement.json`, `measurement-v2.json`); corrected figures are
  `measurement-v3.json`. Independent reviewer aggregation (918 joins; 2,375
  token runs / max 270,689; 2,381 byte runs / max 1,050,331) matches v3
  exactly on joins and maxima; v3's run counts are +1 (2,376/2,382) because
  the live corpus gained a segment between the reviewer's scan and the v3
  scan.

## Error codes & enrichment

Every Internal API error response has the stable shape `{ error, code }`. Codes
live in one catalog — `server/src/internal-api/error-codes.ts` (`ErrorCode`
constants + `ERROR_CODE_INFO` metadata) — and the most actionable codes
additionally include a `hint` (next step) and `docs` (anchor). Additive —
existing consumers ignore the extra fields. See the full table in
[`INTERNAL-API-CONTRACT.md`](./INTERNAL-API-CONTRACT.md#error-code-catalog).

```json
{ "error": "Session not found", "code": "SESSION_NOT_FOUND",
  "hint": "List current sessions with GET /api/v1/sessions and use a valid sessionId.",
  "docs": "docs/INTERNAL-API.md#list-sessions" }
```

## Event-type registry

The normalized event kinds emitted on the `/events` SSE stream, machine-readable
and drift-proof (derived from `SSE_EVENT_TYPES`):

```
GET /api/v1/events/types   → { eventTypes: [ { type, description, category, verbosity } ] }
```

See [`INTERNAL-API.md`](./INTERNAL-API.md#event-type-registry) and
[`EVENT-PIPELINE.md`](./EVENT-PIPELINE.md).

## Request logging

At `LOG_LEVEL=debug`, every Internal API request emits one line —
`[InternalAPI] METHOD path → status (Xms)` — carrying the same `requestId` as
the prompt correlation, so you can confirm a call arrived and tie it to the
turn. No request bodies or headers are logged.

## Session cleanup funnel

The hygiene funnel (`server/src/session-cleanup.ts`, component `SessionCleanup`)
logs a startup line with its effective intervals, then one summary per pass. In
the default dry-run mode (`SESSION_CLEANUP_DRY_RUN=true`) the summary is
`[SessionCleanup] DRY-RUN pass (no changes written): would unpin N, would archive N, would delete N`
with a small sample of affected paths; once armed it becomes
`[SessionCleanup] Cleanup complete: N unpinned, N auto-archived, …`, with one
`Auto-archived session idle > Nd: <path>` info line per auto-archived session.
Config: `SESSION_AUTO_ARCHIVE_DAYS`, `SESSION_RETENTION_MIN_DWELL_DAYS`,
`SESSION_CLEANUP_DRY_RUN` (see [`DEPLOYMENT.md`](../DEPLOYMENT.md)).

## Fatal errors

`server/src/index.ts` registers `uncaughtException` / `unhandledRejection`
handlers exactly once at startup (logic in `server/src/fatal-error-handlers.ts`).
Both log message + stack + a context snapshot (active session count, uptime);
`uncaughtException` then triggers graceful shutdown (mirrors SIGTERM/SIGINT).

## Test output & fast loop

- App `console.*` + central-logger output is **silenced during tests by default**
  (`VITEST_LOG=1` restores) so a failing test shows the assertion, not log noise.
- A machine-readable JSON report is written to `server/test-results.json` /
  `client/test-results.json` every run (git-ignored).
- Per-file timing, single-file/single-test commands: see
  [Fast test loop for agents](./TROUBLESHOOTING.md#fast-test-loop-for-agents).
