# Internal API Orchestration Guide

> Task-oriented guide for using Pi Web UI's Internal API as a local
> multi-agent orchestration surface.
>
> Read [`INTERNAL-API.md`](./INTERNAL-API.md) for the canonical endpoint
> reference. Read this guide when you want to spawn child sessions across
> runtimes, monitor them, collect their results, and hand context between
> them.

## What this guide is for

Use this guide when a **parent agent** or local automation process wants to:
- choose different runtimes/models for different subtasks
- create several child sessions in parallel
- monitor progress while those children work
- collect transcripts/results in one common format
- transfer useful context from one child into another session
- sum usage/cost across the children

Typical example:
- a Pi SDK parent agent receives a large coding task
- it decides planning is best on Claude, code generation is best on OpenCode,
  and a comparative check is best on Antigravity
- it creates one child session on each runtime
- it prompts them independently
- it monitors them, gathers their results, and continues the parent task with
  the combined output

## What the Internal API can do today

Across the four runtime paths, the current Internal API can now cover the
full Tier-1 orchestration loop:

1. **Discover** — `GET /capabilities`, `GET /models`
2. **Provision** — `POST /sessions`, `POST /sessions/batch`
3. **Prepare** — `POST /sessions/:id/control`
4. **Dispatch** — `POST /sessions/:id/prompt`, `POST /sessions/batch/prompt`
5. **Monitor** — `GET /sessions/:id/events`, `GET /sessions/:id/wait`
6. **Extract** — `GET /sessions/:id/transcript`, `GET /sessions/:id/history`
7. **Transfer** — `POST /sessions/:id/transfer`
8. **Aggregate** — `POST /sessions/usage`
9. **Teardown** — `POST /sessions/:id/abort`, `DELETE /sessions/:id`

## What is still missing

These are the main limitations to keep in mind when designing orchestrators:

- **No parent/child metadata model yet** — the API does not expose
  `parentSessionId`, `orchestrationId`, or `GET /sessions?parent=...`.
  You must track those relationships yourself.
- **No async job id layer yet** — the API is session-oriented, not job-oriented.
- **No true pending-approvals list yet** — use `/events` to observe permission
  requests live; `GET /approvals/pending` is currently informational.
- **Claude channel `/events` caveat** — see below.

## Recommended orchestration flow

### 1. Discover runtimes and capabilities first

Always start by asking the server what is available now.

- `GET /api/v1/capabilities`
- `GET /api/v1/models`

This lets you decide:
- which runtimes are installed and healthy
- whether a runtime supports follow-up, replay, approvals, or thinking level
- which models are currently available without restarting the server

### 2. Create child sessions

For one child:
- `POST /api/v1/sessions`

For many children at once:
- `POST /api/v1/sessions/batch`

Track the returned `sessionId`s in your own orchestrator state, because the
API does not yet store parent-child relationships for you.

### 3. Prepare child sessions if needed

Use `POST /api/v1/sessions/:id/control` to do things like:
- switch model
- set thinking level
- pin a session

Do this before dispatching long work if the runtime supports the setting you
care about.

### 4. Dispatch prompts

There are two main patterns:

### Pattern A — final-answer oriented
Use:
- `POST /api/v1/sessions/:id/prompt` with `verbosity=answers`
- or `POST /api/v1/sessions/batch/prompt`

This is best when you only need final answers and do not care about live
progress.

### Pattern B — orchestration-oriented
Use:
- `POST /api/v1/sessions/:id/prompt`
- plus either `GET /api/v1/sessions/:id/events` or
  `GET /api/v1/sessions/:id/wait`

This is best when you want to supervise long-running children or decide what
to do mid-flight.

### 5. Monitor child progress

### Best default for live progress
- `GET /api/v1/sessions/:id/events`

Use this when you want normalized event streaming similar to what the web UI
sees.

### Safe fallback when live SSE is not the right choice
- `GET /api/v1/sessions/:id/wait?status=idle&timeout=...`

Use this when:
- you want a simpler orchestration loop
- you are supervising many children and do not need every event
- you are using Claude channel-backed children in parallel

### 6. Read results back

### Preferred default
- `GET /api/v1/sessions/:id/transcript`

This gives you a runtime-agnostic output format and is usually the best way to
consume child results.

### Lower-level alternative
- `GET /api/v1/sessions/:id/history`

