#!/usr/bin/env bash
# Stop audit for pi-web-ui.service — drop-in companion (2026-09-15).
#
# WHY THIS EXISTS
#
# Between 2026-09-14 15:26 and 2026-09-15 08:30 the service was SIGKILLed by
# systemd after `TimeoutStopSec=30` SEVEN times, and the journal could not say
# why:
#
#   * there was no `Stopping pi-web-ui.service...` line (systemd only emits that
#     when `unit_stop()` returns > 0 — see systemd v255 src/core/job.c:873-878
#     and src/core/service.c:2765-2821 — so its absence means the stop did not
#     come from a stop job against a RUNNING unit);
#   * there was no app-side record at all (`Shutting down...`, no step timings);
#   * `auditd` is not installed, so the *requester* cannot be named.
#
# `ExecStopPre` is the only stop hook that runs BEFORE SIGTERM is sent, so it is
# the only place that can prove "systemd was about to signal this unit" while the
# app is still alive. That makes the pair decisive next time:
#
#   STOP-AUDIT phase=pre  present, app `[Shutdown] event=stop_signal` absent
#     -> SIGTERM was sent and the process did not handle it.
#   STOP-AUDIT phase=pre  absent
#     -> the stop never reached the signal stage at all.
#
# It writes to the journal AND to a bounded append-only file, because the
# journal has already lost a stop line once (no `Stopping ...` for the 08:30
# event) and a single lost line is the whole difference between a diagnosis and
# another unexplained restart. The file is the record of last resort.
#
# This script MUST NOT fail the stop: a failing ExecStopPre/ExecStopPost marks
# the unit failed. Every step is best-effort and the exit status is always 0.
#
# Install via the drop-in (see deploy/systemd/pi-web-ui.service.d/10-stop-audit.conf).

set +e

PHASE="${1:-unknown}"
AUDIT_FILE="${PI_WEB_UI_STOP_AUDIT_FILE:-/root/.pi-web-ui/stop-audit.log}"
MAX_LINES="${PI_WEB_UI_STOP_AUDIT_MAX_LINES:-400}"

ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
invocation="${INVOCATION_ID:-unset}"
mainpid="${MAINPID:-0}"

# systemd sets SERVICE_RESULT / EXIT_CODE / EXIT_STATUS for ExecStopPost (and
# ExecStop), but not for ExecStopPre — record them as `unset` rather than
# guessing.
service_result="${SERVICE_RESULT:-unset}"
exit_code="${EXIT_CODE:-unset}"
exit_status="${EXIT_STATUS:-unset}"

# Is the main process still alive at the moment this hook runs? At `pre` a `yes`
# is expected and proves the hook ran before the signal; a `no` at `post` with
# code=killed/signal=KILL is the SIGKILL signature.
main_alive="unknown"
if [[ "$mainpid" =~ ^[0-9]+$ ]] && [[ "$mainpid" != "0" ]]; then
  if kill -0 "$mainpid" 2>/dev/null; then main_alive="yes"; else main_alive="no"; fi
fi

# Live unit state, asked of systemd itself. `Result` is what distinguishes a
# timeout from a clean exit even when the app never spoke.
sub_state="$(systemctl show pi-web-ui.service -p SubState --value 2>/dev/null)"
active_state="$(systemctl show pi-web-ui.service -p ActiveState --value 2>/dev/null)"
unit_result="$(systemctl show pi-web-ui.service -p Result --value 2>/dev/null)"
nrestarts="$(systemctl show pi-web-ui.service -p NRestarts --value 2>/dev/null)"
main_start="$(systemctl show pi-web-ui.service -p ExecMainStartTimestamp --value 2>/dev/null)"

# What a stop would take with it. On 2026-09-15 08:30 the answer was one
# validation server, `npm exec tsx`, three esbuild processes and four mid-turn
# orchestration children — the cost of `KillMode=control-group`. Recording the
# census makes that visible *before* it is paid again.
cgroup_procs="unknown"
proc_names=""
cgroup_path="/sys/fs/cgroup/system.slice/pi-web-ui.service"
if [[ -r "$cgroup_path/cgroup.procs" ]]; then
  cgroup_procs="$(wc -l < "$cgroup_path/cgroup.procs" 2>/dev/null | tr -d ' ')"
  proc_names="$(
    while read -r pid; do
      [[ -r "/proc/$pid/comm" ]] && head -c 40 "/proc/$pid/comm" 2>/dev/null && printf ','
    done < "$cgroup_path/cgroup.procs" 2>/dev/null | tr -d '\n' | sed 's/,$//'
  )"
fi

# How long the stop took, derived from the matching `pre` line for this
# invocation — the one piece of timing the app cannot report when it is killed.
elapsed_s="unset"
if [[ "$PHASE" == "post" ]] && [[ "$invocation" != "unset" ]] && [[ -r "$AUDIT_FILE" ]]; then
  # The record is `STOP-AUDIT phase=pre ts=... invocation=...`, so the two fixed
  # strings are matched independently — matching them as one substring never
  # finds anything and silently reports elapsed as unset.
  pre_ts="$(grep -F 'phase=pre ' "$AUDIT_FILE" 2>/dev/null | grep -F "invocation=$invocation " | tail -n 1 | sed -n 's/.* ts=\([^ ]*\).*/\1/p')"
  if [[ -n "$pre_ts" ]]; then
    pre_epoch="$(date -u -d "$pre_ts" +%s 2>/dev/null)"
    post_epoch="$(date -u +%s)"
    [[ -n "$pre_epoch" ]] && elapsed_s="$(( post_epoch - pre_epoch ))"
  fi
fi

LINE="STOP-AUDIT phase=$PHASE ts=$ts invocation=$invocation service_result=$service_result exit_code=$exit_code exit_status=$exit_status mainpid=$mainpid main_alive=$main_alive active_state=$active_state sub_state=$sub_state unit_result=$unit_result nrestarts=$nrestarts elapsed_s=$elapsed_s main_started=$main_start cgroup_procs=$cgroup_procs procs=$proc_names"

# Journal first (the unit routes this to syslog), then the durable file. Both,
# because each has failed to be enough at least once.
printf '%s\n' "$LINE"
mkdir -p "$(dirname "$AUDIT_FILE")" 2>/dev/null
printf '%s\n' "$LINE" >> "$AUDIT_FILE" 2>/dev/null

# Bounded: the audit file must not grow without limit, but trimming only when it
# is genuinely oversized keeps the common stop cheap.
if [[ -f "$AUDIT_FILE" ]]; then
  line_count="$(wc -l < "$AUDIT_FILE" 2>/dev/null | tr -d ' ')"
  if [[ "$line_count" =~ ^[0-9]+$ ]] && (( line_count > MAX_LINES * 4 )); then
    tail -n "$MAX_LINES" "$AUDIT_FILE" > "$AUDIT_FILE.tmp" 2>/dev/null && mv -f "$AUDIT_FILE.tmp" "$AUDIT_FILE" 2>/dev/null
  fi
fi

# Never fail the stop.
exit 0
