# Troubleshooting decision tree

Use this page when you know the symptom but not the subsystem. The detailed evidence ladder remains in [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md).

## First rule: preserve identifiers

Keep every identifier you encounter:

- canonical Internal API session id
- registry path
- runtime-native id or conversation id
- `runId`
- `requestId`
- runtime and execution/profile identity

Resolve aliases before searching broadly:

```bash
npm run debug:where -- --json <id-or-path>
```

Then fetch the bounded session evidence bundle:

```text
GET /api/v1/sessions/:id/evidence
```

## Symptom map

| Symptom | First check | Next evidence | Likely subsystem |
|---|---|---|---|
| Session missing from sidebar | `debug:where` and registry evidence | session metadata/preferences | registry or metadata channel |
| Session exists but API says not found | alias resolution | evidence using canonical id | identifier normalization |
| Browser and API show different text | screen transcript | history/event projection | client replay or normalization |
| Answer is blank or starts mid-sentence | screen transcript and runtime locator | runtime-owned turn file | capture or resumed-output extraction |
| Agent appears stuck | runtime-health matrix | session-scoped diagnostics and receipt | runtime process/lifecycle |
| UI remains “running” after completion | receipt plus terminal event | replayed `agent_end`/tool result | event pipeline or client state |
| Tool card remains open after refresh | screen/history comparison | persisted tool result | persistence/replay |
| Session disappeared after refresh | registry plus runtime-owned storage | metadata and session path | persistence or identity |
| Wrong model or thinking level ran | selected model in receipt/session info | `/models` capability metadata | create/control selection |
| Claude question dialog vanished or answer was ignored | recent extension UI events | timeout/cancel evidence | Claude SDK interaction lifecycle |
| Antigravity turn timed out silently | turn log and diagnostics | watchdog/attempt evidence | Antigravity subprocess lifecycle |
| Notification never arrived | opt-in state and delivery record | notification logs/observer attachment | notification manager/channel |
| Bell says off but notifications continue | canonical Pi identity | persisted opt-ins | notification identity migration |
| Terminal self-notification fails | socket/token and status route | recent delivery log | Internal API or Telegram channel |
| Extension UI/tree action does nothing | extension capability and active session | protocol events | companion extension lifecycle |
| Files editor refuses save | truncation and dirty-state banner | file size/path validation | Files tab safety boundary |

## Evidence ladder

Escalate only as far as necessary:

1. alias resolution;
2. session evidence bundle;
3. `transcript?view=screen`;
4. durable run receipt;
5. filtered diagnostics using session, runtime, `runId`, or `requestId`;
6. runtime-owned files named by the evidence bundle;
7. browser protocol/event inspection;
8. broad service logs or repository-wide search.

The ordering matters. It reduces false correlations and avoids exposing or copying more transcript/tool data than necessary.

## Notification branch

1. Confirm notifications are enabled and the Telegram channel is configured.
2. For automatic notifications, confirm the session was opted in **before** the relevant live `agent_end`; opt-in is not retroactive.
3. Confirm observer attachment for that runtime.
4. Inspect session notification state and recent deliveries.
5. Distinguish `pending`, `sent`, and `failed`.
6. For Pi sessions, verify canonical bare-UUID identity rather than relying on a transient live basename.
7. For terminal helpers, test socket/token access separately from Telegram delivery.

See [`NOTIFICATIONS.md`](./NOTIFICATIONS.md) and [`SELF-NOTIFICATIONS.md`](./SELF-NOTIFICATIONS.md).

## Browser-versus-backend branch

If the screen projection is correct but the browser is wrong, focus on client store/replay/rendering. If the screen projection is already wrong, move backward toward normalization, persistence, and runtime capture. If raw runtime storage is correct but the screen projection is wrong, focus on the adapter/projection layer.

## Restart branch

Before diagnosing a restart-related report, identify whether the evidence is durable or process-local. Diagnostics buffers and health snapshots reset with the process; receipts, transcripts/runtime files, notification outbox state, and recorded watch evidence have different persistence rules. See [`DURABILITY-MATRIX.md`](./DURABILITY-MATRIX.md).

## Production safety

Do not restart, stop, reconfigure, or live-validate against the production service merely to gather evidence unless the operator explicitly authorized production control. Prefer a disposable validation server for reproductions.