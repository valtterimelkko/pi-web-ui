#!/usr/bin/env bash
# Canonical production restart: DRAIN, then restart (B4, 2026-09-29;
# fail-closed and verb semantics from B4 correction 01).
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
# WHAT IT DOES
#
#   0. Take the production-control lock (re-entrant: a caller already holding
#      it through scripts/with-production-lock.sh or the npm entry point is not
#      blocked; an independent holder makes this refuse with exit 75).
#   1. Ask systemd whether the unit is running (`systemctl is-active`).
#      - confirmed NOT running (inactive / failed): there are no children, so
#        there is nothing to drain. `try-restart` is then a no-op (exit 0,
#        recorded as RESTART-NOOP); `restart` / `reload-or-restart` start the
#        unit, which is what those verbs mean.
#      - anything else is treated as running.
#   2. Running: POST /api/v1/drain on the Internal API socket. The server closes
#      admission for new P2/P3 creates and prompts (503 SERVER_DRAINING +
#      Retry-After; control and DELETE keep working) and answers when active
#      turns AND nonterminal run receipts have settled, or when the drain
#      timeout elapses (default 600 s, --drain-timeout N, 0..3600).
#      `settled` → restart. `timed_out` → restart and cut the remaining runs off
#      (they end `interrupted`, SERVER_RESTART / drain_timeout, and their parents'
#      watches fire at boot), unless --on-timeout abort, which cancels the drain
#      (DELETE /api/v1/drain), restarts nothing and exits 1.
#   3. Record the requester, the verb and the drain verdict in the stop audit
#      (RESTART-REQUESTED … drain=<verdict> verb=<verb> unit=<unit>), announce,
#      then run the requested verb (`systemctl <verb> <unit>`).
#
# FAIL CLOSED. On a running unit, every state this script cannot confirm is a
# refusal (exit 1): no socket or token, a socket that refuses connections, a
# drain request that times out or answers anything but 200 with a known state,
# and — on a server that predates the drain endpoint (404) — a legacy
# /capacity answer that is not HTTP 200 with a numeric activeTurns of 0.
# `--force --reason "why"` is the named way past any of these: it skips the
# drain, and it refuses unless the audit file or the journal durably records
# the override (`drain=forced`).
#
# USE
#
#   npm run production:drain-restart -- --reason "deploy contract 1.51.0"
#   scripts/restart-production.sh --reason "why" [--verb restart|try-restart|reload-or-restart]
#                                 [--drain-timeout 900] [--on-timeout restart|abort]
#   scripts/restart-production.sh --force --reason "why no drain"   # recorded override
#   scripts/restart-production.sh --show-targets                     # print targets, do nothing
#
# Unknown arguments are refused rather than ignored: a caller who passes
# `--dry-run` (which this script does not implement) must not silently get a
# real restart. Use --show-targets to inspect what would be touched.
#
# TARGET SEAMS (defaults are the production values; tests and disposable live
# proofs override them so nothing can touch the real service, socket, lock,
# journal or audit file):
#
#   PI_WEB_UI_SERVICE_UNIT             unit (default pi-web-ui.service)
#   PI_WEB_UI_INTERNAL_API_SOCKET      Internal API unix socket
#                                      (default /root/.pi-web-ui/internal-api.sock)
#   PI_WEB_UI_INTERNAL_API_TOKEN_FILE  bearer token file
#                                      (default /root/.pi-web-ui/internal-api-token)
#   PI_WEB_UI_RESTART_SYSTEMCTL        systemctl binary (default systemctl)
#   PI_WEB_UI_NOTIFY_SCRIPT            notify hook (default
#                                      /root/pi-web-ui/scripts/notify.sh)
#   PI_WEB_UI_STOP_AUDIT_FILE          stop audit (record-restart-requester.sh)
#   PI_WEB_UI_PRODUCTION_LOCK          production-control lock
#                                      (default ~/.pi-web-ui/production-control.lock)
#   PI_WEB_UI_DRAIN_TIMEOUT_SECONDS    default drain timeout (600)
#   PI_WEB_UI_DRAIN_HTTP_SLACK_SECONDS HTTP wait beyond the drain timeout (60);
#                                      budgeted callers (restart-pi-web-ui.sh) lower it
#   PI_WEB_UI_CHECKOUT_DIR             production checkout dir
#                                      (default /root/pi-web-ui)
#   PI_WEB_UI_EXPECTED_BRANCH          expected git branch (default master)
#
# This script never runs on its own authority: production restart remains
# owner-gated.

set -euo pipefail

