# Internal API recipes

These recipes complement the canonical endpoint documentation. Capability-gate optional fields and endpoints through `/health` and `/capabilities`.

## Durable, retriable prompt dispatch

1. Generate a session-scoped idempotency key.
2. Dispatch the prompt with that key.
3. Persist the returned `runId` before doing more work.
4. On network uncertainty, retry the same payload with the same key.
5. Poll `GET /api/v1/runs/:runId` until terminal.
6. Read `transcript?view=screen` for the result.

Reusing a key with a different payload is a contract error, not a way to replace a run.

## Detached long-running work

Use detached/answer-mode behavior documented by the contract when the client should not own the runtime connection. A disconnect must not be treated as proof that the agent stopped. The durable receipt is the source of truth for accepted, started, completed, failed, cancelled, or interrupted state.

## Parallel child sessions

For each child:

1. discover a supported runtime/model;
2. create a dedicated session;
3. record the canonical session id and your own parent/child relationship;
4. dispatch with a unique idempotency key;
5. keep the `runId`;
6. wait independently;
7. read the screen transcript;
8. aggregate results;
9. delete only the child sessions your workflow owns.

Pi Web UI does not yet provide a parent-session or orchestration-id index. The caller must maintain that graph.

## Claude fan-out

For parallel Claude children, prefer receipt/wait plus transcript readback as the reliable baseline. The channel event stream has runtime-specific caveats and should not be the only completion signal.

## Evidence-first troubleshooting

Given any internal id, runtime-native id, registry path, or conversation id:

```bash
npm run debug:where -- --json <id-or-path>
```

Then call:

```text
GET /api/v1/sessions/:canonicalId/evidence
```

Escalate in this order:

1. evidence bundle;
2. screen transcript;
3. run receipt;
4. session-scoped diagnostics with `runId`/`requestId` filters;
5. runtime-owned files named by the evidence bundle;
6. broad logs only as a final step.

## Compare user-visible and raw history

Use `transcript?view=screen` to inspect what the browser should render. Use history/event-oriented endpoints only when diagnosing normalization or replay. A difference between those surfaces localizes the problem more effectively than starting from raw JSONL.

## Transfer context across runtimes

Use the session-transfer endpoint documented in the canonical API. Treat transfer as a handoff, not shared memory: preserve the source session, record the target session id, and send a follow-up instruction after transfer. Runtime-specific context limits still apply.

## Explicit operator notification

For scripts and terminal agents, prefer the repository helper:

```bash
scripts/notify.sh done "Task complete" "Summary text"
```

For direct API use, call `POST /api/v1/notifications` with an idempotency key, retain the returned notification id/status URL, and poll delivery status. Delivery is durable but Telegram is at-least-once around a crash boundary.

See [`SELF-NOTIFICATIONS.md`](./SELF-NOTIFICATIONS.md).

## Production-safe validation

Do not point automated validation at the default production socket without explicit permission. Start an isolated validation server, pass its socket/token to the validation client, and never restart or reconfigure the production service as a side effect of a normal validation task.

## Operational expectations

- diagnostics and runtime-health snapshots are process-local;
- run receipts and transcript/runtime files are the durable evidence layer;
- pending notifications survive restart through the durable outbox;
- reloaded long-horizon watches preserve recorded evidence but must be registered again to resume observation;
- any API token holder can inspect and control all sessions.

See [`DURABILITY-MATRIX.md`](./DURABILITY-MATRIX.md) and [`INTERNAL-API-CONTRACT.md`](./INTERNAL-API-CONTRACT.md).