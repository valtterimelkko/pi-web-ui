# Long-Horizon Live Validation

> Watch a real agent session over a long horizon — minutes to hours — and decide whether something happened, with **no human in the loop** and **no connection held open**.

Ordinary [live validation](./LIVE-VALIDATION.md) answers "does this runtime work right now?" in a single short turn. Long-horizon validation answers a different question:

> "Over the next 15 minutes / hour, does the agent eventually do X — and was X correct?"

The motivating example is "does a goal survive auto-compaction?", but the mechanism is deliberately **function-agnostic**: it watches for *any* declared condition, not compaction specifically.

## The two layers

Long-horizon validation is split into two cleanly separated parts.

### 1. The Watch — a durable, server-side observer (Internal API)

A **watch** is a standing subscription the server keeps on a session. It evaluates declarative conditions against the common `NormalizedEvent` stream and appends every match to a **disk-backed ledger**. The ledger survives:

- the observer disconnecting (nobody needs to hold `/events` open),
- the session going idle,
- a full **server restart** (already-recorded firings are reloaded from disk).

This is the load-bearing idea: it **decouples observation from the observer's liveness** while the server instance remains up. A validator can register a watch, walk away for an hour, then ask "what fired while I was gone?" in one cheap request. A server restart preserves the ledger but requires explicit watch re-registration for future events.

The restart guarantee is deliberately narrower than automatic watch recovery:
when the server boots, an `active` watch is reloaded as `detached`. Its past
firings and snapshot remain readable, but it has no live broker subscription and
records no new events until the caller re-registers the watch. Treat a restart
as an evidence boundary: preserve the old ledger, then register a new watch
before continuing. The current CLI does not re-register or merge the old
firing-count/state automatically; use a new runner/state file (or a custom
Internal-API client that explicitly reconciles the two ledgers) rather than
claiming uninterrupted observation.

Because conditions match on the runtime-neutral `NormalizedEvent` shape, the watch needs **zero per-runtime code** — it works the same across Pi, Claude, OpenCode, and Antigravity.

### 2. The Runner — a headless, restart-tolerant evidence collector

