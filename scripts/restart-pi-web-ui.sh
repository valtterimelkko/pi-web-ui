#!/usr/bin/env bash
# Restart pi-web-ui.service and NAME THE REQUESTER (2026-09-15).
#
# WHY
#
# Every stop of pi-web-ui.service that ran to `TimeoutStopSec=30` left the
# journal unable to say who asked for it: no `Stopping ...` line, no sudo record,
# no `auditd` on the host, and `dbus-monitor` structurally blind to root
# `systemctl` (it uses systemd's private socket, not the system bus).
#
# The platform cannot name an arbitrary requester — that limit is real and is
# documented in deploy/systemd/pi-web-ui.service.d/10-stop-audit.conf. What the
# repository CAN do is make every restart path it owns announce itself, in the
# journal and in the durable stop-audit file, before the restart happens:
#
#   * who: uid, user, pid, ppid, tty, cwd
#   * from where: the full ancestor chain up to PID 1, which is usually enough
#     to identify the tmux/agent/session that issued it
#   * why: the caller's argv and an explicit --reason
#
# A restart that does not appear in this record is, by elimination, not one of
# ours — which is itself the useful finding.
#
# DRAINAGE PRE-FLIGHT (added 2026-09-15, the same day as the incident)
#
# The unit's KillMode=control-group means a restart SIGKILLs every process
# inside it — including mid-turn Internal API orchestration children. Before
# anything is announced, locked, or recorded, this script therefore queries
# GET /api/v1/capacity on the Internal API socket and REFUSES (exit 1) while
# .activeTurns > 0. --force is the explicit, named override. A refused
# restart never stops the service, so it writes no RESTART-REQUESTED record:
# the stop-audit stays a record of restarts that actually happened.
#
# USE
#
#   scripts/restart-pi-web-ui.sh --reason "deploy contract 1.42.0"
#   scripts/restart-pi-web-ui.sh --reason "weekly catalogue refresh" --no-lock
#   scripts/restart-pi-web-ui.sh --reason "dry run" --dry-run
#   scripts/restart-pi-web-ui.sh --reason "owner-approved override" --force
#
# The cooperative production lock is taken by default so two restarts cannot
# interleave; --no-lock is for callers that already hold it.
#
# TEST SEAMS (defaults are the production values; tests override them so no
# test can restart the real service or write the real journal/audit record):
#
#   PI_WEB_UI_INTERNAL_API_SOCKET      Internal API socket
#                                      (default /root/.pi-web-ui/internal-api.sock)
#   PI_WEB_UI_INTERNAL_API_TOKEN_FILE  bearer token file
#                                      (default /root/.pi-web-ui/internal-api-token)
#   PI_WEB_UI_RESTART_SYSTEMCTL        systemctl binary (default systemctl)
#   PI_WEB_UI_SYSTEMD_CAT              systemd-cat binary (default systemd-cat)

set -uo pipefail

# Captured before the argument loop consumes them, so the record shows what was
# actually asked for.
ARGV_ORIGINAL="$*"

REASON="(unspecified)"
USE_LOCK=1
DRY_RUN=0
FORCE=0

while [[ $# -gt 0 ]]; do
  case "${1:-}" in
    --reason)
      REASON="${2:-(unspecified)}"
      shift 2
      ;;
    --no-lock)
      USE_LOCK=0
      shift
      ;;
    --force)
      FORCE=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      sed -n '2,52p' "$0"
      exit 0
      ;;
    *)
      printf 'restart-pi-web-ui: unknown argument: %s\n' "$1" >&2
      exit 64
      ;;
  esac
done

set +e

