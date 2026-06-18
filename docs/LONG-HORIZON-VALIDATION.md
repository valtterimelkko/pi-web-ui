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
- a full **server restart** (the ledger is reloaded from disk).

This is the load-bearing idea: it **decouples observation from the observer's liveness**. A validator can register a watch, walk away for an hour, then ask "what fired while I was gone?" in one cheap request.

Because conditions match on the runtime-neutral `NormalizedEvent` shape, the watch needs **zero per-runtime code** — it works the same across Pi, Claude, OpenCode, and Antigravity.

### 2. The Runner — a headless, resumable validator

The [`validate:long-horizon`](#cli) runner drives a real **subject** session through the Internal API and polls the watch on an interval. It never blocks on the subject: it dispatches work, then sleeps and polls. Because all progress lives in the durable ledger plus a small run-state file, the runner can be a long-lived daemon **or** exit and be re-launched by cron between polls and lose nothing.

The "hour" in a long-horizon test is just `pollInterval × N` — the loop logic is identical whether N polls span seconds or hours.

## Why this split

The waiting is a **scheduler** concern, and a scheduler belongs in the validator's own process, not inside any agent harness. Keeping the durable watch on the server (where runtime complexity belongs) and the pacing in a plain headless client (which you fully control) means:

- the watch primitive benefits *every* Internal API consumer, not just this feature;
- the validator is runtime/harness-agnostic — the waiting is done by a timer or cron, not by an LLM burning context for an hour;
- no Pi extension, compaction hook, or session-persistence shim is required.

## Watch API

All endpoints are additive under `/api/v1` (contract `1.1.0`). One watch per session.

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

Registering **pins the subject by default** so idle/timeout eviction can't kill it while the validator sleeps. Returns the full watch object (`201`). A bad regex or an empty `conditions` array returns `400`.

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
| `--seed "<prompt>"` | — | initial prompt to drive the subject (dispatched without blocking) |
| `--stop all\|any` | `all` | succeed when all (or any) target condition fires |
| `--interval <seconds>` | `30` | poll cadence |
| `--max-wait <seconds>` | `3600` | absolute time budget |
| `--probe "<prompt>"` | — | on success, ask the subject this and capture its answer |
| `--mode daemon\|start\|once` | `daemon` | see below |
| `--state <path>` | auto | run-state file (required for `--mode once`) |
| `--keep` | off | keep a runner-created subject after finishing |
| `--socket` / `--token-path` | defaults | point at a specific Internal API instance |
| `--json` | off | emit final run-state JSON on stdout |

### Modes

- **`daemon`** (default) — start, then poll on a timer until success, timeout, or process exit. Long-lived; easiest to run and watch.
- **`start`** — create subject + watch + seed, persist run-state, and exit. Hand off to a scheduler.
- **`once`** — run a single poll against an existing `--state` file and exit (`0` passed, `2` still running, `1` timeout/failed). This is the cron building block: OS cron re-fires `--mode once` on a schedule; all progress lives in the run-state file + the durable watch.

Because a seed dispatched in `start` mode continues server-side after the process exits, a later `once` invocation reliably observes its result — the validator process is genuinely disposable between polls.

### Example

```bash
# Drive a Pi subject, succeed when it both runs Bash and reports PASS,
# polling every 5s for up to 2 minutes.
npm run validate:long-horizon -- \
  --subject pi \
  --seed "Run the test suite and tell me if it passed." \
  --watch-tool Bash \
  --watch-text PASS \
  --interval 5 --max-wait 120
```

## Validating without disturbing the running server

Live validation should never touch the user's running server, web UI, or real
session data. Boot a **disposable validation server** instead:

```bash
npm run validate:server          # prints an isolated socket + token; stays up
npm run validate:server -- --port 3092
```

It is fully isolated — separate port, Unix socket, API token, session registry,
watch dir, and Claude/Antigravity session dirs (all under
`~/.pi-web-ui/validation/`) — and it boots in **validation mode**
(`PI_WEB_UI_VALIDATION_MODE=true`), which **disables session cleanup** and skips
the real-session registry rebuild. That combination is what guarantees booting
it can't delete or mutate real session data (the destructive default-server
behaviour that auto-removes >90-day archived sessions does not run here).

Pi keeps its real agent dir for auth/models; any Pi sessions created during a
run are ephemeral and the runner deletes them.

Point the runner (or any Internal API client) at the printed paths:

```bash
npm run validate:long-horizon -- \
  --socket ~/.pi-web-ui/validation/internal-api.sock \
  --token-path ~/.pi-web-ui/validation/internal-api-token \
  --subject pi --seed "…" --watch-text DONE --interval 5 --max-wait 120
```

Then kill the validation-server process and remove `~/.pi-web-ui/validation/`.

## Runtime support

The watch engine is runtime-agnostic, but the *conditions you can usefully write* depend on what a runtime emits:

- **Pi** — best subject for event-rich conditions; emits clean `session_compaction`, tool, and message events.
- **Claude / OpenCode** — full event streams; good subjects. (Claude channel `/events` reliability caveats for *parallel* fan-out still apply, but a long-horizon watch is a single standing server-side subscriber, not a held client stream, so it is not affected the same way.)
- **Antigravity** — works as a subject for coarse conditions (`agent_end`, text); subprocess-per-turn means fewer fine-grained events.

The **validator** (the runner) is plain headless code — it is not tied to any runtime or harness. Use whichever runtime fits the *subject* you want to test.

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
