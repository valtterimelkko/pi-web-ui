#!/usr/bin/env bash
# Starts the harness as a SINGLE node process (no npx wrapper), so the SIGTERM
# goes to the process the instrument actually lives in.
set -u
cd /root/pi-web-ui-wt-stability
start=$(date +%s.%N)
node --import tsx /tmp/child-S-live/wedge-harness.ts 2>&1 &
hpid=$!
sleep 3
echo "-- sending SIGTERM to harness pid $hpid --"
kill -TERM "$hpid" 2>/dev/null
# Backstop so a non-firing escape cannot hang this run.
( sleep 40; kill -KILL "$hpid" 2>/dev/null ) &
watchdog=$!
wait "$hpid"; rc=$?
kill "$watchdog" 2>/dev/null
end=$(date +%s.%N)
echo "EXIT_CODE=$rc  (137 = SIGKILL, i.e. the escape worker ended it; 143 = SIGTERM)"
awk -v s="$start" -v e="$end" 'BEGIN{printf "TOTAL_S=%.1f\n", e-s}'
