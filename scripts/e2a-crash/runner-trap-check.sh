#!/bin/bash
# 09-correction item 5: scripted check that a runner's EXIT trap stops the
# e2a-6c units BEFORE releasing the stress lock (08-note item 2).
# Usage: runner-trap-check.sh /path/to/runner.sh
set -u
f="$1"
[ -f "$f" ] || { echo "runner not found: $f"; exit 1; }
# Extract the cleanup()/trap handler body: from 'cleanup()' or "trap '" to the end of that function.
body=$(awk '/^(cleanup\(\)|trap .)/{found=1} found{print} found && /^}/ && NR>1{exit}' "$f")
[ -n "$body" ] || body=$(grep -A6 "trap '" "$f")
echo "$body" | grep -q "stop-server" || { echo "FAIL: trap/cleanup body does not stop the units"; exit 1; }
echo "$body" | grep -q "release" || { echo "FAIL: trap/cleanup body does not release the lock"; exit 1; }
stop_pos=$(echo "$body" | grep -n "stop-server" | head -1 | cut -d: -f1)
release_pos=$(echo "$body" | grep -n "release" | head -1 | cut -d: -f1)
if [ "$stop_pos" -lt "$release_pos" ]; then
  echo "OK: $f — trap stops the units (cleanup line $stop_pos) BEFORE releasing the lock (cleanup line $release_pos)"
else
  echo "FAIL: release (line $release_pos) happens before unit stop (line $stop_pos) in the trap"; exit 1
fi
