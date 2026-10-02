#!/usr/bin/env bash
# Restart pi-web-ui.service for an unattended job, through the shared
# drain-then-restart path, within the job's time budget (B4 correction 01).
#
# WHY
#
# This is the restart entry point of scripts/command-code-weekly-refresh.ts,
# which runs it with a budget that covers the whole cycle — drain (20 s) +
# HTTP slack (10 s) + the unit's stop timeout (30 s) + a 90 s start margin,
# see RESTART_JOB_BUDGET_* in that script — and reads exit 1 + "refusing
# restart" on stderr as "restart deferred" (not a failure). Until B4
# correction 01 it had
# its own pre-flight that looked only at `activeTurns`: a follow-up accepted but
# not yet turning (zero active turns) was cut off silently, `--force` needed no
# reason, and the unit was hard-coded.
#
# WHAT IT DOES
#
# Delegates to scripts/restart-production.sh — the one canonical path — with a
# budget-sized drain: `--drain-timeout 20` (override with --drain-timeout N) and
# 10 s of HTTP slack, so the drain decision is made within ~30 s and the restart
# itself still fits the caller's budget, and `--on-timeout abort`: an unattended
# job never cuts work off. If the drain cannot settle in time, or the Internal
# API state cannot be confirmed, the drain is cancelled, nothing is restarted,
# and this script exits 1 with a "refusing restart" line.
#
# J1 (2026-10-02): a production-checkout guard refusal comes back with its own
# canonical exit status (3) and is passed through with its own message
# ("refusing restart (production checkout guard) …"). It is checkout state, not
# load: the Command Code weekly refresh must fail on it (its catalogue is
# already pushed), never read it as a capacity deferral.
#
# The canonical path takes the production-control lock itself (re-entrantly),
# names the requester in the journal and the durable stop audit, and honours
# the same target seams (PI_WEB_UI_SERVICE_UNIT, PI_WEB_UI_INTERNAL_API_SOCKET,
# PI_WEB_UI_INTERNAL_API_TOKEN_FILE, PI_WEB_UI_RESTART_SYSTEMCTL,
# PI_WEB_UI_NOTIFY_SCRIPT, PI_WEB_UI_STOP_AUDIT_FILE, PI_WEB_UI_SYSTEMD_CAT,
# PI_WEB_UI_PRODUCTION_LOCK).
#
# USE
#
#   scripts/restart-pi-web-ui.sh --reason "weekly catalogue refresh"
#   scripts/restart-pi-web-ui.sh --reason "why" --drain-timeout 25
#   scripts/restart-pi-web-ui.sh --reason "owner-approved override" --force
#   scripts/restart-pi-web-ui.sh --reason "check" --dry-run    # print targets only
#
#   --reason         why, in the caller's own words (required with --force)
#   --force          restart without a drain (recorded; needs a non-empty reason)
#   --drain-timeout  seconds the drain may take (default 20)
#   --dry-run        print the resolved targets, record the requester (drain=dry_run), stop
#   --no-lock        accepted for compatibility; the lock is re-entrant now

set -uo pipefail

ARGV_ORIGINAL="$*"
script_dir="$(cd -- "$(dirname -- "$0")" && pwd)"

REASON=""
FORCE=0
DRY_RUN=0
DRAIN_TIMEOUT="${PI_WEB_UI_JOB_DRAIN_TIMEOUT_SECONDS:-20}"

while [[ $# -gt 0 ]]; do
  case "${1:-}" in
    --reason) REASON="${2:-}"; shift 2 ;;
    --no-lock) shift ;;
    --force) FORCE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --drain-timeout) DRAIN_TIMEOUT="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,46p' "$0"; exit 0 ;;
    *)
      printf 'restart-pi-web-ui: unknown argument: %s\n' "$1" >&2
      exit 64
      ;;
  esac
done

if (( FORCE )) && [[ -z "${REASON//[[:space:]]/}" ]]; then
  printf 'restart-pi-web-ui: --force skips the drain and needs a non-empty --reason "why".\n' >&2
  exit 64
fi
[[ -n "${REASON//[[:space:]]/}" ]] || REASON="(unspecified)"

args=(--reason "$REASON" --drain-timeout "$DRAIN_TIMEOUT" --on-timeout abort)
(( FORCE )) && args+=(--force)

if (( DRY_RUN )); then
  # Unchanged contract: a dry run names the requester (recorded as drain=dry_run)
  # and stops. It never drains or restarts anything.
  bash "$script_dir/restart-production.sh" "${args[@]}" --show-targets || exit $?
  "$script_dir/record-restart-requester.sh" "$REASON" "$ARGV_ORIGINAL" "dry_run" || true
  printf 'restart-pi-web-ui: dry run — would drain-restart the unit above; nothing was drained or restarted\n' >&2
  exit 0
fi

PI_WEB_UI_DRAIN_HTTP_SLACK_SECONDS="${PI_WEB_UI_DRAIN_HTTP_SLACK_SECONDS:-10}" \
  bash "$script_dir/restart-production.sh" "${args[@]}"
status=$?
if (( status == 3 )); then
  # J1: the canonical path's checkout guard refused (wrong branch, dirty tree,
  # unreadable state, missing/unverifiable or stale-by-content build identity).
  # Checkout state — a restart cannot help. Distinct from the drain refusal
  # below so the weekly job reports it as the hard failure it is.
  printf 'restart-pi-web-ui: refusing restart (production checkout guard): the production checkout did not pass its safety guard (detail above); nothing was restarted.\n' >&2
elif (( status == 1 )); then
  printf 'restart-pi-web-ui: refusing restart: the drain did not settle within %ss or the Internal API state could not be confirmed (details above); nothing was restarted.\n' "$DRAIN_TIMEOUT" >&2
fi
exit "$status"
