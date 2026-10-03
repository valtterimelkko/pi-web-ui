#!/bin/bash
# E2a-6c DRAIN-ARM-ONLY runner (08-parent-note): acquire the stress lock,
# pre-flight, zai quota gate (>=15% left), fresh server, drain-timeout arm,
# then stop the units FIRST and release the lock only after they are down.
set -u
E2=/root/orch-ops/orchestration-scaling/e2
LOCK="$E2/stress-lock.d"
WT=/root/.worktrees/orch-scaling/e2-a6c-pi-web-ui
RUN=/root/e2a-runs/a6c/a6c-r1
cd "$WT" || exit 9
export PI_ORCH_PARENT=01a0fdf4-7259-759b-b4af-15ffbd22d619

deadline=$(( $(date +%s) + 45*60 ))
ACQUIRED=0
while [ "$(date +%s)" -lt "$deadline" ]; do
  if [ ! -f "$E2/host-guard/state/HOST-GUARD-TRIPPED" ] && [ ! -f "$E2/host-guard/state/HOST-GUARD-SOFT" ]; then
    if mkdir "$LOCK" 2>/dev/null; then ACQUIRED=1; break; fi
  fi
  sleep 240
done
if [ "$ACQUIRED" != "1" ]; then echo "LOCK_WAIT_TIMEOUT"; exit 3; fi
release() { rm -f "$LOCK/owner"; rmdir "$LOCK" 2>/dev/null; }
# The lock must only become free once MY units have stopped (08-parent-note).
cleanup() {
  node --import tsx scripts/e2a-crash/cli.ts stop-server --run-id a6c-r1 || true
  systemctl list-units 'e2a-6c-*' --no-legend --no-pager | wc -l
  release
}
trap 'cleanup' EXIT
echo "owner: lane E2a-6c drain-timeout arm unit(s) e2a-6c-server.service start $(date -u +%FT%T.%3NZ) expected end $(date -u -d '+75 minutes' +%FT%TZ)" > "$LOCK/owner"
echo "LOCK ACQUIRED at $(date -u +%FT%TZ)"

BOOT_T=$(date -u +%FT%TZ)
node --import tsx scripts/e2a-crash/preflight.ts || { echo "PREFLIGHT FAILED (drain)"; exit 4; }
node --import tsx scripts/e2a-crash/cli.ts stop-server --run-id a6c-r1 || true
rm -rf "$RUN/server"
node --import tsx scripts/e2a-crash/cli.ts prepare --run-id a6c-r1 --fixtures 6 || exit 5
node --import tsx scripts/e2a-crash/cli.ts start-server --run-id a6c-r1 --mode arm || exit 6
sleep 3
{
  echo "== boot-window since $BOOT_T =="
  journalctl -u e2a-6c-server.service --since "$BOOT_T" --no-pager 2>/dev/null | grep -E "Available (model )?providers|with auth" | tail -6
} >> "$RUN/state/boot-providers.log"
node --import tsx scripts/e2a-crash/cli.ts drain-arm --run-id a6c-r1 --children 4 || exit 17
node --import tsx scripts/e2a-crash/cli.ts stop-server --run-id a6c-r1 || true
mkdir -p "$RUN/samples/drain-server-evidence"
cp -r "$RUN/server/watches" "$RUN/samples/drain-server-evidence/" 2>/dev/null
cp -r "$RUN/server/run-receipts" "$RUN/samples/drain-server-evidence/" 2>/dev/null
cp -r "$RUN/server/pi-sessions" "$RUN/samples/drain-server-evidence/" 2>/dev/null
echo "DRAIN ARM COMPLETE at $(date -u +%FT%TZ)"