# Captured before any argument parsing: the record shows what was asked for,
# and the lock re-exec below replays the exact argument vector.
ARGV_ORIGINAL="$*"
ORIGINAL_ARGS=("$@")
script_dir="$(cd -- "$(dirname -- "$0")" && pwd)"

FORCE=0
REASON=""
DRAIN_TIMEOUT="${PI_WEB_UI_DRAIN_TIMEOUT_SECONDS:-600}"
ON_TIMEOUT="restart"
VERB="restart"
SHOW_TARGETS=0
CHECKOUT_DIR_ARG=""
EXPECTED_BRANCH_ARG=""
while [ $# -gt 0 ]; do
  case "${1:-}" in
    --force) FORCE=1; shift ;;
    --reason) REASON="${2:-}"; shift 2 ;;
    --drain-timeout) DRAIN_TIMEOUT="${2:-}"; shift 2 ;;
    --on-timeout) ON_TIMEOUT="${2:-}"; shift 2 ;;
    --verb) VERB="${2:-}"; shift 2 ;;
    --checkout-dir) CHECKOUT_DIR_ARG="${2:-}"; shift 2 ;;
    --expected-branch) EXPECTED_BRANCH_ARG="${2:-}"; shift 2 ;;
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
case "$VERB" in
  restart|try-restart|reload-or-restart) ;;
  *) echo "restart-production.sh: --verb must be restart, try-restart or reload-or-restart (got '${VERB}')" >&2; exit 64 ;;
esac

UNIT="${PI_WEB_UI_SERVICE_UNIT:-pi-web-ui.service}"
SOCKET="${PI_WEB_UI_INTERNAL_API_SOCKET:-/root/.pi-web-ui/internal-api.sock}"
TOKEN_FILE="${PI_WEB_UI_INTERNAL_API_TOKEN_FILE:-/root/.pi-web-ui/internal-api-token}"
SYSTEMCTL_BIN="${PI_WEB_UI_RESTART_SYSTEMCTL:-systemctl}"
NOTIFY_SCRIPT="${PI_WEB_UI_NOTIFY_SCRIPT:-/root/pi-web-ui/scripts/notify.sh}"
AUDIT_FILE="${PI_WEB_UI_STOP_AUDIT_FILE:-/root/.pi-web-ui/stop-audit.log}"
LOCK_PATH="${PI_WEB_UI_PRODUCTION_LOCK:-$HOME/.pi-web-ui/production-control.lock}"
HTTP_SLACK="${PI_WEB_UI_DRAIN_HTTP_SLACK_SECONDS:-60}"
if ! [[ "$HTTP_SLACK" =~ ^[0-9]+$ ]] || [ "$HTTP_SLACK" -gt 600 ]; then
  echo "restart-production.sh: PI_WEB_UI_DRAIN_HTTP_SLACK_SECONDS must be an integer in 0..600 (got '${HTTP_SLACK}')" >&2
  exit 64
fi
CHECKOUT_DIR="${CHECKOUT_DIR_ARG:-${PI_WEB_UI_CHECKOUT_DIR:-/root/pi-web-ui}}"
EXPECTED_BRANCH="${EXPECTED_BRANCH_ARG:-${PI_WEB_UI_EXPECTED_BRANCH:-master}}"

if [ "$SHOW_TARGETS" -eq 1 ]; then
  printf 'unit=%s\nverb=%s\nsocket=%s\ntoken_file=%s\nsystemctl=%s\nnotify=%s\nstop_audit=%s\nlock=%s\ndrain=%s\ndrain_timeout_seconds=%s\ndrain_http_slack_seconds=%s\non_timeout=%s\ncheckout_dir=%s\nexpected_branch=%s\n' \
    "$UNIT" "$VERB" "$SOCKET" "$TOKEN_FILE" "$SYSTEMCTL_BIN" "$NOTIFY_SCRIPT" "$AUDIT_FILE" "$LOCK_PATH" \
    "$([ "$FORCE" -eq 1 ] && echo forced || echo default)" "$DRAIN_TIMEOUT" "$HTTP_SLACK" "$ON_TIMEOUT" \
    "$CHECKOUT_DIR" "$EXPECTED_BRANCH"
  exit 0
fi

if [ "$FORCE" -eq 1 ] && [ -z "${REASON//[[:space:]]/}" ]; then
  echo "restart-production.sh: --force skips the drain and needs a non-empty --reason \"why\" (recorded in the stop audit)." >&2
  exit 64
fi
[ -n "${REASON//[[:space:]]/}" ] || REASON="(unspecified)"