Use this when you need replay/event-like detail closer to what the UI rebuilds.

### 7. Transfer context between sessions

Use:
- `POST /api/v1/sessions/:id/transfer`

This mirrors the web UI's own transfer flow. You can:
- transfer into an existing target session
- create a fresh target session as part of the transfer
- choose `visible_recent` or `visible_full`

This is the cleanest way to hand a child session's visible context into the
next runtime without inventing your own transcript framing.

### 8. Aggregate usage

Use:
- `POST /api/v1/sessions/usage`

This is useful when a parent agent wants to compare cost/usage across children
or decide whether to continue with a more expensive runtime.

### 9. Tear children down

Use:
- `POST /api/v1/sessions/:id/abort` to stop a running child
- `DELETE /api/v1/sessions/:id` to remove a child from the registry

## Which endpoint should I use?

| Need | Best endpoint |
|---|---|
| Discover what is available | `/capabilities`, `/models` |
| Create one child | `/sessions` |
| Create many children | `/sessions/batch` |
| Get only final answers | `/sessions/:id/prompt` with `answers`, or `/sessions/batch/prompt` |
| Watch live progress | `/sessions/:id/events` |
| Wait for completion safely | `/sessions/:id/wait` |
| Read child output in one common format | `/sessions/:id/transcript` |
| Get replay-like details | `/sessions/:id/history` |
| Hand context into another session | `/sessions/:id/transfer` |
| Sum usage/cost | `/sessions/usage` |

## Important caveat: Claude channel `/events`

The biggest practical caveat for orchestration today is:

- for **Claude channel-backed** sessions, `GET /sessions/:id/events` can be
  less reliable for **parallel multi-child monitoring on the same host** than
  it is for Pi, OpenCode, and Antigravity

What this means in practice:
- a single Claude child can still be monitored over `/events`
- but if your parent agent fans out into multiple Claude children and expects
  each one to provide a perfectly stable live SSE stream at the same time,
  that assumption is risky
- this is a limitation of the current Claude channel-backed runtime shape, not
  of the OpenCode or Pi event paths

### Recommended response

For Claude-heavy fan-out workflows:
- prefer `GET /sessions/:id/wait` to detect completion
- then use `GET /sessions/:id/transcript` to read the result
- treat `/events` as a nice-to-have live monitor, not as the only source of
  truth for completion or result collection

### Good mixed-runtime pattern

A practical orchestration pattern is:
- use Pi, OpenCode, or Antigravity when you want stronger live fan-out
  monitoring over `/events`
- use Claude children when the model is useful, but collect them via
  `/wait` + `/transcript`

## Example orchestration pattern

```text
1. GET /capabilities
2. GET /models
3. POST /sessions/batch                  # create child sessions
4. POST /sessions/:id/control            # optional prepare step
5. POST /sessions/:id/prompt             # dispatch work
6. GET /sessions/:id/events              # monitor live where appropriate
7. GET /sessions/:id/wait                # safe completion check
8. GET /sessions/:id/transcript          # collect result
9. POST /sessions/:id/transfer           # hand useful context onward
10. POST /sessions/usage                 # aggregate usage
11. DELETE /sessions/:id                 # cleanup
```

## Example design advice for your use case

If your parent agent lives in the Pi SDK runtime and wants to call three child
agents on other runtimes:

- **OpenCode child** — good fit for `/events` live monitoring
- **Antigravity child** — good fit for `/wait` + `/transcript`; `/events`
  exists but the runtime is subprocess-per-turn, so completion-style polling is
  often enough
- **Claude child** — use `/events` only if you truly need live progress; for
  robustness prefer `/wait` + `/transcript`

That gives you broad functional coverage across all four runtime paths without
assuming identical runtime behaviour where the backends are actually different.

## Related docs

- [`INTERNAL-API.md`](./INTERNAL-API.md)
- [`LIVE-VALIDATION.md`](./LIVE-VALIDATION.md)
- [`CLAUDE-BACKENDS.md`](./CLAUDE-BACKENDS.md)
- [`OPENCODE-DIRECT-INTEGRATION.md`](./OPENCODE-DIRECT-INTEGRATION.md)
- [`ANTIGRAVITY-INTEGRATION.md`](./ANTIGRAVITY-INTEGRATION.md)
- [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md)
