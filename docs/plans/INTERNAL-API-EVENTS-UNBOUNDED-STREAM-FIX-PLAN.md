# `GET /sessions/:id/events` is unbounded, and nothing tells a client so

> **RESOLVED 2026-08-23** — commit `4c4c599` (contract 1.24.0). Added `?mode=snapshot` (bounded request/response read of the replay buffer) and `?timeout=<ms>` (bounded stream closing with `complete {reason:"timeout"}`, clamp `[0,300000]`); docs now mark the bare endpoint as an unbounded SSE stream in every monitoring table and evidence ladder. Live validation also exposed and fixed a second pre-existing defect: Pi sessions received **zero** events on `/events` because publishers key the broker under the registry path while this handler subscribed under the id. Everything below is retained as historical evidence.

_Authored 2026-08-23 from a real failure in an external consumer. Class: **plan/history** — design and implementation evidence, not current behaviour. Current behaviour is in `docs/INTERNAL-API.md` and the route schema._

## Bottom line

`GET /api/v1/sessions/:id/events` is a deliberately infinite SSE subscription that ends **only when the client disconnects**. That is correct for a browser `EventSource`. For any client that issues a plain HTTP GET and waits for a body — a CLI, a script, an agent inside a shell tool call — it is indistinguishable from a hang, and a 15-second heartbeat guarantees no idle timeout will ever rescue it.

On 2026-08-22 an Agent OS harness agent called this endpoint inside a bash tool call to inspect a stalled child session. The request never returned and was aborted after **more than 9,000 seconds** — roughly two and a half hours of a working agent's time, spent on an endpoint that was behaving exactly as designed.

The endpoint is not wrong. The **contract around it is**: it is presented in monitoring tables beside bounded request/response endpoints, with nothing marking it as a stream that never ends, and there is no bounded read mode for clients that cannot consume one.

## Evidence

### The stream has no server-side deadline

`server/src/internal-api/routes/sessions.ts:3713` — `handleSessionEvents` opens the SSE stream, subscribes to the per-session broker, and then:

```ts
await new Promise<void>((resolve) => {
  const cleanup = () => { unsub(); unregisterDispose(); resolve(); };
  sse.res.on('close', cleanup);
  sse.res.on('error', cleanup);
  req.on('aborted', cleanup);
  req.on('error', cleanup);
});
```

Every resolution path is a **client-side** disconnect. There is no timeout, no maximum duration, no completion condition, and no way to ask for a bounded slice.

### The heartbeat removes the last accidental escape hatch

`server/src/internal-api/sse-stream.ts:41` writes `:heartbeat\n\n` every 15,000 ms. The socket therefore never goes idle, so client- and proxy-side idle timeouts — the thing that would normally cut a forgotten connection loose — never fire. The connection stays healthy indefinitely, which is precisely the intent for a browser and precisely the trap for everything else.

### The correct pattern already exists, one function below

`handleSessionWait` (immediately after `handleSessionEvents` in the same file) does exactly what is missing:

```ts
const timeoutMs = Math.min(Math.max(parseInt(query.get('timeout') || '60000', 10), 0), 300000);
```

It bounds itself, caps the bound, and returns an honest `status: 'timeout'` rather than hanging. `/events` needs the same treatment; this is not a new idea in this codebase, just an unapplied one.

### The documentation reads as if it returns

None of these say "this never ends":

- `docs/INTERNAL-API-ORCHESTRATION.md:337` — a task table row: *Watch live progress → `/sessions/:id/events`*, sitting directly above *Wait for completion safely → `/sessions/:id/wait`*, which **is** bounded.
- `docs/INTERNAL-API-ORCHESTRATION.md:388` — a numbered recipe, `6. GET /sessions/:id/events # monitor live where appropriate`. Rendered as step six of a sequence, this is an open invitation to put it in a shell command.
- `docs/INTERNAL-API.md:1519` and `docs/TROUBLESHOOTING.md:249` — both list it as a monitoring option alongside request/response endpoints.

A reader following the evidence ladder in `TROUBLESHOOTING.md` to diagnose a stalled child hits this endpoint at exactly the moment they are least able to afford a two-hour stall.

## Fix direction

Three changes, smallest first. The first two are additive and change no existing client's behaviour.

### 1. A bounded snapshot mode *(highest value for the failure that happened)*

The broker already retains a replay buffer (`replayBufferSize: 100`, `sessions.ts:443`). Expose it as a request/response read — something like `?mode=snapshot` — returning the buffered events as JSON and closing. This is what the Agent OS agent actually wanted: *what has happened on this session so far*, not a live subscription. Today there is no way to ask for that.

### 2. An optional bounded stream

`?timeout=<ms>`, capped as `/wait` caps it, after which the server closes the stream cleanly with a terminal event naming the reason. A client that asks for a bound gets one; a browser that asks for nothing keeps today's behaviour exactly.

### 3. Documentation that cannot be misread

Wherever the endpoint appears in a monitoring or evidence table, mark it unambiguously as an **unbounded SSE stream — for streaming clients only**, and point non-streaming callers at the snapshot mode, `/wait`, or `/transcript`. Per `DOCS-GOVERNANCE.md`, the contract/reference and the troubleshooting evidence ladder both need the change, not just one of them.

## Quality gates

- **TDD.** Write the failing test first: a non-streaming client requesting the bounded mode must receive a response and a closed connection within the bound. That test must be RED before the fix exists — this defect is precisely the kind that a test written afterwards will assert into the shape of whatever was built.
- **No regression for streaming clients.** A request with no new parameters must behave byte-for-byte as today: same headers, same `:ok` flush, same 15s heartbeat, same close-on-disconnect semantics. Prove it, do not assert it.
- **Disposal path intact.** The `disposal.register(..., 'sse-events-stream', ...)` handle exists so a deleted session closes its stream. Any new exit path must unregister exactly as the current one does, or a deleted session leaks a stream and a timer.
- **Command Code, Pi, OpenCode and Claude-backed sessions** all resolve through this handler; a fix proven on one runtime is not proven.
- Contract version and capability metadata updated if the surface changes, per the documentation impact checklist.

## Coordination — read before deploying

**The code change is safe to make at any time. The service restart is not.**

Agent OS is mid-execution on a step (`MEM-2a`) whose live proofs dispatch real children through this Internal API and hold durable retention leases. Restarting the server kills in-flight sessions and any lease they depend on, and a harness run lost near its end is expensive to reproduce.

So: develop, test and commit freely — but **confirm no Agent OS harness session is in flight before restarting or deploying**. The consumer-side symptom is already mitigated (that agent has stopped calling the endpoint and uses `/transcript` instead), so there is no urgency that justifies taking the runtime out from under a running measurement.

## Provenance

Reported by the Agent OS `MEM-2a` execution agent, 2026-08-22/23, while inspecting a child session that had been terminated by the runtime's `TURN_STALLED` watchdog. The transcript endpoint was used successfully instead and showed nothing anomalous. No fix, workaround or configuration change was applied to this repository by that agent; this document is the entire handover.
