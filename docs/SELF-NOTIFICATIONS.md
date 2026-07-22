# Self-notifications for terminal agents and scripts

Pi Web UI can send explicit Telegram notifications for work performed outside a browser-managed session. This is useful when Claude, GLM, Pi, OpenCode, Antigravity, a shell script, or another local harness should tell the operator that work is done, blocked, waiting for input, or has passed a meaningful milestone.

This page is a **task-oriented entrance**. The canonical reference for the helper, its delivery semantics, and its security model is [`NOTIFICATIONS.md` § "Self-notification from a terminal CLI harness"](./NOTIFICATIONS.md#9-self-notification-from-a-terminal-cli-harness). Read it before relying on exact behavior; this page only routes you into it.

## Self-notification vs. the sidebar bell

- **Per-session notification opt-in** automatically reacts to a live `agent_end` from a Pi Web UI session (see [`NOTIFICATIONS.md`](./NOTIFICATIONS.md)).
- **Self-notification** is an explicit call made by a terminal agent or script through `scripts/notify.sh` or the Internal API.

Both use the same durable notification outbox and Telegram channel.

## Prerequisites

1. Pi Web UI is running.
2. Notifications are enabled and Telegram is configured as described in [`NOTIFICATIONS.md`](./NOTIFICATIONS.md).
3. The local Internal API socket and token exist.
4. The caller runs as the same trusted user, or otherwise has access to those owner-only files.

## Quickstart

```bash
scripts/notify.sh <milestone|done|question|blocked> <title> [body]
```

Any value other than the four standard kinds becomes a custom label. The kind only standardizes the title prefix for operator scanning; it does not create a separate queue or workflow state machine.

```bash
scripts/notify.sh milestone "phase 2 complete" "Server + client build green; moving to validation."

scripts/notify.sh done "Docs review complete" "A pull request is ready for review."

scripts/notify.sh question "Decision needed" "Should the migration preserve the old table?"

scripts/notify.sh blocked "CI blocked" "The required runtime credential is unavailable."
```

For a multiline body, omit the body argument (or pass `-`) and pipe stdin:

```bash
cat report.txt | scripts/notify.sh done "Validation report"
```

## Recommended agent behavior

Use self-notification only when the operator has asked for it or the surrounding workflow explicitly authorizes it. A sensible policy is:

- `milestone` — a meaningful phase or review gate was reached in long autonomous work;
- `done` — the requested work reached a meaningful terminal result;
- `question` — progress cannot continue safely without operator input;
- `blocked` — an external prerequisite failed or is unavailable.

Do not notify for every intermediate step. Do not include secrets, bearer tokens, cookies, raw auth errors, or full private transcripts.

## Behavior you must not assume away

These points are summarized from the canonical section; treat [`NOTIFICATIONS.md` § 9](./NOTIFICATIONS.md#9-self-notification-from-a-terminal-cli-harness) as authoritative:

- Acceptance is durable before the API returns success, and pending items are retried after restart.
- Telegram delivery is **at least once** around a narrow crash boundary, so a duplicate is possible.
- When the server is briefly unavailable, the helper may spool locally; a spooled item is **not** proof of Telegram delivery.
- Do not build an unbounded retry loop around the helper; return a clear failure to the parent workflow instead.

## Direct API use

Scripts that need their own idempotency key or status polling can call the Internal API directly:

```text
POST /api/v1/notifications
GET  /api/v1/notifications/:notificationId
GET  /api/v1/notifications
```

Use `Idempotency-Key` for a retriable emit. Retrying the same key with a different payload returns a conflict. See [`INTERNAL-API.md`](./INTERNAL-API.md) for the exact request/response shapes.

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