The [`validate:long-horizon`](#cli) runner drives a real **subject** session through the Internal API and polls the watch on an interval. It never blocks on the subject: it dispatches work, then sleeps and polls. Because progress is split between the durable ledger and a private run-state file, the runner can be a long-lived daemon **or** exit and be re-launched by cron between polls without losing already-recorded evidence. If the **server** restarts, the next check will see `detached`; it does not re-register or reconcile ledgers automatically. Preserve the old run-state as evidence, register a new watch, and start a new runner/state (or implement explicit reconciliation in a custom client) before expecting new firings. Without that recovery, a long-horizon run preserves past evidence but does not observe new events after the restart.

The "hour" in a long-horizon test is just `pollInterval × N` — the loop logic is identical whether N polls span seconds or hours.

## Why this split

The waiting is a **scheduler** concern, and a scheduler belongs in the validator's own process, not inside any agent harness. Keeping the durable watch on the server (where runtime complexity belongs) and the pacing in a plain headless client (which you fully control) means:

- the watch primitive benefits *every* Internal API consumer, not just this feature;
- the validator is runtime/harness-agnostic — the waiting is done by a timer or cron, not by an LLM burning context for an hour;
- no Pi extension, compaction hook, or session-persistence shim is required.

## Watch API

All endpoints are additive under `/api/v1` (watch support was introduced in
contract `1.1.0`; the current published contract is `1.9.0`). There is one watch
per session.

### Register a watch

```
POST /api/v1/sessions/:sessionId/watch
```

```json
{
  "conditions": [
    { "id": "sentinel", "type": "text", "contains": "GOAL-OK" },
    { "type": "event_type", "eventType": "session_compaction" },
    { "type": "tool", "toolName": "Bash", "phase": "end", "argIncludes": "PASS" }
  ],
  "pin": true,
  "label": "goal-survives-compaction"
}
```

Registering **pins the subject by default** so idle/timeout eviction can't kill it while the validator sleeps. This watch pin uses the runtime's watch pin path and is not the time-bounded Internal-API pin ledger; deleting the watch does not unpin the session. Explicitly unpin or delete the subject when finished. Returns the full watch object (`201`). A bad regex or an empty `conditions` array returns `400`.

> **Pinning is also available standalone**, without a watch. If you only need a
> session to survive cleanup for a long task — and don't need durable condition
> detection or interval polling — use `pin:true` on `POST /sessions` (or
> `control {action:"pin"}`) instead of the watch machinery. API pins are
> time-bounded (default 24h, max 7d, renewable) and auto-revoked. See
> [Session Pinning](./INTERNAL-API.md#session-pinning-persistent-time-bounded).
> Note: deleting a watch does **not** unpin — pin and watch are separate primitives.

### Condition types (generic / function-agnostic)

| `type` | Matches when… | Key fields |
|---|---|---|
| `event_type` | a `NormalizedEvent.type` equals `eventType` | `eventType`, optional `dataMatch` (shallow equality on `event.data`) |
| `tool` | a tool call matches | `toolName`, `phase` (`start`\|`end`, default `start`), optional `argIncludes` substring on args/result |
| `text` | assistant (or any) text matches | `contains` substring **or** `pattern`+`patternFlags` regex; `source` (`assistant` default \| `any`) |

Common fields: `id` (auto-assigned `c0`, `c1`, … if omitted), `once` (default `true` — fire once; set `false` to record every match, capped).

Text matching accumulates streamed deltas across a turn, so a substring or regex that spans multiple `message_update` events is matched correctly. The buffer resets at each turn boundary.

> Anything reachable as a normalized event is reachable here: `agent_end`, `session_compaction`, `permission_request`, `stream_activity`, etc. The engine intentionally ships only three primitives rather than one switch per feature.

### Poll a watch

```
GET /api/v1/sessions/:sessionId/watch
GET /api/v1/sessions/:sessionId/watch?sinceIndex=4
```

Returns the watch with its `conditions` (each with `fired`/`fireCount`/timestamps), the append-only `firings` ledger, a `firingCount`, `pendingConditionIds`, `allFired`, and a lightweight event-derived `snapshot` (status, `eventCount`, `toolCallCount`, `sawAgentEnd`, last event). `?sinceIndex=N` returns only firings after the caller's last poll; `firingCount` stays the absolute total so the caller can compute its next `sinceIndex`.

`status` is `active` (live subscription attached), `detached` (reloaded from disk after a restart — past firings readable, new ones not recorded until re-registered), or `closed`.

`404 WATCH_NOT_FOUND` if no watch is registered for the session.

### Delete a watch

```
DELETE /api/v1/sessions/:sessionId/watch
```

Tears down the subscription and removes the ledger.

## Safety contract: disposable server first

Long-horizon validation must not use the running production Web UI by default. The subject may run for minutes or hours, may be pinned, and may register durable watches, so it must live on an isolated validation server unless the user explicitly asks to target production.

Default rule:

- boot `npm run validate:server`
- pass `--socket <validation-socket>` and `--token-path <validation-token>` to every `validate:long-horizon` command, including later `--mode once` checks
- do not use the default `~/.pi-web-ui/internal-api.sock`
- do not stop, restart, or redeploy `pi-web-ui.service` as part of validation unless the user explicitly requested production service control

The CLI refuses to target the default production Internal API unless `--allow-production` is supplied.

## CLI

```bash
npm run validate:long-horizon -- [options]
```

Build conditions from repeatable shorthand flags (combined) or full JSON:

| Flag | Meaning |
|---|---|
| `--watch-event <type>` | an `event_type` condition |
| `--watch-tool <name>` | a `tool` condition |
| `--watch-text <substr>` | a `text` (contains) condition |
| `--watch-json '<json>'` | a full `WatchConditionSpec[]` for advanced predicates |

Subject / behaviour:

| Flag | Default | Meaning |
|---|---|---|
| `--subject <runtime>` | `pi` | create a fresh subject of this runtime |
| `--session <id>` | — | attach to an existing subject instead |
| `--model <id>` | runtime default | model to use when creating a fresh subject. For Claude this may be a base alias such as `sonnet` or a profile-backed entry such as `profile:glm52-claude-sdk`. |
| `--seed "<prompt>"` | — | initial prompt to drive the subject (dispatched without blocking) |
| `--stop all\|any` | `all` | succeed when all (or any) target condition fires |
| `--interval <seconds>` | `30` | poll cadence |
| `--max-wait <seconds>` | `3600` | absolute time budget |
| `--probe "<prompt>"` | — | on success, ask the subject this and capture its answer |
| `--mode daemon\|start\|once` | `daemon` | see below |
| `--state <path>` | auto | run-state file (required for `--mode once`) |
| `--keep` | off | keep a runner-created subject after finishing |
| `--keep-watch` | off | keep the server-side watch ledger after success/failure so evidence remains queryable via `GET /watch` |
| `--socket` / `--token-path` | required unless `--allow-production` | point at the disposable validation server |
| `--allow-production` | off | explicitly permit targeting the running production Web UI Internal API |
| `--json` | off | emit final run-state JSON on stdout |

### Modes

- **`daemon`** (default) — start, then poll on a timer until success, timeout, or process exit. Long-lived; easiest to run and watch.
- **`start`** — create subject + watch + seed, persist run-state, and exit. Hand off to a scheduler.
- **`once`** — run a single poll against an existing `--state` file and exit (`0` passed, `2` still running, `1` timeout/failed). This is the cron building block: OS cron re-fires `--mode once` on a schedule; all progress lives in the run-state file + the durable watch.

Because a seed dispatched in `start` mode continues server-side after the process exits, a later `once` invocation reliably observes its result — the validator process is genuinely disposable between polls.

### Example

```bash
# Drive a Pi subject on a disposable validation server, succeed when it both
# runs Bash and reports PASS, polling every 5s for up to 2 minutes.
# Terminal A / background task:
VALIDATION_DIR="$(mktemp -d /tmp/pi-web-ui-lh-XXXXXX)"
npm run validate:server -- --dir "$VALIDATION_DIR" --port 0 \
  >"$VALIDATION_DIR/server.log" 2>&1 &
# Terminal B: export/replace VALIDATION_DIR with the same directory, then:
PI_WEB_UI_WAIT_SOCKET="$VALIDATION_DIR/internal-api.sock" npm run internal-api:wait
npm run validate:long-horizon -- \
  --socket "$VALIDATION_DIR/internal-api.sock" \
  --token-path "$VALIDATION_DIR/internal-api-token" \
  --subject pi \
  --seed "Run the test suite and tell me if it passed." \
  --watch-tool Bash \
  --watch-text PASS \
  --interval 5 --max-wait 120
```

```bash
# In the same shell, drive a Claude subject through an explicit provider profile.
npm run validate:long-horizon -- \
  --socket "$VALIDATION_DIR/internal-api.sock" \
  --token-path "$VALIDATION_DIR/internal-api-token" \
  --subject claude \
  --model profile:glm52-claude-sdk \
  --seed "Work until you can truthfully say LONG_HORIZON_OK." \
  --watch-text LONG_HORIZON_OK \
  --keep-watch \
  --interval 10 --max-wait 900
```

## Validating without disturbing the running server

Live validation should never touch the user's running server, web UI, or real
session data unless explicitly requested. Boot a **disposable validation server** instead:

```bash
npm run validate:server          # prints an isolated socket + token; stays up
npm run validate:server -- --port 3092
```

It isolates the port, Unix socket, API token, runtime companion ports, Pi
session directory, session registry, watch dir, and Claude session dir under the
explicit `--dir` (or a short auto-created `/tmp/pi-web-ui-validation/run-*`
directory). It boots in **validation mode** (`PI_WEB_UI_VALIDATION_MODE=true`),
which **disables session cleanup** and skips the real-session registry rebuild,
so boot does not delete or import real Pi session state. This is not a full
preference/credential boundary: `PI_AGENT_DIR` remains the normal agent directory for auth/models/resources
unless the caller overrides it, and the
preferences file derived from that directory is not isolated by default. A
long-horizon API run does not use preference routes, but custom clients must not
mutate archive/pin/rename state unless they explicitly provision a disposable
`PI_AGENT_DIR` and runtime setup.

Pi sessions created by the runner use the validation session directory and are
ephemeral; the runner deletes them unless `--keep` is requested. Antigravity is
disabled in this disposable mode because `agy` has no supported
conversation-data directory override; an authorised Antigravity check must
record that it may touch the real `~/.gemini` state.

Point the runner (or any Internal API client) at the printed paths. This is not optional for normal validation; the CLI will refuse to use production defaults without `--allow-production`. Pass the socket and token again on every later `--mode once` invocation:

```bash
npm run validate:long-horizon -- \
  --socket "$VALIDATION_DIR/internal-api.sock" \
  --token-path "$VALIDATION_DIR/internal-api-token" \
  --subject pi --seed "…" --watch-text DONE --interval 5 --max-wait 120
```

Then kill the validation-server process and remove the validation directory when the run is complete. If you used `--mode start`, keep the validation server running until all later `--mode once` checks have reached a final verdict.

## Runtime support

The watch engine is runtime-agnostic, but the *conditions you can usefully write* depend on what a runtime emits:

- **Pi** — best subject for event-rich conditions; emits clean `session_compaction`, tool, and message events.
- **Claude / OpenCode** — full event streams; good subjects. For Claude, you can target either a base alias model or a specific provider/backend route with `--model profile:<id>`. (Claude channel `/events` reliability caveats for *parallel* fan-out still apply, but a long-horizon watch is a single standing server-side subscriber, not a held client stream, so it is not affected the same way.)
- **Antigravity** — works as a subject for coarse conditions (`agent_end`, text); subprocess-per-turn means fewer fine-grained events.

The **validator** (the runner) is plain headless code — it is not tied to any runtime or harness. Use whichever runtime fits the *subject* you want to test.

## Production validation exception

Use production only when the user clearly asks for it, for example "validate this against my running Web UI". In that case, add `--allow-production`, record that you intentionally targeted production in your report, avoid destructive cleanup, and do not restart/stop/redeploy the service unless separately requested.

## Limitations

- One watch per session.
- Conditions evaluate against normalized events only; a runtime that doesn't surface a behaviour as an event can't have it watched (observe it another way).
- A `detached` watch (post-restart) does not auto-resubscribe — re-register to resume live recording. Past firings remain readable.
- The ledger caps firings per condition and per watch to stay bounded under `once: false`.

## Related docs

- [`INTERNAL-API.md`](./INTERNAL-API.md) — full endpoint reference
- [`INTERNAL-API-ORCHESTRATION.md`](./INTERNAL-API-ORCHESTRATION.md) — multi-session orchestration patterns
- [`INTERNAL-API-CONTRACT.md`](./INTERNAL-API-CONTRACT.md) — versioning/compatibility
- [`LIVE-VALIDATION.md`](./LIVE-VALIDATION.md) — single-turn live validation