# 0. The production-control lock, re-entrantly (B4 correction 01, finding 7).
if [ "${PI_WEB_UI_PRODUCTION_LOCK_HELD:-}" != "$LOCK_PATH" ]; then
  exec bash "$script_dir/with-production-lock.sh" bash "$script_dir/restart-production.sh" "${ORIGINAL_ARGS[@]}"
fi

TOKEN="$(cat "$TOKEN_FILE" 2>/dev/null || true)"
DRAIN_SUMMARY=""

refuse() {
  echo "ERROR: Refusing production restart: $1" >&2
  echo "Wait and retry, or pass --force --reason \"why\" to restart without a drain (recorded)." >&2
  exit 1
}

record() { # $1 = record kind, $2 = drain verdict
  PI_WEB_UI_RESTART_RECORD_KIND="$1" \
  PI_WEB_UI_RESTART_VERB="$VERB" \
  PI_WEB_UI_RESTART_UNIT="$UNIT" \
  PI_WEB_UI_RESTART_REQUIRE_DURABLE="$FORCE" \
    "$script_dir/record-restart-requester.sh" "$REASON" "$ARGV_ORIGINAL" "$2"
}

legacy_preflight() {
  # The running server predates B4 (no /api/v1/drain): use the 2026-09-15
  # active-turn pre-flight so the deploy that ships B4 is still guarded — and
  # accept only an unambiguous HTTP 200 with a numeric activeTurns.
  local cap_file cap_code cap_status active
  cap_file="$(mktemp)"
  set +e
  cap_code="$(curl -sS --unix-socket "$SOCKET" -H "Authorization: Bearer $TOKEN" --max-time 30 \
    -o "$cap_file" -w '%{http_code}' http://localhost/api/v1/capacity)"
  cap_status=$?
  set -e
  active="$(jq -r '.activeTurns' "$cap_file" 2>/dev/null || true)"
  rm -f "$cap_file"
  [ "$cap_status" -eq 0 ] || refuse "the server has no drain endpoint and its legacy capacity query failed (curl exit ${cap_status})."
  [ "$cap_code" = "200" ] || refuse "the server has no drain endpoint and its legacy capacity query answered HTTP ${cap_code}."
  [[ "$active" =~ ^[0-9]+$ ]] || refuse "the server has no drain endpoint and its legacy capacity answer has no numeric activeTurns."
  if [ "$active" -gt 0 ]; then
    refuse "$active active child turn(s) in progress (server has no drain endpoint)."
  fi
  DRAIN_SUMMARY="legacy_preflight,active_turns=${active}"
}

check_production_checkout_safety() {
  if [ "$FORCE" -eq 1 ]; then
    return 0
  fi

  if [ ! -d "$CHECKOUT_DIR" ]; then
    refuse "production checkout directory '$CHECKOUT_DIR' does not exist."
  fi

  if ! git -C "$CHECKOUT_DIR" rev-parse --git-dir >/dev/null 2>&1; then
    refuse "production checkout at '$CHECKOUT_DIR' is not a git repository."
  fi

  local current_branch
  current_branch="$(git -C "$CHECKOUT_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  if [ "$current_branch" != "$EXPECTED_BRANCH" ]; then
    refuse "production checkout at '$CHECKOUT_DIR' is on branch '${current_branch}', expected '${EXPECTED_BRANCH}'."
  fi

  local dirty_tracked
  dirty_tracked="$(git -C "$CHECKOUT_DIR" status --porcelain --untracked-files=no 2>/dev/null || true)"
  if [ -n "$dirty_tracked" ]; then
    refuse "production checkout at '$CHECKOUT_DIR' has modified or staged tracked files:\n${dirty_tracked}"
  fi

  local manifest_path
  manifest_path="$CHECKOUT_DIR/server/dist/build-identity/embedded-manifest.json"
  if [ ! -f "$manifest_path" ]; then
    refuse "production checkout at '$CHECKOUT_DIR' has no built server/dist build identity at '${manifest_path}' (run 'npm run build' before restarting)."
  fi

  local manifest_rev head_rev
  manifest_rev="$(jq -r '.revision // empty' "$manifest_path" 2>/dev/null || true)"
  if [ -z "$manifest_rev" ] || [ "$manifest_rev" = "unknown" ]; then
    refuse "production checkout at '$CHECKOUT_DIR' has an invalid or unknown build revision in '${manifest_path}'."
  fi

  head_rev="$(git -C "$CHECKOUT_DIR" rev-parse HEAD 2>/dev/null || true)"
  if [ "$manifest_rev" != "$head_rev" ]; then
    refuse "production checkout at '$CHECKOUT_DIR' server/dist build revision '${manifest_rev}' does not match HEAD '${head_rev}' (dist is stale; rebuild before restarting)."
  fi
}

