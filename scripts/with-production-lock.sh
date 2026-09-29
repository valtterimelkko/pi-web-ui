#!/usr/bin/env bash
# Hold one cooperative production-control lock for the full lifetime of a
# caller-supplied argument-vector command. This script never deploys by itself.
#
# Drain by default (B4, 2026-09-29): a bare service restart passed as the
# command — `[sudo] systemctl restart|try-restart|reload-or-restart
# pi-web-ui[.service]` — is routed through scripts/restart-production.sh, which
# drains the Internal API first and records the drain verdict in the stop
# audit. To restart without a drain, use
# `npm run production:drain-restart -- --force --reason "why"` (recorded).
# A restart path that has already run its own active-turn pre-flight and
# written its own requester record (scripts/restart-pi-web-ui.sh) sets
# PI_WEB_UI_RESTART_PREFLIGHTED=1 so it is not routed a second time.
#
# Re-entrant: the lock holder exports PI_WEB_UI_PRODUCTION_LOCK_HELD; a nested
# invocation for the same lock path (e.g. `npm run production:drain-restart`
# inside a locked deploy block) runs its command under the held lock instead of
# failing with "already in progress".
#
# Seams: PI_WEB_UI_PRODUCTION_LOCK (lock path), PI_WEB_UI_SERVICE_UNIT (unit the
# routing recognises; default pi-web-ui.service).
set -euo pipefail

if [[ $# -eq 0 ]]; then
  printf 'usage: scripts/with-production-lock.sh <command> [args...]\n' >&2
  exit 64
fi

script_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
LOCK_PATH="${PI_WEB_UI_PRODUCTION_LOCK:-$HOME/.pi-web-ui/production-control.lock}"

if [[ "${PI_WEB_UI_PRODUCTION_LOCK_HELD:-}" != "$LOCK_PATH" ]]; then
  LOCK_DIR="$(dirname -- "$LOCK_PATH")"
  mkdir -p -- "$LOCK_DIR"
  chmod 700 -- "$LOCK_DIR"
  if [[ -L "$LOCK_PATH" ]]; then
    printf 'production control: refusing symbolic-link lock path (%s)\n' "$LOCK_PATH" >&2
    exit 73
  fi
  if [[ ! -e "$LOCK_PATH" ]]; then
    # noclobber creates a regular file without following or replacing a path.
    (set -o noclobber; : > "$LOCK_PATH") 2>/dev/null || true
  fi
  if [[ -L "$LOCK_PATH" || ! -f "$LOCK_PATH" ]]; then
    printf 'production control: lock path is not a regular file (%s)\n' "$LOCK_PATH" >&2
    exit 73
  fi
  chmod 600 -- "$LOCK_PATH"
  exec 9<>"$LOCK_PATH"
  if ! flock -n 9; then
    printf 'production control: another build/restart/deploy is already in progress (%s)\n' "$LOCK_PATH" >&2
    exit 75
  fi
  export PI_WEB_UI_PRODUCTION_LOCK_HELD="$LOCK_PATH"
fi

# Drain by default: route a bare restart of the service through the drain path.
unit="${PI_WEB_UI_SERVICE_UNIT:-pi-web-ui.service}"
unit_base="${unit%.service}"
argv=("$@")
offset=0
[[ "${argv[0]}" == "sudo" ]] && offset=1
if [[ -z "${PI_WEB_UI_RESTART_PREFLIGHTED:-}" && $# -eq $((offset + 3)) && "$(basename -- "${argv[offset]}")" == "systemctl" ]]; then
  verb="${argv[offset + 1]}"
  target="${argv[offset + 2]}"
  if [[ "$verb" =~ ^(restart|try-restart|reload-or-restart)$ && ( "$target" == "$unit" || "$target" == "$unit_base" ) ]]; then
    printf 'production control: routing "%s" through drain-then-restart (scripts/restart-production.sh)\n' "$*" >&2
    exec "${argv[@]:0:offset}" bash "$script_dir/restart-production.sh" --reason "production:lock $*"
  fi
fi

# No eval or shell-string interpolation: preserve the caller's exact argv.
exec "$@"
