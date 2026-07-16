#!/usr/bin/env bash
#
# scripts/notify.sh — self-notification helper for terminal CLI agent sessions.
#
# Lets an agent run directly from the terminal (claude / glm / pi / opencode /
# agy) ping the operator on Telegram through the Pi Web UI notification layer,
# WITHOUT going through the web UI. It submits to the explicit-emit Internal
# API endpoint over the local Unix socket, health-waits through short restarts,
# and atomically queues retryable outages for the server to ingest later. It
# never restarts or reconfigures the server itself.
#
# Full docs: docs/NOTIFICATIONS.md § "Self-notification from a CLI harness".
#
# Usage:
#   scripts/notify.sh <kind> <title> [body]
#   scripts/notify.sh <kind> <title>            # body read from stdin
#   echo "details" | scripts/notify.sh <kind> <title>
#
#   kind   : done | question | blocked   (any other value becomes a custom label)
#   title  : short one-line summary (NO emoji — the script adds it)
#   body   : optional detail; "-" or omitted → read from stdin
#
# Examples:
#   scripts/notify.sh done "restarted prod" \
#     "Built client+server; typecheck+lint+tests green; restarted pi-web-ui.service."
#   scripts/notify.sh question "which index?" "Add index on sessions.userId before shipping?"
#
# Env overrides (mainly for tests / non-default installs):
#   PI_WEB_UI_NOTIFY_SOCKET          default: ~/.pi-web-ui/internal-api.sock
#   PI_WEB_UI_NOTIFY_TOKEN_FILE      default: ~/.pi-web-ui/internal-api-token
#   PI_WEB_UI_NOTIFY_SPOOL_DIR       default: ~/.pi-web-ui/notifications/ingress
#   PI_WEB_UI_NOTIFY_WAIT_MS         default: 30000
#   PI_WEB_UI_NOTIFY_RETRY_MS        default: 250
#   PI_WEB_UI_NOTIFY_REQUEST_TIMEOUT_MS default: 5000
#
# The bearer token is read at runtime, never printed, and never spooled. A
# successful exit means accepted by the API or durably queued locally.
set -uo pipefail

log() { printf '%s\n' "$*" >&2; }   # stderr only — keep stdout clean for piping

# ── Parse args ───────────────────────────────────────────────────────────────
if [[ $# -lt 2 ]]; then
  log "usage: scripts/notify.sh <done|question|blocked> <title> [body]"
  log "       body omitted or '-' is read from stdin"
  exit 64
fi

KIND="$1"
TITLE_SUMMARY="$2"
BODY_ARG="${3:-}"

case "$KIND" in
  done)     TITLE="✅ Done: $TITLE_SUMMARY" ;;
  question) TITLE="❓ Question: $TITLE_SUMMARY" ;;
  blocked)  TITLE="⚠️ Blocked: $TITLE_SUMMARY" ;;
  *)        TITLE="📢 ${KIND}: $TITLE_SUMMARY" ;;
esac

# Body: explicit arg wins; otherwise read stdin (only when it's not a TTY, so an
# accidental interactive run never blocks waiting for input).
if [[ -n "$BODY_ARG" && "$BODY_ARG" != "-" ]]; then
  BODY="$BODY_ARG"
elif [[ ! -t 0 ]]; then
  BODY="$(cat)"
else
  BODY=""
fi
# The server requires a non-empty body (Zod min 1); fall back to the summary.
[[ -z "$BODY" ]] && BODY="$TITLE_SUMMARY"

# ── Build JSON safely (node ships with this repo; avoids quote/newline bugs) ─
JSON="$(TITLE="$TITLE" BODY="$BODY" node -e '
  const { TITLE, BODY } = process.env;
  process.stdout.write(
    JSON.stringify({ title: String(TITLE ?? "").trim(), body: String(BODY ?? "") }),
  );
' 2>/dev/null)"
if [[ -z "$JSON" ]]; then
  log "notify: failed to build JSON payload (is node on PATH?)"
  exit 1
fi

# ── Submit or durably queue through the stdlib Node client ───────────────────
# The client waits through short restart windows, retries with one idempotency
# key, and atomically spools retryable failures for server-side ingestion.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
printf '%s' "$JSON" | node "$SCRIPT_DIR/notify-client.mjs"
