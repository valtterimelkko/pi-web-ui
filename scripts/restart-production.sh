#!/usr/bin/env bash
# Canonical production restart: DRAIN, then restart (B4, 2026-09-29).
#
# WHY
#
# pi-web-ui.service uses KillMode=control-group: a restart SIGKILLs every
# process inside the unit — including mid-turn orchestration children
# dispatched through the Internal API. The 2026-09-15 pre-flight refused while
# `.activeTurns > 0`, but it could not see queued work (a follow-up accepted
# but not yet turning), raced with new work arriving between the check and the
# restart, and left parents of any child it did kill to find out by polling.
#
# WHAT IT DOES (default)
#
#   1. POST /api/v1/drain on the Internal API socket. The server closes
#      admission for new P2/P3 creates and prompts (503 SERVER_DRAINING +
#      Retry-After; control and DELETE keep working) and answers when active
#      turns AND nonterminal run receipts have settled, or when the drain
#      timeout elapses (default 600 s, --drain-timeout N, 0..3600).
#   2. `settled` → restart. `timed_out` → restart and cut the remaining runs
#      off (they end `interrupted`, SERVER_RESTART / drain_timeout, and their
#      parents' watches fire at boot), unless --on-timeout abort, which cancels
#      the drain (DELETE /api/v1/drain) and restarts nothing.
#   3. Record the requester AND the drain verdict in the stop audit
#      (RESTART-REQUESTED ... drain=<verdict>), announce, restart the unit.
#
# Restarting WITHOUT a drain needs --force plus --reason; the audit records
# `drain=forced` and the reason.
#
# Edge cases, chosen deliberately:
#   * no socket or no token          → a dead daemon has no children: restart,
#                                      recorded `drain=skipped_no_daemon`;
#   * socket refuses connections      → same, `drain=skipped_unreachable`;
#   * server without /drain (404)     → the server predates B4 (e.g. the deploy
#                                      that ships B4): fall back to the legacy
#                                      active-turn pre-flight (refuse while > 0);
#   * drain request times out / other → REFUSE. A daemon that accepts and never
#     HTTP answer                       answers may be alive with children; only
#                                       --force --reason restarts past it.
#
# USE
#
#   npm run production:drain-restart -- --reason "deploy contract 1.51.0"
#   scripts/restart-production.sh --reason "why" [--drain-timeout 900] [--on-timeout abort]
#   scripts/restart-production.sh --force --reason "why no drain"   # recorded override
#   scripts/restart-production.sh --show-targets                     # print targets, do nothing
#
# Unknown arguments are refused rather than ignored: a caller who passes
# `--dry-run` (which this script does not implement) must not silently get a
# real restart. Use --show-targets to inspect what would be touched.
#
# TARGET SEAMS (defaults are the production values; tests and disposable live
# proofs override them so nothing can touch the real service, socket, journal
# or audit file):
#
#   PI_WEB_UI_SERVICE_UNIT             unit to restart (default pi-web-ui.service)
#   PI_WEB_UI_INTERNAL_API_SOCKET      Internal API unix socket
#                                      (default /root/.pi-web-ui/internal-api.sock)
#   PI_WEB_UI_INTERNAL_API_TOKEN_FILE  bearer token file
#                                      (default /root/.pi-web-ui/internal-api-token)
#   PI_WEB_UI_RESTART_SYSTEMCTL        systemctl binary (default systemctl)
#   PI_WEB_UI_NOTIFY_SCRIPT            notify hook (default
#                                      /root/pi-web-ui/scripts/notify.sh)
#   PI_WEB_UI_STOP_AUDIT_FILE          stop audit (record-restart-requester.sh)
#   PI_WEB_UI_DRAIN_TIMEOUT_SECONDS    default drain timeout (600)
#
# This script never runs on its own authority: production restart remains
# owner-gated. The production lock is taken by the npm script
# (production:drain-restart) or by with-production-lock.sh, which also routes a
# bare `systemctl restart pi-web-ui[.service]` here.

set -euo pipefail

