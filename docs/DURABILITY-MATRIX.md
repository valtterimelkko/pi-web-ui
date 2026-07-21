# Durability and restart matrix

This page summarizes where state lives and what evidence survives refresh or restart. Runtime-specific documents remain canonical for implementation details.

| State/evidence | Browser refresh | Server restart | Ownership / caveat |
|---|---:|---:|---|
| Session registry metadata | Yes | Yes | Pi Web UI registry/persistence, subject to runtime reconciliation |
| Display name, archive, pin metadata | Yes | Yes | Core keyed metadata/preferences model |
| Visible transcript | Usually | Usually | Storage owner differs by runtime; use screen projection for normalized readback |
| Pi session/runtime files | Yes | Yes | Pi/runtime-owned files |
| Claude persisted session history | Yes | Yes | Depends on selected Claude backend and profile |
| OpenCode transcript | Yes | Yes | OpenCode backend owns transcript storage |
| Antigravity turn log | Yes | Yes | Pi Web UI JSONL turn log correlated with agy conversation DB |
| In-flight runtime process | Browser disconnect-safe where supported | No process continuity | Receipt/recovery semantics determine final reported state |
| Internal API run receipt | Yes | Yes | Durable accepted/started/terminal state; recovered after restart |
| Idempotency reservation | Yes during normal operation | Bounded/reconciled | Contract TTL and rejection rules apply |
| Diagnostics ring | Yes | **No** | Process-local bounded buffer |
| Runtime-health snapshot | Yes | **No historical continuity** | Current process snapshot; durable failures require receipts/files |
| Session evidence bundle | Recomputed | Recomputed | Combines durable and process-local sources; note warnings |
| Notification opt-in | Yes | Yes | Durable per-session record |
| Pending notification outbox | Yes | Yes | Resumes draining after restart |
| Sent/failed notification log | Yes | Yes, bounded | Terminal ledger is capped |
| Telegram delivery exactly-once guarantee | No | No | Delivery is at least once around crash boundary |
| Long-horizon watch evidence | Yes | Yes | Recorded ledger survives |
| Active long-horizon observation | Yes while process lives | **No** | Reloaded watch is detached and must be registered again |
| Browser-only unsaved Files edit | Yes until navigation/refresh guard | No | Save explicitly before restart/navigation |
| Files loaded truncated | Yes | Yes | Read-only safety state; partial content cannot overwrite full file |
| WebSocket/event subscriptions | No | No | Reconnect and reattach required |

## Operational rules

- Do not use process-local diagnostics as the sole record of a long-running job.
- Persist `sessionId`, `runId`, and `requestId` in orchestration clients.
- After restart, check receipts and transcripts before assuming an interrupted connection means failed work.
- Treat notification acceptance and Telegram delivery as separate states.
- Re-register long-horizon observation after restart even when prior evidence remains visible.
- Back up operator-owned state before deployment upgrades or storage migrations.

See [`INTERNAL-API-CONTRACT.md`](./INTERNAL-API-CONTRACT.md), [`OBSERVABILITY.md`](./OBSERVABILITY.md), [`NOTIFICATIONS.md`](./NOTIFICATIONS.md), and [`LONG-HORIZON-VALIDATION.md`](./LONG-HORIZON-VALIDATION.md).