# 0b. Production checkout safety guard (H-wave incident: refuse if wrong branch, dirty/staged tracked files, or stale dist).
check_production_checkout_safety

# 1. Is the unit running? Only inactive/failed count as confirmed not running.
UNIT_STATE="$("$SYSTEMCTL_BIN" is-active "$UNIT" 2>/dev/null | head -n 1 || true)"
UNIT_STATE="${UNIT_STATE//[[:space:]]/}"
UNIT_DOWN=0
case "$UNIT_STATE" in
  inactive|failed) UNIT_DOWN=1 ;;
esac

if [ "$FORCE" -eq 1 ]; then
  DRAIN_SUMMARY="forced"
elif [ "$UNIT_DOWN" -eq 1 ]; then
  if [ "$VERB" = "try-restart" ]; then
    # try-restart never starts a stopped unit; do not call it at all (no race).
    record RESTART-NOOP "unit_${UNIT_STATE}_noop" || true
    echo "${UNIT} is ${UNIT_STATE}: try-restart is a no-op; nothing was started (recorded as RESTART-NOOP)."
    exit 0
  fi
  DRAIN_SUMMARY="skipped_unit_${UNIT_STATE}"
elif [ ! -S "$SOCKET" ] || [ -z "$TOKEN" ]; then
  refuse "${UNIT} is ${UNIT_STATE:-in an unknown state} but the Internal API socket or token is unavailable, so its in-flight work cannot be drained."
else
  # 2. Drain.
  body_file="$(mktemp)"
  trap 'rm -f "$body_file"' EXIT
  # Correction 01 (self-drain): a caller that runs the deploy from its own
  # agent session (browser or managed Pi agent) is itself busy, so the drain
  # would wait the full timeout for — then kill — the caller. Forward the
  # caller's session id (PI_WEB_UI_SESSION_ID, else PI_SESSION_ID) as
  # excludeSessionIds; the server lifts only the busy-session wait for it.
  CALLER_SESSION_ID="${PI_WEB_UI_SESSION_ID:-${PI_SESSION_ID:-}}"
  case "$CALLER_SESSION_ID" in
    ''|*[!a-zA-Z0-9_-]*)
      if [ -n "$CALLER_SESSION_ID" ]; then
        echo "Self-drain guard: caller session id is empty or unsafe; not forwarding it." >&2
      fi
      CALLER_SESSION_ID="" ;;
  esac
  if [ -n "$CALLER_SESSION_ID" ]; then
    payload="$(jq -cn --arg reason "${REASON:0:500}" --argjson t "$DRAIN_TIMEOUT" --arg sid "$CALLER_SESSION_ID" \
      '{reason: $reason, timeoutSeconds: $t} + {excludeSessionIds: [$sid]}')"
    echo "Self-drain guard: excluding the caller session ${CALLER_SESSION_ID} from the drain's busy-session wait." >&2
  else
    payload="$(jq -cn --arg reason "${REASON:0:500}" --argjson t "$DRAIN_TIMEOUT" '{reason: $reason, timeoutSeconds: $t}')"
  fi
  echo "Draining ${UNIT} (timeout ${DRAIN_TIMEOUT}s): new sessions and prompts are refused while in-flight runs settle..." >&2
  set +e
  http_code="$(curl -sS --unix-socket "$SOCKET" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -X POST --data-binary "$payload" --max-time "$((DRAIN_TIMEOUT + HTTP_SLACK))" \
    -o "$body_file" -w '%{http_code}' http://localhost/api/v1/drain)"
  curl_status=$?
  set -e
  if [ "$curl_status" -ne 0 ]; then
    refuse "the drain request did not complete (curl exit ${curl_status}); ${UNIT} is ${UNIT_STATE:-in an unknown state} and may have children in flight."
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
        "cut_off=\((.cutOffRunIds // []) | length)",
        "cut_off_sessions=\((.cutOffSessionIds // []) | length)"]
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

# 3. Record, announce, act.
echo "Initiating production ${VERB} of ${UNIT} (drain: ${DRAIN_SUMMARY})..."
if ! record RESTART-REQUESTED "$DRAIN_SUMMARY"; then
  if [ "$FORCE" -eq 1 ]; then
    refuse "the forced ${VERB} could not be recorded durably (neither the audit file nor the journal accepted it)."
  fi
fi
"$NOTIFY_SCRIPT" milestone "Production restart initiated" "${UNIT} ${VERB} after drain: ${DRAIN_SUMMARY}" || true
"$SYSTEMCTL_BIN" "$VERB" "$UNIT"
echo "Production ${VERB} complete."
