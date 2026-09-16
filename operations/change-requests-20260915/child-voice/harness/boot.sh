#!/usr/bin/env bash
# Child V — boot the disposable pieces for the two-tab Drive Mode reproduction.
#
# Everything long-running is started with `systemd-run --scope --collect` so it
# lives OUTSIDE the pi-web-ui.service cgroup and survives (or dies) independently
# of the service. Unit names are unique to this child.
#
# Usage: boot.sh server | client | status | stop
set -uo pipefail

TREE=/root/pi-web-ui-wt-voice
OPS=/root/pi-web-ui/operations/change-requests-20260915/child-voice
SRV_UNIT=childvoice-server
CLI_UNIT=childvoice-client
SRV_DIR=/tmp/child-voice-srv
SRV_PORT=${SRV_PORT:-3491}
VITE_PORT=${VITE_PORT:-3499}
AUTH_HASH='$2b$10$nvqaORBU5z9FSTCnEgBGY.puZNYRuXcMsrDu2DdS4CYLkBxV.Gngm'  # password: voice-lab-pass

case "${1:-}" in
  server)
    mkdir -p "$OPS/logs" "$SRV_DIR"
    systemd-run --scope --collect --unit="$SRV_UNIT" \
      env AUTH_PASSWORD="$AUTH_HASH" \
      NODE_ENV=development \
      ALLOWED_ORIGINS="http://127.0.0.1:$VITE_PORT,http://localhost:$VITE_PORT" \
      npm run validate:server --prefix "$TREE" -- --dir "$SRV_DIR" --port "$SRV_PORT" \
      > "$OPS/logs/server.log" 2>&1 &
    echo "server unit=$SRV_UNIT port=$SRV_PORT log=$OPS/logs/server.log"
    for i in $(seq 1 60); do
      if grep -q "running on port\|Available providers" "$OPS/logs/server.log" 2>/dev/null; then
        echo "server up after ${i}s"; break
      fi
      sleep 1
    done
    grep -E "port|socket|token|dir " "$OPS/logs/server.log" | tail -6
    ;;
  client)
    mkdir -p "$OPS/logs"
    # Port 5173 is taken by other children; run our own vite on an explicit,
    # non-default port with the proxy pointed at OUR disposable server.
    systemd-run --scope --collect --unit="$CLI_UNIT" \
      --working-directory="$TREE/client" \
      env VITE_API_TARGET="http://127.0.0.1:$SRV_PORT" \
      "$TREE/node_modules/.bin/vite" --port "$VITE_PORT" --strictPort --host 127.0.0.1 \
      > "$OPS/logs/client.log" 2>&1 &
    echo "client unit=$CLI_UNIT port=$VITE_PORT log=$OPS/logs/client.log"
    for i in $(seq 1 60); do
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
    curl -s -o /dev/null -w "api /api/health via proxy: %{http_code}\n" "http://127.0.0.1:$VITE_PORT/api/health" 2>&1
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
