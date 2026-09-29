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
| `lagP50Ms`, `lagP99Ms`, `lagMaxMs`, `lagWindowMs`, `lagSampleCount` | Event-loop lag percentiles over the last 60 s at the 500 ms shed-monitor cadence. |
| `activeTurns`, `activeTurnsByClass` | Active turns, by runtime label by default; by admission class (P0–P3) when admission registers its snapshot. `{}` means no source could see them — never a misleading zero per class. |
| `residentSessions` | Sessions loaded in the Pi `MultiSessionManager`, registered by that manager. `null` when unmeasured. |
| `registryEntries` | Session-registry entries. `null` when no unique registry instance exists. |

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

Semantics: **one alert on the crossing and one recovery message on the
clearing**, never one message per sample. Any value between the two thresholds
is a dead band that changes nothing, which is what stops a reading that
oscillates around the trigger from flapping. Because a recovery must be earned,
a latch always has two thresholds and a start-up validation refuses a band whose
low water mark is not below its high water mark.

Each transition is logged and delivered:

```
[HealthTelemetry] heap_pressure alert: heap pressure: 87.3% of the 4288 MB V8 heap limit (alert above 85.0%)
[HealthTelemetry] heap_pressure recovery: heap pressure cleared: 74.1% of the 4288 MB V8 heap limit (recovered below 75.0%)
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
| `OBSERVABILITY_HEALTH_ALERT_SINK` | `notifications` | `notifications`, `file:<absolute path>`, `none` | Alert delivery target (forced to a capture file in validation mode). |
| `OBSERVABILITY_MEMORY_JOURNAL_MIN_DELTA_MB` | `100` | `>= 0` | Significant heap change for a `Memory:` line. |
| `OBSERVABILITY_MEMORY_JOURNAL_HEARTBEAT_MS` | `1800000` | `>= 1` | `Memory:` heartbeat interval. |
| `OBSERVABILITY_MEMORY_JOURNAL_HEAP_MB` | `500` | `>= 0` | Heartbeat only from this heap usage. |
| `OBSERVABILITY_MEMORY_JOURNAL_SESSIONS` | `5` | `>= 0` | Heartbeat only above this resident-session count. |

Out-of-range or non-integer sampling/rotation values **fall back to the default
and are logged as a warning** at start-up; the interval bound exists because Node
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

Recorded lines (rate-limited to at most one per label per 5 s, so a stall storm
cannot itself become the stall) go through the central logger and therefore land
in the diagnostics ring buffer — `GET /api/v1/diagnostics?component=LoopAttribution`:

```
[LoopAttribution] async span 696.4 ms: pi.session.resource_loader
[LoopAttribution] event-loop stall 716 ms attributed to pi.multi.rehydrate_session
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

## Run budgets (B3a)

Every in-process Pi session enforces a per-run budget on streamed tool-call
argument characters. The 2026-09-12 production stall (a runaway generation whose
tool-call arguments were re-parsed per streamed delta — quadratic, synchronous,
~11 minutes of unresponsive server) used to be bounded by a local `node_modules`
patch; that patch is removed and the bound now lives in pi-web-ui, leaving
`@earendil-works/pi-ai` pristine.

- **Where:** `server/src/pi/tool-args-budget.ts`, installed at the single
  `PiService.createSession` subscribe funnel — one guard per session, covering
  Internal API dispatches, browser sessions and hosted sessions alike.
- **Caps:** `PI_TOOL_ARGS_MAX_CALL_CHARS` (default `16384` per tool call) and
  `PI_TOOL_ARGS_MAX_TURN_CHARS` (default `65536` per run). `0` disables a cap;
  an invalid value, or a turn cap below the call cap, logs one warning and falls
  back to the defaults — configuration never stops startup.
- **On breach:** the guard emits one `tool_args_budget_exceeded` event on the
  session's normal stream (`data: { scope, capChars, observedChars,
  contentIndex? }`) and aborts the turn via the public `AgentSession.abort()`.
  Internal API receipts terminate `failed` with `RUN_BUDGET_EXCEEDED`; the
  synchronous dispatch answers `500` with that code and the `runId`.
- **What to look for:** log component `ToolArgsBudget` (one warn line per
  breach with scope/cap/observed), the `tool_args_budget_exceeded` event in the
  session stream/receipt event record, and `RUN_BUDGET_EXCEEDED` in the
  error-code catalog.
- **Calibration (B3a gate, 2026-09-29):** measured on pristine pi-ai 0.87.1,
  per-delta parse cost grows from ~0.37 ms at 4 KB accumulated to ~12.8 ms at
  460 KB (linear per call, quadratic over a stream); one 460 KB fine-delta
  generation integrates to ~141 s of main-thread CPU. The live proof drove the
  incident pattern through a disposable pristine server: with the fine-delta
  fixture, the 64 KB parity cap BREACHED the B2 lag gate (p99 8.3 s — an
  unpaced stream pins the loop for its whole ~18–22 s pre-abort window), while
  the 16 KB default PASSED (unpaced: p99 93 ms, abort ~2.3 s; paced at the
  incident's ~90 events/s: lag p99 max 3 ms across 47 samples, zero over
  300 ms). The cap-off positive control showed the stall class (lag p99
  7.4 s while streaming past the cap bound). Accepted trade-off: ~0.16% of
  measured real tool calls (9/5,633; largest observed argument 36.9 KB) would
  breach the 16 KB default — raise `PI_TOOL_ARGS_MAX_CALL_CHARS` for
  workloads that legitimately write big files.

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