# Capacity pre-flight, BEFORE anything is announced: a refused restart never
# stops the service, so it must not write a RESTART-REQUESTED audit record.
# A missing socket or token skips the check — a dead daemon has no active
# children to kill — but a daemon that ACCEPTS and never answers wedges the
# pre-flight BY DESIGN: an unanswered drainage check must not be restarted
# past, because the daemon may be alive with children mid-turn. Force is the
# operator's named way out of that corner, chosen with open eyes.
if (( ! FORCE )); then
  api_socket="${PI_WEB_UI_INTERNAL_API_SOCKET:-/root/.pi-web-ui/internal-api.sock}"
  api_token_file="${PI_WEB_UI_INTERNAL_API_TOKEN_FILE:-/root/.pi-web-ui/internal-api-token}"
  api_token="$(cat "$api_token_file" 2>/dev/null || true)"
  if [[ -S "$api_socket" && -n "$api_token" ]]; then
    capacity="$(curl -s --unix-socket "$api_socket" -H "Authorization: Bearer $api_token" http://localhost/api/v1/capacity || true)"
    active_turns="$(printf '%s' "$capacity" | jq -r '.activeTurns // 0' 2>/dev/null || echo 0)"
    if [[ "$active_turns" =~ ^[0-9]+$ ]] && (( active_turns > 0 )); then
      printf 'restart-pi-web-ui: refusing restart: %s active child turn(s) in progress. Wait for children to settle or pass --force.\n' "$active_turns" >&2
      exit 1
    fi
  fi
fi

AUDIT_FILE="${PI_WEB_UI_STOP_AUDIT_FILE:-/root/.pi-web-ui/stop-audit.log}"
ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Full argv of this invocation, so the record shows what was actually asked for.
argv="$ARGV_ORIGINAL"

# Ancestor chain, deepest first, bounded so a pathological tree cannot make the
# record enormous. Each entry is "pid:comm".
ancestors=""
pid="$$"
depth=0
while [[ "$pid" =~ ^[0-9]+$ ]] && (( pid > 1 )) && (( depth < 6 )); do
  comm="$(head -c 48 "/proc/$pid/comm" 2>/dev/null | tr -d '\n')"
  # /proc/<pid>/stat: field 4 is PPID, but field 2 (comm) may contain spaces and
  # parentheses, so strip everything up to and including the last ')' first.
  ppid="$(sed -e 's/.*) //' "/proc/$pid/stat" 2>/dev/null | awk '{print $2}')"
  ancestors="${ancestors}${pid}:${comm}>"
  pid="${ppid:-}"
  depth=$((depth + 1))
done
ancestors="${ancestors%,}"
ancestors="${ancestors%>}"

# coreutils `tty` prints "not a tty" on stdout AND exits non-zero, so neither a
# plain capture nor an `||` fallback yields a clean single-line value.
tty_name="$(tty 2>/dev/null)"
tty_name="${tty_name//$'\n'/ }"
[[ -z "$tty_name" ]] && tty_name="none"

LINE="RESTART-REQUESTED ts=$ts uid=$(id -u) user=$(id -un 2>/dev/null) pid=$$ ppid=$PPID tty=$tty_name cwd=$(pwd 2>/dev/null) reason=$(printf '%q' "$REASON") argv=$(printf '%q' "$argv") ancestors=$ancestors"

# Journal first, then the durable file — the same two sinks the stop audit uses,
# for the same reason: each has been lost at least once.
printf '%s\n' "$LINE"
mkdir -p "$(dirname "$AUDIT_FILE")" 2>/dev/null
printf '%s\n' "$LINE" >> "$AUDIT_FILE" 2>/dev/null
# systemd-cat gives the line a stable identifier in the journal even when this
# script is run from a context that is not a unit's own stdout.
systemd_cat="${PI_WEB_UI_SYSTEMD_CAT:-systemd-cat}"
if command -v "$systemd_cat" >/dev/null 2>&1; then
  printf '%s\n' "$LINE" | "$systemd_cat" -t pi-web-ui-restart 2>/dev/null
fi

if (( DRY_RUN )); then
  printf 'restart-pi-web-ui: dry run — would restart pi-web-ui.service\n' >&2
  exit 0
fi

if (( USE_LOCK )); then
  script_dir="$(cd -- "$(dirname -- "$0")" && pwd)" || exit 70
  exec "$script_dir/with-production-lock.sh" "${PI_WEB_UI_RESTART_SYSTEMCTL:-systemctl}" restart pi-web-ui
fi

"${PI_WEB_UI_RESTART_SYSTEMCTL:-systemctl}" restart pi-web-ui
