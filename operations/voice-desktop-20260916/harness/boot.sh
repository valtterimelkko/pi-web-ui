#!/usr/bin/env bash
# Voice Mode desktop rework (2026-09-16) — boot the disposable pieces.
#
# A disposable validation server (its own dir, socket, token, ports) plus a dev
# client whose proxy points at it. Everything long-running starts inside a
# transient systemd scope unit, so it lives OUTSIDE the pi-web-ui.service
# cgroup, is named, and cannot be confused with the production service.
#
# Usage: boot.sh server | client | status | stop
set -uo pipefail

TREE=${TREE:-/root/pi-web-ui}
OPS=${OPS:-/root/pi-web-ui/operations/voice-desktop-20260916}
SRV_UNIT=voicedesk-server
CLI_UNIT=voicedesk-client
SRV_DIR=${SRV_DIR:-/tmp/voice-desktop-srv}
SRV_PORT=${SRV_PORT:-3521}
VITE_PORT=${VITE_PORT:-3522}
# Disposable bcrypt hash for the password used by the browser harness only.
AUTH_HASH='$2b$10$nvqaORBU5z9FSTCnEgBGY.puZNYRuXcMsrDu2DdS4CYLkBxV.Gngm'  # password: voice-lab-pass

# The provider key the disposable server's pi runtime needs. Sourced from the
# operator's shell config, never written to disk or into evidence.
OPENROUTER_KEY=$(bash -c 'source /root/.bashrc >/dev/null 2>&1; printf %s "${OPENROUTER_API_KEY:-}"')
if [ -z "$OPENROUTER_KEY" ]; then echo "OPENROUTER_API_KEY not resolvable — refusing to boot" >&2; exit 3; fi

case "${1:-}" in
  server)
    mkdir -p "$OPS/logs" "$SRV_DIR"
    systemd-run --scope --collect --unit="$SRV_UNIT" \
      env AUTH_PASSWORD="$AUTH_HASH" \
      NODE_ENV=development \
      OPENROUTER_API_KEY="$OPENROUTER_KEY" \
      ALLOWED_ORIGINS="http://127.0.0.1:$VITE_PORT,http://localhost:$VITE_PORT" \
      npm run validate:server --prefix "$TREE" -- --dir "$SRV_DIR" --port "$SRV_PORT" \
      > "$OPS/logs/server.log" 2>&1 &
    echo "server unit=$SRV_UNIT port=$SRV_PORT dir=$SRV_DIR log=$OPS/logs/server.log"
    for i in $(seq 1 90); do
      if grep -q "running on port\|Available providers" "$OPS/logs/server.log" 2>/dev/null; then
        echo "server up after ${i}s"; break
      fi
      sleep 1
    done
    grep -E "port |socket |token |dir " "$OPS/logs/server.log" | tail -6
    ;;
  client)
    mkdir -p "$OPS/logs"
    systemd-run --scope --collect --unit="$CLI_UNIT" \
      --working-directory="$TREE/client" \
      env VITE_API_TARGET="http://127.0.0.1:$SRV_PORT" \
      "$TREE/node_modules/.bin/vite" --port "$VITE_PORT" --strictPort --host 127.0.0.1 \
      > "$OPS/logs/client.log" 2>&1 &
    echo "client unit=$CLI_UNIT port=$VITE_PORT log=$OPS/logs/client.log"
    for i in $(seq 1 90); do
      if curl -sf "http://127.0.0.1:$VITE_PORT/" >/dev/null 2>&1; then
        echo "client up after ${i}s"; break
      fi
      sleep 1
    done
    ;;
  status)
    systemctl is-active "$SRV_UNIT.scope" 2>&1 | sed "s/^/server: /"
    systemctl is-active "$CLI_UNIT.scope" 2>&1 | sed "s/^/client: /"
    curl -sf "http://127.0.0.1:$VITE_PORT/" >/dev/null && echo "vite http: ok" || echo "vite http: down"
    curl -s -o /dev/null -w "api /api/health via proxy: %{http_code}\n" "http://127.0.0.1:$VITE_PORT/api/health"
    ;;
  stop)
    for u in "$CLI_UNIT" "$SRV_UNIT"; do
      systemctl stop "$u.scope" 2>/dev/null && echo "stopped $u" || echo "not running: $u"
      systemctl reset-failed "$u.scope" 2>/dev/null || true
    done
    ;;
  *)
    echo "usage: $0 server|client|status|stop" >&2; exit 2;;
esac
