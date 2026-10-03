#!/bin/bash
# 13 item 6: the drain runner must prepare fixtures 5-8 explicitly (never
# rebuilding the kill arm's fixtures 1-4) and assert the kill baselines stay
# unchanged. Usage: runner-fixture-range-check.sh /path/to/drain-runner.sh
set -u
f="$1"
[ -f "$f" ] || { echo "FAIL: runner not found: $f"; exit 1; }
grep -q -- "--from 5" "$f" || { echo "FAIL: drain runner does not prepare from fixture 5 (--from 5)"; exit 1; }
grep -q "baseline" "$f" || { echo "FAIL: drain runner has no kill-baseline assertion"; exit 1; }
echo "OK: $f prepares fixtures 5-8 explicitly and asserts kill baselines unchanged"
