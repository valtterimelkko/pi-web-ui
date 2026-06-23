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
3. **One prompt's whole story:** every log line for a prompt shares a
   `requestId` + `sessionId` — `grep <requestId>` (or filter JSON logs) to get
   the full causal chain.
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

The `no-console` ESLint rule is **error** for `server/src/**` (Task 22), so the
~330-call `console.*` sprawl cannot regrow. `workers/crash-logger.ts` is the one
documented exception (it owns its own console output as the structured-log
precedent).

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
case-insensitive (default: off). When set, **only** matching components emit;
all others are suppressed. Combine with `LOG_LEVEL=debug` for full detail on one
subsystem.

```bash
DEBUG=ClaudeService            # only ClaudeService
DEBUG=claude*                  # all Claude components (ClaudeService, ClaudeChannel*, ClaudeSdkService, …)
DEBUG=claude,opencode* LOG_LEVEL=debug
```

Canonical components (the names actually used in code): `AntigravityService`,
`Auth`, `ClaudeChannel`, `ClaudeChannelService`, `ClaudeEventNormalizer`,
`ClaudeProfiles`, `ClaudeProcessPool`, `ClaudeSdkService`, `ClaudeService`,
`Config`, `Connection`/`WebUI`, `EventForwarder`, `Extensions`, `Fatal`,
`Files`, `Health`, `InternalAPI`, `JSONRPCToRPCConverter`, `MergeCoordinator`,
`Models`, `MultiSessionManager`, `OpenCodeProcessManager`, `OpenCodeService`,
`OpenCodeSSE`, `PiService`, `Preferences`, `RPCProtocolBridge`, `Server`,
`SessionCleanup`, `SessionOrchestrator`, `SessionPool`, `SessionRegistry`,
`SessionRPCClient`, `SessionWatcher`, `SessionWebSocket`, `Stt`, `TerminalManager`,
`Transfer`, `Tts`, `Usage`, `Worktrees`.

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

Every prompt's lifecycle log lines share one `requestId` and carry the
`sessionId` + `runtime`, stamped via an `AsyncLocalStorage` context
(`server/src/logging/correlation.ts`). The Internal API request-logging
middleware allocates the `requestId` and the prompt path (`handleSendPrompt`)
reuses it, so the request log, the prompt dispatch/complete logs, and any
runtime logs emitted in-process on the same async chain all share the id.

```bash
# Send a prompt at json+debug, then reconstruct its whole lifecycle by id:
LOG_FORMAT=json LOG_LEVEL=debug npm run validate:server -- --dir /tmp/v …
grep '"requestId":"req_…' /tmp/v-server.log
```

> **Caveat:** the correlation context propagates across `await` boundaries
> **in-process**. The Pi Coding Agent runs its model turn in a **worker process**,
> so Pi's in-turn worker logs do not carry the `requestId` (the in-process
> request/dispatch/complete logs do). Claude/OpenCode/Antigravity turns are more
> in-process, so their adapter logs correlate more fully.

## Diagnostics

Self-service recent logs over the Internal API (no `journalctl` needed). A
bounded in-memory ring buffer captures recent structured log lines, secret-scrubbed
on push (tokens/passwords/`Bearer …`/`sk-…`/sensitive keys → `[REDACTED]`;
`requestId`/`sessionId` preserved). See [`INTERNAL-API.md`](./INTERNAL-API.md).

```
GET /api/v1/diagnostics                       # recent logs + errors + summary
GET /api/v1/siagnostics?limit=200&minLevel=warn
GET /api/v1/sessions/:sessionId/diagnostics   # scoped to one session
```

Authed like every other internal-api route (only `/health` is exempt).

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
