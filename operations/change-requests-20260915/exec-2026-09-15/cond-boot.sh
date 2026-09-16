#!/usr/bin/env bash
# CONDUCTOR's own boot for the one-tab multi-lane harness, in the wt-lanes worktree.
# Deliberately separate from child B's servers: unique unit names, unique ports, unique state dir.
# Everything long-running runs under systemd-run --scope --collect so it lives OUTSIDE the
# pi-web-ui.service cgroup (verified: this process is in a tmux-spawn scope, not the service).
set -uo pipefail

TREE=/root/pi-web-ui-wt-lanes
OPS=/root/pi-web-ui/operations/change-requests-20260915/exec-2026-09-15
SRV_UNIT=cond-lanes-server
CLI_UNIT=cond-lanes-client
SRV_DIR=/tmp/cond-lanes-srv
SRV_PORT=3501
VITE_PORT=3503
AUTH_HASH='$2b$10$nvqaORBU5z9FSTCnEgBGY.puZNYRuXcMsrDu2DdS4CYLkBxV.Gngm'  # password: voice-lab-pass

case "${1:-}" in
  server)
    mkdir -p "$OPS/logs" "$SRV_DIR"
    systemd-run --scope --collect --unit="$SRV_UNIT" \
      env AUTH_PASSWORD="$AUTH_HASH" NODE_ENV=development \
      ALLOWED_ORIGINS="http://127.0.0.1:$VITE_PORT,http://localhost:$VITE_PORT" \
      npm run validate:server --prefix "$TREE" -- --dir "$SRV_DIR" --port "$SRV_PORT" \
      > "$OPS/logs/cond-server.log" 2>&1 &
    for i in $(seq 1 90); do
      grep -q "running on port\|Available providers" "$OPS/logs/cond-server.log" 2>/dev/null && { echo "server up after ${i}s"; break; }
      sleep 1
    done
    grep -E "port|socket|token" "$OPS/logs/cond-server.log" | tail -4
    ;;
  client)
    mkdir -p "$OPS/logs"
    systemd-run --scope --collect --unit="$CLI_UNIT" --working-directory="$TREE/client" \
      env VITE_API_TARGET="http://127.0.0.1:$SRV_PORT" \
      "$TREE/node_modules/.bin/vite" --port "$VITE_PORT" --strictPort --host 127.0.0.1 \
      > "$OPS/logs/cond-client.log" 2>&1 &
    for i in $(seq 1 90); do
      curl -sf "http://127.0.0.1:$VITE_PORT/" >/dev/null 2>&1 && { echo "vite up after ${i}s"; break; }
      sleep 1
    done
    ;;
  status)
    systemctl is-active "$SRV_UNIT.scope" 2>&1 | sed 's/^/server: /'
    systemctl is-active "$CLI_UNIT.scope" 2>&1 | sed 's/^/client: /'
    curl -s -o /dev/null -w "vite: %{http_code}\n" "http://127.0.0.1:$VITE_PORT/" 2>&1
    curl -s -o /dev/null -w "api via proxy: %{http_code}\n" "http://127.0.0.1:$VITE_PORT/api/health" 2>&1
    ;;
  stop)
    systemctl stop "$SRV_UNIT.scope" 2>/dev/null && echo "server stopped"
    systemctl stop "$CLI_UNIT.scope" 2>/dev/null && echo "client stopped"
    ;;
  *) echo "usage: $0 server|client|status|stop"; exit 1 ;;
esac
