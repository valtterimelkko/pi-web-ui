#!/usr/bin/env bash
# Record who asked for a production restart, in the journal and in the durable
# stop-audit file, BEFORE the restart happens.
#
# WHY THIS IS ITS OWN SCRIPT (2026-09-15)
#
# Two repository-owned paths can restart pi-web-ui.service, and only one of them
# used to announce itself: scripts/restart-pi-web-ui.sh wrote the record inline,
# while scripts/restart-production.sh — the canonical pre-flight path an agent is
# told to use — restarted the unit after announcing itself only through the
# notification hook.
#
# That gap is not theoretical. Production was restarted at 2026-09-15T15:35:23Z:
# the journal shows the "Production restart initiated" notification being
# delivered at 15:35:23Z (restart-production.sh's own notify call), and the
# durable stop-audit file has no RESTART-REQUESTED record for it. In the forensic
# record a restart by the repository's own recommended path looked exactly like an
# unexplained one — the one question the record exists to answer.
#
# The platform cannot name an arbitrary requester (no auditd, and root systemctl
# uses systemd's private socket rather than the system bus; see
# docs/PRODUCTION-STOP-ROBUSTNESS.md). What the repository can do is make every
# restart path it owns announce itself, identically, from one implementation —
# which is what this script is.
#
# USE
#
#   scripts/record-restart-requester.sh "$REASON" "$ARGV_ORIGINAL" ["$DRAIN_VERDICT"]
#
# TEST SEAMS (defaults are the production values; tests override them so no test
# can write into production's record or journal):
#
#   PI_WEB_UI_STOP_AUDIT_FILE   durable record file (default
#                               /root/.pi-web-ui/stop-audit.log)
#   PI_WEB_UI_SYSTEMD_CAT       systemd-cat binary (default systemd-cat)
#
# OPTIONAL FIELDS (B4 correction 01, set by the canonical drain-restart script):
#
#   PI_WEB_UI_RESTART_VERB            systemctl verb (restart, try-restart, …) → verb=
#   PI_WEB_UI_RESTART_UNIT            unit name → unit=
#   PI_WEB_UI_RESTART_RECORD_KIND     RESTART-REQUESTED (default) or RESTART-NOOP
#                                     (a routed try-restart of an inactive unit:
#                                     recorded, but nothing was stopped)
#   PI_WEB_UI_RESTART_REQUIRE_DURABLE 1 = exit 3 unless the durable file or the
#                                     journal accepted the line (used for --force)
#
# Otherwise this script exits 0: an ordinary drained restart must not fail
# because recording failed. A FORCED restart skips the drain, so its record is
# the only trace of the override — it fails closed instead.

set -uo pipefail

REASON="${1:-(unspecified)}"
ARGV_ORIGINAL="${2:-}"
# Optional (B4, 2026-09-29): the drain verdict the restart followed, e.g.
# `settled,waited_ms=…,cut_off=0`, `timed_out,…,cut_off_runs=a+b`, `forced`,
# `legacy_preflight,active_turns=0`. Omitted from the record when not given.
DRAIN="${3:-}"

AUDIT_FILE="${PI_WEB_UI_STOP_AUDIT_FILE:-/root/.pi-web-ui/stop-audit.log}"
ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Ancestor chain, deepest first, bounded so a pathological tree cannot make the
# record enormous. Each entry is "pid:comm".
ancestors=""
pid="$$"
depth=0
while [[ "$pid" =~ ^[0-9]+$ ]] && (( pid > 1 )) && (( depth < 6 )); do
  comm="$(head -c 48 "/proc/$pid/comm" 2>/dev/null | tr -d '\n')"
  # /proc/<pid>/stat: field 4 is PPID, but field 2 (comm) may contain spaces and
  # parentheses, so strip everything up to and including the last ')' first.
  ppid="$(sed -e 's/.*) //' "/proc/$pid/stat" 2>/dev/null | awk '{print $2}')"
  ancestors="${ancestors}${pid}:${comm}>"
  pid="${ppid:-}"
  depth=$((depth + 1))
done
ancestors="${ancestors%,}"
ancestors="${ancestors%>}"

# coreutils `tty` prints "not a tty" on stdout AND exits non-zero, so neither a
# plain capture nor an `||` fallback yields a clean single-line value.
tty_name="$(tty 2>/dev/null)"
tty_name="${tty_name//$'\n'/ }"
[[ -z "$tty_name" ]] && tty_name="none"

# Kept as one readable key=value token: anything outside a conservative set
# (the verdict is built from a state word, numbers and run ids) becomes '_',
# so a crafted value can never split or forge the record.
sanitize() { printf '%s' "${1:0:600}" | tr -c 'A-Za-z0-9_.,=+:@-' '_'; }
drain_field=""
[[ -n "$DRAIN" ]] && drain_field=" drain=$(sanitize "$DRAIN")"
[[ -n "${PI_WEB_UI_RESTART_VERB:-}" ]] && drain_field="${drain_field} verb=$(sanitize "$PI_WEB_UI_RESTART_VERB")"
[[ -n "${PI_WEB_UI_RESTART_UNIT:-}" ]] && drain_field="${drain_field} unit=$(sanitize "$PI_WEB_UI_RESTART_UNIT")"
KIND="RESTART-REQUESTED"
[[ "${PI_WEB_UI_RESTART_RECORD_KIND:-}" == "RESTART-NOOP" ]] && KIND="RESTART-NOOP"

LINE="${KIND} ts=$ts uid=$(id -u) user=$(id -un 2>/dev/null) pid=$$ ppid=$PPID tty=$tty_name cwd=$(pwd 2>/dev/null) reason=$(printf '%q' "$REASON") argv=$(printf '%q' "$ARGV_ORIGINAL")${drain_field} ancestors=$ancestors"

# Journal first, then the durable file — the same two sinks the stop audit uses,
# for the same reason: each has been lost at least once.
printf '%s\n' "$LINE"
file_ok=0
journal_ok=0
mkdir -p "$(dirname "$AUDIT_FILE")" 2>/dev/null
printf '%s\n' "$LINE" >> "$AUDIT_FILE" 2>/dev/null && file_ok=1
# systemd-cat gives the line a stable identifier in the journal even when this
# script is run from a context that is not a unit's own stdout.
systemd_cat="${PI_WEB_UI_SYSTEMD_CAT:-systemd-cat}"
if command -v "$systemd_cat" >/dev/null 2>&1; then
  printf '%s\n' "$LINE" | "$systemd_cat" -t pi-web-ui-restart 2>/dev/null && journal_ok=1
fi

if [[ "${PI_WEB_UI_RESTART_REQUIRE_DURABLE:-0}" == "1" ]] && (( file_ok == 0 && journal_ok == 0 )); then
  printf 'record-restart-requester: neither the audit file (%s) nor the journal accepted the record\n' "$AUDIT_FILE" >&2
  exit 3
fi
exit 0