# Captured before any argument parsing, so the record shows what was asked for.
ARGV_ORIGINAL="$*"
script_dir="$(cd -- "$(dirname -- "$0")" && pwd)"

FORCE=0
REASON=""
DRAIN_TIMEOUT="${PI_WEB_UI_DRAIN_TIMEOUT_SECONDS:-600}"
ON_TIMEOUT="restart"
SHOW_TARGETS=0
while [ $# -gt 0 ]; do
  case "${1:-}" in
    --force) FORCE=1; shift ;;
    --reason) REASON="${2:-}"; shift 2 ;;
    --drain-timeout) DRAIN_TIMEOUT="${2:-}"; shift 2 ;;
    --on-timeout) ON_TIMEOUT="${2:-}"; shift 2 ;;
    --show-targets) SHOW_TARGETS=1; shift ;;
    *)
      echo "restart-production.sh: unknown argument: ${1}" >&2
      exit 64
      ;;
  esac
done

if ! [[ "$DRAIN_TIMEOUT" =~ ^[0-9]+$ ]] || [ "$DRAIN_TIMEOUT" -gt 3600 ]; then
  echo "restart-production.sh: --drain-timeout must be an integer number of seconds in 0..3600 (got '${DRAIN_TIMEOUT}')" >&2
  exit 64
fi
case "$ON_TIMEOUT" in
  restart|abort) ;;
  *) echo "restart-production.sh: --on-timeout must be 'restart' or 'abort' (got '${ON_TIMEOUT}')" >&2; exit 64 ;;
esac

UNIT="${PI_WEB_UI_SERVICE_UNIT:-pi-web-ui.service}"
SOCKET="${PI_WEB_UI_INTERNAL_API_SOCKET:-/root/.pi-web-ui/internal-api.sock}"
TOKEN_FILE="${PI_WEB_UI_INTERNAL_API_TOKEN_FILE:-/root/.pi-web-ui/internal-api-token}"
SYSTEMCTL_BIN="${PI_WEB_UI_RESTART_SYSTEMCTL:-systemctl}"
NOTIFY_SCRIPT="${PI_WEB_UI_NOTIFY_SCRIPT:-/root/pi-web-ui/scripts/notify.sh}"
AUDIT_FILE="${PI_WEB_UI_STOP_AUDIT_FILE:-/root/.pi-web-ui/stop-audit.log}"

if [ "$SHOW_TARGETS" -eq 1 ]; then
  printf 'unit=%s\nsocket=%s\ntoken_file=%s\nsystemctl=%s\nnotify=%s\nstop_audit=%s\ndrain=%s\ndrain_timeout_seconds=%s\non_timeout=%s\n' \
    "$UNIT" "$SOCKET" "$TOKEN_FILE" "$SYSTEMCTL_BIN" "$NOTIFY_SCRIPT" "$AUDIT_FILE" \
    "$([ "$FORCE" -eq 1 ] && echo forced || echo default)" "$DRAIN_TIMEOUT" "$ON_TIMEOUT"
  exit 0
fi

if [ "$FORCE" -eq 1 ] && [ -z "${REASON//[[:space:]]/}" ]; then
  echo "restart-production.sh: --force skips the drain and needs --reason \"why\" (recorded in the stop audit)." >&2
  exit 64
fi
[ -n "${REASON//[[:space:]]/}" ] || REASON="(unspecified)"

TOKEN="$(cat "$TOKEN_FILE" 2>/dev/null || true)"
DRAIN_SUMMARY=""

refuse() {
  echo "ERROR: Refusing production restart: $1" >&2
  echo "Wait and retry, or pass --force --reason \"why\" to restart without a drain (recorded)." >&2
  exit 1
}

legacy_preflight() {
  # The running server predates B4 (no /api/v1/drain): use the 2026-09-15
  # active-turn pre-flight so the deploy that ships B4 is still guarded.
  local capacity active
  capacity="$(curl -s --unix-socket "$SOCKET" -H "Authorization: Bearer $TOKEN" --max-time 30 http://localhost/api/v1/capacity || true)"
  active="$(printf '%s' "$capacity" | jq -r '.activeTurns // 0' 2>/dev/null || echo 0)"
  if [[ "$active" =~ ^[0-9]+$ ]] && [ "$active" -gt 0 ]; then
    refuse "$active active child turn(s) in progress (server has no drain endpoint)."
  fi
  DRAIN_SUMMARY="legacy_preflight,active_turns=${active:-0}"
}

