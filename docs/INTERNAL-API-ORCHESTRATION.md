# Internal API Orchestration Guide

> Task-oriented guide for using Pi Web UI's Internal API as a local multi-agent orchestration surface.
>
> Read [`INTERNAL-API.md`](./INTERNAL-API.md) for the canonical endpoint reference and [`INTERNAL-API-CONTRACT.md`](./INTERNAL-API-CONTRACT.md) for compatibility/versioning rules. Read this guide when you want to spawn child sessions across runtimes, monitor them, collect their results, and hand context between them.
>
> Important framing: the Internal API began first as a **live-validation API** for exercising real runtime sessions during development and troubleshooting. The orchestration role described here is real and growing, but parts of the broader cross-runtime vision are still early and evolving.
>
> **Safety boundary:** live validation must target a disposable validation server by default, not the running production Web UI. Production validation requires explicit user permission and the CLI-level `--allow-production` acknowledgement.

## What this guide is for

Use this guide when a **parent agent**, Agent OS style local consumer, or local automation process wants to:
- choose different runtimes/models for different subtasks
- create several child sessions in parallel
- monitor progress while those children work
- collect transcripts/results in one common format
- transfer useful context from one child into another session
- sum usage/cost across the children

Typical example:
- a Pi Coding Agent parent agent receives a large coding task
- it decides planning is best on Claude, code generation is best on OpenCode,
  and a comparative check is best on Antigravity
- it creates one child session on each runtime
- it prompts them independently
- it monitors them, gathers their results, and continues the parent task with
  the combined output

## Live-validation guardrails

When the task is validation rather than ordinary orchestration, never use the default production socket (`~/.pi-web-ui/internal-api.sock`) just because it exists. Use this flow:

1. Start `npm run validate:server` with an isolated validation directory.
2. Pass the printed `--socket` and `--token-path` into `validate:live`, `validate:long-horizon`, or your custom client.
3. Tear the validation server down after collecting evidence.
4. Report that production was untouched.

Do not stop, restart, or redeploy `pi-web-ui.service` during validation unless the user explicitly asked you to control the production service. If the user genuinely wants production validation, say so in the report and use `--allow-production`.

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

Always start by asking the server what is available now and which contract version it is publishing.

- `GET /api/v1/capabilities` — includes `contract.name`, `contract.majorVersion`, and `contract.contractVersion`
- `GET /api/v1/models`

This lets you decide:
- which runtimes are installed and healthy
- whether a runtime supports follow-up, replay, approvals, or thinking level
- which models are currently available without restarting the server
- for Claude specifically, whether you want a base alias (`sonnet`) or an explicit profile-backed model (`profile:<id>`) tied to a chosen backend/provider

When `GET /api/v1/models` returns Claude entries such as `profile:glm52-claude-sdk`, treat those as the safest way to request an exact Claude provider/backend route. They may also include `backend` and `claudeModel` metadata so you can deliberately choose SDK vs direct vs channel-backed paths.

### 2. Create child sessions

For one child:
- `POST /api/v1/sessions`

For many children at once:
- `POST /api/v1/sessions/batch`

Track the returned `sessionId`s in your own orchestrator state, because the
API does not yet store parent-child relationships for you.

If the child is a Claude session and you care about the exact backend/provider, choose it at creation time:
- `model: "profile:<id>"` — easiest if you discovered the profile through `/models`
- `profileId: "<id>"` — explicit alternative for automation clients

That lets one orchestration run compare, for example:
- native Claude via SDK profile
- GLM 5.2 via Claude SDK profile
- GLM 5.2 via Claude direct CLI fallback profile

### 3. Prepare child sessions if needed

Use `POST /api/v1/sessions/:id/control` to do things like:
- switch model
- set thinking level
- pin a session

Do this before dispatching long work if the runtime supports the setting you
care about.

For Claude, prefer selecting the backend/provider profile at **session creation time** rather than relying on later model switching. Model switching is great within a chosen Claude route, but backend/provider comparisons are usually clearer and safer as one session per profile.

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

## Pin-and-forget: long tasks without polling

Sometimes you want to start a child on a longer task, guarantee it **won't be
cleaned up** while it runs, and check back later — **without** the polling
contract of a long-horizon watch. This is the lightweight alternative to
[long-horizon validation](./LONG-HORIZON-VALIDATION.md) for tasks where you don't
need durable condition detection, just survival.

The flow is two calls and a later read:

```text
1. POST /sessions            { "runtime": "claude", "pin": true }   # pinned at birth
2. POST /sessions/:id/prompt { "message": "...", "detach": true }   # 202, runs in background
   ...time passes...
3. GET  /sessions/:id/info          # status: idle|running, pinned, pinnedUntil
   GET  /sessions/:id/transcript    # the result
```

**What you must know about the pin (it is time-bounded, not permanent):**

- A pin is **time-bounded by default**: 24h lifetime, hard max 7d, returned as
  `pinnedUntil`. It is auto-revoked at the deadline so a forgotten task can't
  hog a slot forever. Re-pin (`control {action:"pin"}`) to extend.
- Max **2 pinned sessions per runtime per server instance**. Production and
  disposable validation servers have independent pin slots and pin ledgers. At
  the limit, `pin:true` still creates the session but returns `pinned:false` and
  `pinReason:"PIN_LIMIT_REACHED"`.
- Pinning is **independent of the watch**. You can pin with no watch; deleting a
  watch does not unpin. Use pin-only when you don't need durable condition
  matching, or pin+watch when you do.

`detach:true` returns `202` immediately and the turn keeps running server-side
even after you disconnect — so you can fire the task and close the connection.
Combine with pin for the full "set and walk away" pattern. This needs a
**disposable validation server** when validating (`npm run validate:server`),
never the production instance by default.

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
- when comparing Claude routes, create separate children bound to explicit
  profile-backed models so your report can say exactly which backend/provider won

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

If your parent agent lives in the Pi Coding Agent runtime and wants to call three child
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
- [`INTERNAL-API-CONTRACT.md`](./INTERNAL-API-CONTRACT.md)
- [`LIVE-VALIDATION.md`](./LIVE-VALIDATION.md)
- [`CLAUDE-BACKENDS.md`](./CLAUDE-BACKENDS.md)
- [`OPENCODE-DIRECT-INTEGRATION.md`](./OPENCODE-DIRECT-INTEGRATION.md)
- [`ANTIGRAVITY-INTEGRATION.md`](./ANTIGRAVITY-INTEGRATION.md)
- [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md)
