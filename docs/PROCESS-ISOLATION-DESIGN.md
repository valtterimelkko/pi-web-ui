# Process Isolation Design

> Design record for the **Pi Coding Agent worker architecture** in Pi Web UI. This document is intentionally focused on the Pi worker/process model, not the Claude runtime family or OpenCode paths.

## Why This Doc Exists

Pi Web UI supports four runtime paths, but only one of them uses the repo's full **process-per-session worker architecture**:

- **Pi Coding Agent** → yes, this doc applies directly
- **Claude runtime** → no, uses either `claude -p` subprocesses per turn or the channel-backed Claude Code path
- **OpenCode** → no, uses a long-lived `opencode serve` backend
- **Antigravity** → no, uses `agy -p` subprocesses per turn plus Pi-owned JSONL turn logs

For the broader multi-runtime architecture, see [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Problem the Design Solves

The Pi Coding Agent path originally faced classic single-process problems:
- memory accumulation during heavy streaming/tool use
- whole-server instability when one session misbehaved
- weak isolation between sessions
- unpredictable pauses under pressure

The solution was to isolate Pi Coding Agent session work behind worker/session lifecycle management instead of letting all session work pile up in one shared process context.

## Scope of This Design

This document covers:
- Pi worker lifecycle
- worker memory limits
- worker pool behaviour
- session isolation on the Pi Coding Agent path
- crash and stale-session recovery patterns for Pi-managed workers

It does **not** cover:
- Claude runtime replay/session-file details
- OpenCode HTTP/SSE integration details

## High-level Pi Coding Agent Worker Model

```text
Browser
  -> WebSocket router
    -> Pi session manager
      -> worker pool
        -> one Pi worker/session execution context per active session
```

Key files:
- `server/src/pi/multi-session-manager.ts`
- `server/src/workers/worker-pool.ts`
- `server/src/workers/session-rpc-client.ts`
- `server/src/workers/rpc-protocol-bridge.ts`
- `server/src/workers/event-normalizer.ts`

## Design Goals

- isolate Pi session failures from other sessions
- bound memory use per worker/session path
- keep session state restorable from Pi session storage
- allow background sessions and reconnects
- make worker crashes recoverable instead of catastrophic

## Core Decisions

### 1. Pi Coding Agent work is lifecycle-managed separately from the main server

The main server should remain the control plane.
The Pi worker/session layer does the heavy runtime work.

### 2. Session state survives worker churn

The durable source of truth for Pi Coding Agent sessions remains:
- `~/.pi/agent/sessions/`

This allows worker cleanup/restart without losing the underlying session transcript/state.

### 3. Worker capacity is bounded

The server enforces practical limits through environment variables such as:
- `PI_MAX_WORKERS`
- `PI_WORKER_MEMORY`
- `PI_IDLE_TIMEOUT`

### 4. Idle and stale sessions are cleaned up unless explicitly protected

The Pi session manager handles:
- idle timeout cleanup
- stale-stream reset logic
- pinning protection for important sessions

## What the Main Server Still Does

Even with worker isolation, the main server remains responsible for:
- auth and security checks
- WebSocket routing
- session registry updates
- fanout to multiple browser subscribers
- runtime selection between Pi / Claude / OpenCode / Antigravity

## Failure Handling Philosophy

### Pi worker crash
Expected outcome:
- only that Pi session path is affected
- the main web server stays up
- session state can be reloaded from durable storage

### Memory pressure
Expected outcome:
- worker limits constrain blast radius
- capacity/health endpoints help operators see when the system is strained

### Browser disconnect
Expected outcome:
- sessions can continue running
- reconnecting clients can replay/rejoin state
- pinned sessions remain protected from normal cleanup rules

## Relationship to Other Runtime Paths

### Claude runtime
The Claude runtime family has a separate design because it uses either legacy `claude -p` subprocesses or the newer channel-backed Claude Code path, plus Pi-owned replay storage.
See:
- `server/src/claude/`
- [`docs/CLAUDE-BACKENDS.md`](./CLAUDE-BACKENDS.md)

### OpenCode
OpenCode has a separate design because it is built around a long-lived OpenCode backend and HTTP/SSE integration.
See:
- `server/src/opencode/`
- [`docs/OPENCODE-DIRECT-INTEGRATION.md`](./OPENCODE-DIRECT-INTEGRATION.md)

## Operational Notes

When debugging Pi-worker issues, start with:
- `server/src/pi/multi-session-manager.ts`
- `server/src/workers/worker-pool.ts`
- `/api/health/ready`
- `/api/health/workers`

Typical symptoms of Pi worker problems:
- worker spawn failures
- worker capacity exhaustion
- stuck or stale streaming on Pi sessions
- worker OOM / crash loops

## Related Docs

- [`../README.md`](../README.md)
- [`./ARCHITECTURE.md`](./ARCHITECTURE.md)
- [`../DEPLOYMENT.md`](../DEPLOYMENT.md)
