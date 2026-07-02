#!/usr/bin/env bash
#
# scripts/notify.sh — self-notification helper for terminal CLI agent sessions.
#
# Lets an agent run directly from the terminal (claude / glm / pi / opencode /
# agy) ping the operator on Telegram through the Pi Web UI notification layer,
# WITHOUT going through the web UI. It POSTs to the existing explicit-emit
# Internal API endpoint (POST /api/v1/notifications) over the local Unix socket,
# so the Pi Web UI server must be running on this host (it always is in the
# operator's setup). No server restart or code change is needed.
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
#   PI_WEB_UI_NOTIFY_SOCKET       default: ~/.pi-web-ui/internal-api.sock
#   PI_WEB_UI_NOTIFY_TOKEN_FILE   default: ~/.pi-web-ui/internal-api-token
#
# The bearer token is read from the file at runtime and is never printed. Exits
# non-zero on failure but is safe to call best-effort from an agent turn.
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

# ── Resolve socket + token ───────────────────────────────────────────────────
SOCKET="${PI_WEB_UI_NOTIFY_SOCKET:-$HOME/.pi-web-ui/internal-api.sock}"
TOKEN_FILE="${PI_WEB_UI_NOTIFY_TOKEN_FILE:-$HOME/.pi-web-ui/internal-api-token}"

if [[ ! -S "$SOCKET" ]]; then
  log "notify: Internal API socket not found at $SOCKET"
  log "       (is the Pi Web UI server running on this host?)"
  exit 1
fi
if [[ ! -r "$TOKEN_FILE" ]]; then
  log "notify: cannot read Internal API token at $TOKEN_FILE"
  log "       (expected ~/.pi-web-ui/internal-api-token, mode 0600)"
  exit 1
fi
TOKEN="$(cat "$TOKEN_FILE" 2>/dev/null || true)"
if [[ -z "$TOKEN" ]]; then
  log "notify: Internal API token file is empty: $TOKEN_FILE"
  exit 1
fi

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

# ── POST to /api/v1/notifications over the Unix socket ───────────────────────
# Body is piped via stdin (--data @-) so large bodies stay off argv. The token
# travels in a header; on this single-user host it is already root-readable via
# the 0600 token file, and the server redacts Authorization from its own logs.
out="$(printf '%s' "$JSON" | curl --silent --show-error --max-time 10 \
  --unix-socket "$SOCKET" \
  -X POST "http://localhost/api/v1/notifications" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data @- \
  -w $'\n__HTTP__%{http_code}')"
rc=$?
if [[ $rc -ne 0 ]]; then
  log "notify: request failed (curl exit $rc) — is the web UI server reachable on $SOCKET?"
  exit 1
fi

http_code="$(printf '%s' "$out" | sed -n 's/^__HTTP__//p')"
resp_body="${out%$'\n'__HTTP__*}"

case "$http_code" in
  2*)
    log "notify: sent (HTTP $http_code) — $TITLE"
    exit 0
    ;;
  *)
    log "notify: server returned HTTP $http_code"
    [[ -n "$resp_body" ]] && log "       ${resp_body:0:300}"
    exit 1
    ;;
esac
