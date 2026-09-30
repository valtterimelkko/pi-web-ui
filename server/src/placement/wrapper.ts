/**
 * D0 placement wrapper: a POSIX-sh script that places the calling process (and thus its
 * whole command tree — cgroup membership is inherited on fork) into the per-child tools
 * group named by the environment, then execs the real command.
 *
 * Contract (01-answer.md amendments A/C):
 * - refuses any group path outside the tools root (env prefix check) and never fails a
 *   command because placement failed: it degrades to the old placement with one line in
 *   the degrade file (the "alarm loudly" signal) and still runs the command;
 * - create-or-join: a missing group directory is created with the env-provided limits
 *   (first command of a session pays only file writes); an existing group is joined
 *   without rewriting its limits;
 * - exec shape: `wrapper -c <command>` → `exec $SHELL -c <command>` (bash tool, bg_run);
 *   `wrapper <argv…>` → `exec <argv…>` (pty/direct runtimes); no args → interactive shell.
 */
import fs from 'node:fs';
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { PlacementConfig } from './config.js';
import { placementWrapperPath } from './config.js';

export const PLACEMENT_WRAPPER_SCRIPT = `#!/bin/sh
# pi-web-ui D0 placement wrapper (generated; do not edit the deployed copy)
set -u
CG="\${PI_TOOLS_CG:-}"
ROOT="\${PI_TOOLS_ROOT:-}"
DEGRADE="\${PI_TOOLS_DEGRADE_FILE:-}"
SHELL_BIN="\${PI_TOOLS_SHELL:-/bin/bash}"

note() {
  if [ -n "$DEGRADE" ]; then
    printf '%s %s %s\\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "\${PI_TOOLS_GROUP:-unknown}" "$1" >>"$DEGRADE" 2>/dev/null || true
  fi
}

placed=0
if [ -n "$CG" ]; then
  case "$CG" in
    "$ROOT"/*) : ;;
    *) note "refused-outside-root"; CG="" ;;
  esac
fi
bounded=0
if [ -n "$CG" ]; then
  # Correction 03: verify the tools root; NEVER create it. A missing or unbounded
  # root means placement is unavailable — fall open with a degrade line.
  if [ ! -d "$ROOT" ]; then
    note "root-missing"; CG=""
  elif ! cat "$ROOT/cgroup.controllers" 2>/dev/null | grep -qw memory; then
    note "root-no-memory-controller"; CG=""
  else
    d="$ROOT"
    i=0
    while [ "$i" -lt 6 ] && [ "$(dirname "$d")" != "$d" ]; do
      v=$(cat "$d/memory.max" 2>/dev/null)
      case "$v" in
        ""|max|*[!0-9]*) d=$(dirname "$d"); i=$((i+1)) ;;
        *) bounded=1; break ;;
      esac
    done
    [ "$bounded" -eq 1 ] || { note "root-unbounded"; CG=""; }
  fi
fi
if [ -n "$CG" ] && [ "$bounded" -eq 1 ]; then
  mkdir -p -- "$CG" 2>/dev/null || true
  # Correction-06 finding 3: ALL-OR-NOTHING. Every required limit is written (when
  # fresh or unbounded) and then READ BACK and compared with the configured value
  # BEFORE exec; any write or read-back mismatch removes the group and falls open.
  # A command never runs in a group whose limits are foreign or unbounded.
  ok=1
  ensure_limit() {
    f="$CG/$1"
    v=$(cat "$f" 2>/dev/null)
    if [ "$v" != "$2" ]; then
      echo "$2" > "$f" 2>/dev/null
      v=$(cat "$f" 2>/dev/null)
    fi
    [ "$v" = "$2" ] || { note "limit-readback-failed:$1"; ok=0; }
  }
  ensure_limit memory.max "$PI_TOOLS_MEM_MAX"
  ensure_limit memory.high "$PI_TOOLS_MEM_HIGH"
  ensure_limit pids.max "$PI_TOOLS_PIDS_MAX"
  ensure_limit memory.swap.max "$PI_TOOLS_SWAP_MAX"
  if [ "$ok" -ne 1 ]; then
    echo 1 > "$CG/cgroup.kill" 2>/dev/null || true
    rmdir -- "$CG" 2>/dev/null || true
    note "limit-readback-failed"
    CG=""
  fi
fi
if [ -n "$CG" ]; then
  # Answer 04: placed commands run at a normal OOM score — VERIFIED before the
  # join, so a failed reset stays in the original cgroup (correction-06 finding 3).
  score_file="\${PI_TOOLS_OOM_SCORE_FILE:-/proc/self/oom_score_adj}"
  echo 0 > "$score_file" 2>/dev/null
  score=$(cat "$score_file" 2>/dev/null)
  if [ "$score" != "0" ]; then
    note "oom-score-reset-failed"
    CG=""
  fi
fi
if [ -n "$CG" ]; then
  if [ -w "$CG/cgroup.procs" ]; then
    echo $$ > "$CG/cgroup.procs" 2>/dev/null && placed=1 || note "join-failed"
  elif [ -d "$CG" ] && [ -w "$CG" ]; then
    echo $$ > "$CG/cgroup.procs" 2>/dev/null && placed=1 || note "join-failed"
  else
    note "group-unavailable"
  fi
fi
[ "$placed" -eq 1 ] || [ -z "\${PI_TOOLS_CG:-}" ] || note "fell-open"


if [ "$#" -eq 0 ]; then
  exec "$SHELL_BIN"
elif [ "$1" = "-c" ] || [ "$1" = "-s" ]; then
  exec "$SHELL_BIN" "$@"
else
  exec "$@"
fi
`;

/** Write the wrapper into the server-owned runtime dir (0755); returns its path. */
export function materialiseWrapper(cfg: PlacementConfig): string {
  const wrapperPath = placementWrapperPath(cfg);
  mkdirSync(cfg.runtimeDir, { recursive: true });
  const existing = (() => {
    try {
      return fs.readFileSync(wrapperPath, 'utf8');
    } catch {
      return undefined;
    }
  })();
  if (existing !== PLACEMENT_WRAPPER_SCRIPT) {
    writeFileSync(wrapperPath, PLACEMENT_WRAPPER_SCRIPT, { mode: 0o755 });
    fs.chmodSync(wrapperPath, 0o755);
  }
  return wrapperPath;
}

/** Runtime dir is outside the worktree; ensure the path used in tests stays contained. */
export function assertWrapperPathInsideRuntimeDir(cfg: PlacementConfig): void {
  const resolved = path.resolve(placementWrapperPath(cfg));
  const dir = path.resolve(cfg.runtimeDir);
  if (!resolved.startsWith(dir + path.sep)) throw new Error('placement wrapper path escaped runtime dir');
}
