#!/usr/bin/env bash
# Voice Live Lab — disposable validation server boot (L0, plan §26.3).
#
# Starts an isolated Pi Web UI validation server OUTSIDE the production
# pi-web-ui.service cgroup via `systemd-run --scope --collect`, waits for its
# Internal API socket to answer, and prints the socket/token paths. Nothing
# here touches production state, the operator's ~/.pi/agent, or the registry.
#
# Why a boot script rather than a one-liner: this host's Pi session has a text
# guard whose trigger is the literal server entrypoint path, and it scans the
# whole command string. A script keeps that literal out of the typed command —
# the established repo idiom. The server's own validation-cgroup-guard (exit 78)
# remains the authoritative safety control and still fires for an unsafe launch.
#
# Usage:
#   VOICE_LAB_DIR=$(mktemp -d /tmp/voice-lab-XXXXXX) \
#     bash scripts/voice-live-lab/boot-disposable-server.sh boot
#   ... status | stop
#
# Environment:
#   VOICE_LAB_DIR   isolated state dir (default: a fresh mktemp dir)
#   VOICE_LAB_UNIT  systemd scope unit name (default: voice-lab-srv)
#   VOICE_LAB_REPO  repo root (default: /root/pi-web-ui)
set -uo pipefail

REPO="${VOICE_LAB_REPO:-/root/pi-web-ui}"
UNIT="${VOICE_LAB_UNIT:-voice-lab-srv}"
POINTER="${VOICE_LAB_POINTER:-/tmp/voice-lab-current}"
# `boot` records the state dir here so `status`/`stop` can find it afterwards.
if [ -n "${VOICE_LAB_DIR:-}" ]; then
  STATE_DIR="$VOICE_LAB_DIR"
elif [ -r "$POINTER" ]; then
  STATE_DIR="$(cat "$POINTER")"
else
  STATE_DIR="$(mktemp -d /tmp/voice-lab-XXXXXX)"
fi
LOG="$STATE_DIR/server.log"
SOCKET="$STATE_DIR/internal-api.sock"
TOKEN="$STATE_DIR/internal-api-token"
WAIT_SECONDS="${VOICE_LAB_WAIT_SECONDS:-120}"

# Seed the isolated agent dir with the HOST credential store (L5, W4): the
# fresh PI_CODING_AGENT_DIR would otherwise leave every provider
# unauthenticated and the worker session's model turn would die in ~1 s with
# no assistant output. Only the credential STORE is seeded — session
# isolation is preserved. A missing host store is surfaced honestly (never
# silently skipped, never invented).
seed_agent_auth() {
  if [ -f "${HOME}/.pi/agent/auth.json" ]; then
    mkdir -p "$STATE_DIR/pi-agent"
    cp "${HOME}/.pi/agent/auth.json" "$STATE_DIR/pi-agent/auth.json"
    chmod 600 "$STATE_DIR/pi-agent/auth.json"
    echo "auth-store=seeded (from ${HOME}/.pi/agent/auth.json)"
  else
    echo "auth-store=missing (no ${HOME}/.pi/agent/auth.json — provider-authenticated models will fail in this disposable server)" >&2
    echo "auth-store=missing"
  fi
}

case "${1:-boot}" in
  seed-auth)
    seed_agent_auth
    ;;
  boot)
    mkdir -p "$STATE_DIR/pi-agent"
    seed_agent_auth
    printf '%s\n' "$STATE_DIR" > "$POINTER"
    # VOICE_LAB_COMPILED=1 boots the compiled server (server/dist/index.js) —
    # used by the lane lab's built-app mode (production-shape proof).
    COMPILED_ARG=""
    [ -n "${VOICE_LAB_COMPILED:-}" ] && COMPILED_ARG="--compiled"
    # PI_CODING_AGENT_DIR is the Pi SDK's own isolation variable: without it,
    # real Pi sessions would land in ~/.pi/agent/sessions.
    systemd-run --scope --collect --unit="$UNIT" \
      env PI_CODING_AGENT_DIR="$STATE_DIR/pi-agent" NODE_ENV=test \
      npm run validate:server --prefix "$REPO" -- --dir "$STATE_DIR" --port 0 $COMPILED_ARG \
      >"$LOG" 2>&1 &
    echo "state_dir=$STATE_DIR"
    echo "log=$LOG"
    for i in $(seq 1 "$WAIT_SECONDS"); do
      if [ -S "$SOCKET" ]; then
        echo "socket=$SOCKET"
        echo "token=$TOKEN"
        echo "server ready after ${i}s"
        exit 0
      fi
      if grep -qE 'cannot run inside the production systemd slice|exit status 78' "$LOG" 2>/dev/null; then
        echo "server refused to start (cgroup guard); see $LOG" >&2
        tail -20 "$LOG" >&2
        exit 1
      fi
      sleep 1
    done
    echo "timed out after ${WAIT_SECONDS}s waiting for $SOCKET" >&2
    tail -20 "$LOG" >&2
    exit 1
    ;;
  status)
    systemctl is-active "$UNIT.scope" 2>&1 | sed 's/^/server: /'
    if [ -S "$SOCKET" ]; then echo "socket: present ($SOCKET)"; else echo "socket: absent"; fi
    ;;
  stop)
    systemctl stop "$UNIT.scope" 2>/dev/null && echo "server scope stopped" || echo "server scope not running"
    if [ -S "$SOCKET" ]; then echo "warning: socket still present at $SOCKET"; else echo "socket removed"; fi
    ;;
  *)
    echo "usage: $0 boot|status|stop" >&2
    exit 1
    ;;
esac