if [ "$FORCE" -eq 1 ]; then
  DRAIN_SUMMARY="forced"
elif [ ! -S "$SOCKET" ] || [ -z "$TOKEN" ]; then
  DRAIN_SUMMARY="skipped_no_daemon"
else
  body_file="$(mktemp)"
  trap 'rm -f "$body_file"' EXIT
  payload="$(jq -cn --arg reason "${REASON:0:500}" --argjson t "$DRAIN_TIMEOUT" '{reason: $reason, timeoutSeconds: $t}')"
  echo "Draining ${UNIT} (timeout ${DRAIN_TIMEOUT}s): new sessions and prompts are refused while in-flight runs settle..." >&2
  set +e
  http_code="$(curl -sS --unix-socket "$SOCKET" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -X POST --data-binary "$payload" --max-time "$((DRAIN_TIMEOUT + 60))" \
    -o "$body_file" -w '%{http_code}' http://localhost/api/v1/drain)"
  curl_status=$?
  set -e
  if [ "$curl_status" -eq 7 ]; then
    DRAIN_SUMMARY="skipped_unreachable"
  elif [ "$curl_status" -ne 0 ]; then
    refuse "the drain request did not complete (curl exit ${curl_status}); the daemon may be alive with children."
  elif [ "$http_code" = "404" ]; then
    legacy_preflight
  elif [ "$http_code" != "200" ]; then
    refuse "the drain request failed with HTTP ${http_code}."
  else
    state="$(jq -r '.state // empty' "$body_file" 2>/dev/null || true)"
    summary="$(jq -r '[.state,
        "waited_ms=\(.waitedMs // 0)",
        "initial_runs=\(.initial.nonterminalRuns // 0)",
        "initial_turns=\(.initial.activeTurns // 0)",
        "completed=\(.completedDuringDrain // 0)",
        "cut_off=\((.cutOffRunIds // []) | length)"]
      + (if ((.cutOffRunIds // []) | length) > 0 then ["cut_off_runs=" + ((.cutOffRunIds // [])[:20] | join("+"))] else [] end)
      | join(",")' "$body_file" 2>/dev/null || true)"
    case "$state" in
      settled)
        DRAIN_SUMMARY="$summary"
        echo "Drain settled: ${summary}" >&2
        ;;
      timed_out)
        cut_off="$(jq -r '(.cutOffRunIds // []) | length' "$body_file")"
        if [ "$ON_TIMEOUT" = "abort" ]; then
          curl -sS --unix-socket "$SOCKET" -H "Authorization: Bearer $TOKEN" -X DELETE --max-time 30 \
            -o /dev/null -w '%{http_code}' http://localhost/api/v1/drain >/dev/null || true
          refuse "the drain timed out with ${cut_off} run(s) still in flight (--on-timeout abort); the drain was cancelled and admission reopened."
        fi
        DRAIN_SUMMARY="$summary"
        echo "Drain timed out: the restart will cut off ${cut_off} run(s): ${summary}" >&2
        ;;
      *)
        refuse "the drain answered an unexpected state '${state:-none}' (cancelled concurrently?)."
        ;;
    esac
  fi
fi

echo "Initiating production restart of ${UNIT} (drain: ${DRAIN_SUMMARY})..."
# Name the requester AND the drain verdict in the journal and the durable
# record BEFORE restarting — the same shared recorder restart-pi-web-ui.sh uses.
"$script_dir/record-restart-requester.sh" "$REASON" "$ARGV_ORIGINAL" "$DRAIN_SUMMARY" || true
"$NOTIFY_SCRIPT" milestone "Production restart initiated" "${UNIT} restarting after drain: ${DRAIN_SUMMARY}" || true
"$SYSTEMCTL_BIN" restart "$UNIT"
echo "Production restart complete."
