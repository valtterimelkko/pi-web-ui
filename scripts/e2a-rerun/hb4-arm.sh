#!/usr/bin/env bash
# E2a-5 arm 1 — hb4 admission re-run inside its delegated transient unit.
# Mirrors hb4's run-proofs.sh invocation: Delegate=yes so the driver can build
# the production-shaped tools/control topology under its OWN unit cgroup.
# STRESS-GATE: caller must hold the stress lock and run the pre-flight.
#
# Usage: bash hb4-arm.sh [--run-dir=<dir>]
set -uo pipefail
WT="/root/.worktrees/orch-scaling/e2-a5-pi-web-ui"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_DIR="/root/e2a-runs/a5/hb4-${STAMP}"
for a in "$@"; do
  case "$a" in
    --run-dir=*) RUN_DIR="${a#--run-dir=}" ;;
  esac
done
mkdir -p "${RUN_DIR}"

systemd-run --quiet --collect --wait \
  --unit=e2a-5-admission \
  --property=Delegate=yes \
  --property=MemoryMax=6G \
  --property=MemorySwapMax=1G \
  --property=OOMPolicy=continue \
  --property=TasksMax=512 \
  --property=CPUQuota=400% \
  --setenv=PATH="${PATH}" \
  --setenv=HOME="${RUN_DIR}/fake-home-unit" \
  --working-directory="${RUN_DIR}" \
  node "${WT}/scripts/e2a-rerun/hb4-admission.mjs" \
    --worktree="${WT}" --run-dir="${RUN_DIR}"
rc=$?
echo "hb4-arm: driver exit ${rc}"
# unit self-terminates (--wait); verify gone
systemctl is-active e2a-5-admission >/dev/null 2>&1 && systemctl stop e2a-5-admission
exit "${rc}"
