#!/usr/bin/env bash
# Hold one cooperative production-control lock for the full lifetime of a
# caller-supplied argument-vector command. This script never deploys by itself.
set -euo pipefail

if [[ $# -eq 0 ]]; then
  printf 'usage: scripts/with-production-lock.sh <command> [args...]\n' >&2
  exit 64
fi

LOCK_PATH="${PI_WEB_UI_PRODUCTION_LOCK:-$HOME/.pi-web-ui/production-control.lock}"
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

# No eval or shell-string interpolation: preserve the caller's exact argv.
exec "$@"
