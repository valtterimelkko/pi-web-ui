#!/usr/bin/env bash
# Injection marking (2026-09-16) — boot the vite dev client for one leg.
# Usage: boot-client.sh <server-port> <vite-port>
set -uo pipefail
TREE=/root/pi-web-ui-wt-inject
SRV_PORT=${1:?usage: boot-client.sh <server-port> <vite-port>}
VITE_PORT=${2:?usage: boot-client.sh <server-port> <vite-port>}
EVIDENCE=$TREE/operations/injection-marking-20260916/evidence
UNIT="injmark-client-$VITE_PORT"
mkdir -p "$EVIDENCE/logs"
systemd-run --scope --collect --unit="$UNIT" \
  --working-directory="$TREE/client" \
  env VITE_API_TARGET="http://127.0.0.1:$SRV_PORT" \
  "$TREE/node_modules/.bin/vite" --port "$VITE_PORT" --strictPort --host 127.0.0.1 \
  > "$EVIDENCE/logs/client-$VITE_PORT.log" 2>&1 &
echo "client unit=$UNIT port=$VITE_PORT target=$SRV_PORT"
for i in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:$VITE_PORT/" >/dev/null 2>&1; then echo "client up after ${i}s"; exit 0; fi
  sleep 1
done
echo "client failed to start"; exit 1
