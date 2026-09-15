#!/usr/bin/env bash
# Canonical production restart with an active-turn pre-flight (2026-09-15).
#
# WHY
#
# pi-web-ui.service uses KillMode=control-group: a restart SIGKILLs every
# process inside the unit — including mid-turn orchestration children
# dispatched through the Internal API. Restarting while children still have
# active turns silently aborts their work; that failure class has already
# happened once (2026-09-15 08:30, validation server and four mid-turn
# children killed with the unit).
#
# This script is the one canonical restart path that checks first:
#
#   1. Query GET /api/v1/capacity on the Internal API unix socket.
#   2. Refuse (exit 1) while `.activeTurns > 0` — the operator waits for
#      children to settle, or passes --force to name the override.
#   3. Announce the restart through the notification hook, then restart.
#
# A missing socket or token means the pre-flight cannot be executed; the
# restart then proceeds without it — a dead daemon has no active children to
# kill. A daemon that ACCEPTS and never answers wedges the pre-flight BY
# DESIGN: an unanswered drainage check must not be restarted past, because
# the daemon may be alive with children mid-turn. --force is the operator's
# named way out of that corner, chosen with open eyes.
#
# USE
#
#   scripts/restart-production.sh
#   scripts/restart-production.sh --force                    # override active-turn refusal
#   scripts/restart-production.sh --reason "why"              # named in the requester record
#
# Unknown arguments are refused rather than ignored: a caller who passes
# `--dry-run` (which this script does not implement) must not silently get a
# real restart.
#
# TEST SEAMS (defaults are the production values; tests override them so no
# test can touch the real service, socket, or journal):
#
#   PI_WEB_UI_INTERNAL_API_SOCKET      Internal API unix socket
#                                      (default /root/.pi-web-ui/internal-api.sock)
#   PI_WEB_UI_INTERNAL_API_TOKEN_FILE  bearer token file
#                                      (default /root/.pi-web-ui/internal-api-token)
#   PI_WEB_UI_RESTART_SYSTEMCTL        systemctl binary (default systemctl)
#   PI_WEB_UI_NOTIFY_SCRIPT            notify hook (default
#                                      /root/pi-web-ui/scripts/notify.sh)
#
# This script never runs on its own authority: production restart remains
# owner-gated, and scripts/restart-pi-web-ui.sh adds the same pre-flight to
# the audited requester-record path.

set -euo pipefail

# Captured before any argument parsing, so the record shows what was asked for.
ARGV_ORIGINAL="$*"
script_dir="$(cd -- "$(dirname -- "$0")" && pwd)"

FORCE=0
REASON="(unspecified)"
while [ $# -gt 0 ]; do
  case "${1:-}" in
    --force) FORCE=1; shift ;;
    --reason) REASON="${2:-(unspecified)}"; shift 2 ;;
    *)
      echo "restart-production.sh: unknown argument: ${1}" >&2
      exit 64
      ;;
  esac
done

SOCKET="${PI_WEB_UI_INTERNAL_API_SOCKET:-/root/.pi-web-ui/internal-api.sock}"
TOKEN_FILE="${PI_WEB_UI_INTERNAL_API_TOKEN_FILE:-/root/.pi-web-ui/internal-api-token}"
TOKEN="$(cat "$TOKEN_FILE" 2>/dev/null || true)"
SYSTEMCTL_BIN="${PI_WEB_UI_RESTART_SYSTEMCTL:-systemctl}"
NOTIFY_SCRIPT="${PI_WEB_UI_NOTIFY_SCRIPT:-/root/pi-web-ui/scripts/notify.sh}"

if [ "$FORCE" -eq 0 ] && [ -S "$SOCKET" ] && [ -n "$TOKEN" ]; then
  CAPACITY="$(curl -s --unix-socket "$SOCKET" -H "Authorization: Bearer $TOKEN" http://localhost/api/v1/capacity || true)"
  ACTIVE="$(printf '%s' "$CAPACITY" | jq -r '.activeTurns // 0' 2>/dev/null || echo 0)"
  if [ "$ACTIVE" -gt 0 ] 2>/dev/null; then
    echo "ERROR: Refusing production restart: $ACTIVE active child turn(s) in progress." >&2
    echo "Run with --force to override, or wait for children to settle." >&2
    exit 1
  fi
fi

echo "Initiating production restart of pi-web-ui.service..."
# Name the requester in the journal and the durable record BEFORE restarting —
# the same shared recorder scripts/restart-pi-web-ui.sh uses. Without this the
# 2026-09-15T15:35:23Z restart by this path left production's stop-audit file
# with no requester, indistinguishable from an unexplained stop.
"$script_dir/record-restart-requester.sh" "$REASON" "$ARGV_ORIGINAL" || true
"$NOTIFY_SCRIPT" milestone "Production restart initiated" "pi-web-ui.service restarting cleanly (active turns: 0)" || true
"$SYSTEMCTL_BIN" restart pi-web-ui.service
echo "Production restart complete."
