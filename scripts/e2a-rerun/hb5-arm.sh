#!/usr/bin/env bash
# E2a-5 arm 4 — real-agy hb5 re-run inside transient unit e2a-5-hb5.
# STRESS-GATE: caller must hold the stress lock and run the pre-flight.
#
# Usage: bash hb5-arm.sh [--run-dir=<dir>]
set -uo pipefail
WT="/root/.worktrees/orch-scaling/e2-a5-pi-web-ui"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_DIR="/root/e2a-runs/a5/hb5-${STAMP}"
for a in "$@"; do
  case "$a" in
    --run-dir=*) RUN_DIR="${a#--run-dir=}" ;;
  esac
done
mkdir -p "${RUN_DIR}"

systemd-run --quiet --collect --wait \
  --unit=e2a-5-hb5 \
  --property=MemoryMax=8G \
  --property=MemorySwapMax=1G \
  --property=RuntimeMaxSec=1800 \
  --property=CPUWeight=100 \
  --setenv=PATH="${PATH}" \
  --working-directory="${RUN_DIR}" \
  node "${WT}/scripts/e2a-rerun/hb5-agy.mjs" \
    --worktree="${WT}" --run-dir="${RUN_DIR}" --unit=e2a-5-hb5
rc=$?
echo "hb5-arm: driver exit ${rc}"
systemctl is-active e2a-5-hb5 >/dev/null 2>&1 && systemctl stop e2a-5-hb5
exit "${rc}"
