# Self-notifications for terminal agents and scripts

Pi Web UI can send explicit Telegram notifications for work performed outside a browser-managed session. This is useful when Claude, GLM, Pi, OpenCode, Antigravity, a shell script, or another local harness should tell the operator that work is done, blocked, or waiting for input.

This is different from the sidebar bell:

- **Per-session notification opt-in** automatically reacts to a live `agent_end` from a Pi Web UI session.
- **Self-notification** is an explicit call made by a terminal agent or script.

Both use the same durable notification outbox and Telegram channel.

## Prerequisites

1. Pi Web UI is running.
2. Notifications are enabled and Telegram is configured as described in [`NOTIFICATIONS.md`](./NOTIFICATIONS.md).
3. The local Internal API socket and token exist.
4. The caller runs as the same trusted user, or otherwise has access to those owner-only files.

## Helper usage

```bash
scripts/notify.sh <done|question|blocked> <title> [body]
```

Examples:

```bash
scripts/notify.sh done "Docs review complete" "A pull request is ready for review."

scripts/notify.sh question "Decision needed" "Should the migration preserve the old table?"

scripts/notify.sh blocked "CI blocked" "The required runtime credential is unavailable."
```

For a multiline body, pipe stdin:

```bash
cat report.txt | scripts/notify.sh done "Validation report"
```

The status word standardizes the message title for operator scanning; it does not create a separate queue or workflow state machine.

## Recommended agent behavior

Use self-notification only when the operator has asked for it or the surrounding workflow explicitly authorizes it. A sensible policy is:

- `done` — the requested work reached a meaningful terminal result;
- `question` — progress cannot continue safely without operator input;
- `blocked` — an external prerequisite failed or is unavailable.

Do not notify for every intermediate step. Do not include secrets, bearer tokens, cookies, raw auth errors, or full private transcripts.

## Delivery semantics

The helper calls the explicit Internal API notification endpoint over the Unix socket. Acceptance is durable before the API returns success. Pending items are retried and restored after restart.

Telegram delivery is **at least once** around a narrow crash boundary: if Telegram accepts the message but Pi Web UI crashes before persisting `sent`, the retry may produce a duplicate.

## When Pi Web UI is unavailable

The helper may use the repository's bounded local ingress/spool behavior when available. A spooled item is not proof of Telegram delivery; inspect the notification status/log after the server returns.

Do not build an unbounded retry loop around the helper. Return a clear failure to the parent workflow instead.

## Inspect delivery

Use the Internal API notification status and recent-delivery endpoints documented in [`NOTIFICATIONS.md`](./NOTIFICATIONS.md). Records expose pending, sent, or failed state, attempt count, and the latest delivery error.

## Direct API use

Scripts that need their own idempotency key or status polling can call:

```text
POST /api/v1/notifications
GET  /api/v1/notifications/:notificationId
GET  /api/v1/notifications
```

Use `Idempotency-Key` for a retriable emit. Retrying the same key with a different payload returns a conflict.

## Security

- The helper reads the Internal API token at runtime; it contains no embedded credentials.
- The token grants broad local control, not notification-only access.
- Keep the token and notification persistence directory owner-only.
- Treat notification text as information sent to an external service.
- Never use production notification delivery during disposable validation; validation mode uses a capture channel.

## Troubleshooting

| Symptom | Check first |
|---|---|
| Helper cannot connect | Pi Web UI process, socket path, and file ownership |
| Unauthorized | token path and bearer token freshness |
| Accepted but no Telegram message | recent delivery status, Telegram configuration, channel timeout/error |
| Duplicate message | crash/restart near Telegram acceptance, or caller reused logic without an idempotency key |
| Session bell works but helper fails | explicit Internal API route/socket access |
| Helper works but session bell does not | session opt-in identity, opt-in timing, observer attachment, and `agent_end` evidence |

For session-specific failures, follow [`TROUBLESHOOTING-DECISION-TREE.md`](./TROUBLESHOOTING-DECISION-TREE.md).