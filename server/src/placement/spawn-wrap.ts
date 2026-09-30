/**
 * D0 spawn planning: wrap argv-shaped spawns (runtimes, subagent, parallel orchestrator)
 * and command-string paths (bash tool) with placement. Planning is pure; when placement
 * is off every planner returns null and callers pass argv/env through byte-identically
 * (01-answer.md amendment E).
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { PlacementConfig } from './config.js';
import { placementDegradeFilePath, placementWrapperPath } from './config.js';
import { groupPath, ownGroupName, sessionGroupName } from './keys.js';
import { materialiseWrapper } from './wrapper.js';

/**
 * Correction 03: the ACTIVE, resolved-and-verified tools root (set at server start-up
 * after `resolveToolsRoot`). Until it is set, planning is unavailable and every
 * planner returns null — spawn sites fall back byte-identically (fail open with a
 * signal, never into an unverified group).
 */
let activeToolsRoot: string | undefined;
export function setActiveToolsRoot(root: string | undefined): void {
  activeToolsRoot = root;
}
export function getActiveToolsRoot(): string | undefined {
  return activeToolsRoot;
}

function effectiveRoot(cfg: PlacementConfig): PlacementConfig | null {
  const root = cfg.toolsRoot ?? activeToolsRoot;
  if (!root) return null;
  return { ...cfg, toolsRoot: root };
}

export interface PlacementSpawnPlan {
  /** Executable to spawn (the wrapper, or the original binary when placement is off). */
  file: string;
  /** Arguments (unchanged argv for argv-shaped spawns; the wrapper inspects -c/-s). */
  args: string[];
  /** Extra environment to merge into the child's env. */
  env: Record<string, string>;
  /** Group directory name (diagnostics, cleanup keying for own- groups). */
  group: string;
  /** Best-effort removal of the group; call from the child's exit path (own- groups). */
  cleanup: () => void;
}

export type SpawnEnvVars = {
  PI_TOOLS_CG: string;
  PI_TOOLS_ROOT: string;
  PI_TOOLS_GROUP: string;
  PI_TOOLS_MEM_MAX: string;
  PI_TOOLS_MEM_HIGH: string;
  PI_TOOLS_PIDS_MAX: string;
  PI_TOOLS_SWAP_MAX: string;
  PI_TOOLS_SHELL: string;
  PI_TOOLS_DEGRADE_FILE: string;
} & Record<string, string>;

export function buildPlacementEnv(cfg: PlacementConfig, group: string): SpawnEnvVars {
  const rc = effectiveRoot(cfg);
  if (!rc?.toolsRoot) throw new Error('placement: tools root unavailable');
  const cg = groupPath(rc, group);
  if (!cg) throw new Error(`placement: refusing group outside tools root: ${group}`);
  return {
    PI_TOOLS_CG: cg,
    PI_TOOLS_ROOT: rc.toolsRoot,
    PI_TOOLS_GROUP: group,
    PI_TOOLS_MEM_MAX: String(cfg.perChild.memoryMaxBytes),
    PI_TOOLS_MEM_HIGH: String(cfg.perChild.memoryHighBytes),
    PI_TOOLS_PIDS_MAX: String(cfg.perChild.pidsMax),
    PI_TOOLS_SWAP_MAX: String(cfg.perChild.swapMaxBytes),
    PI_TOOLS_SHELL: '/bin/bash',
    PI_TOOLS_DEGRADE_FILE: placementDegradeFilePath(cfg),
  };
}

function plan(cfg: PlacementConfig, group: string, argv: readonly [string, ...string[]], baseEnv?: NodeJS.ProcessEnv): PlacementSpawnPlan {
  const env = buildPlacementEnv(cfg, group);
  const wrapper = materialiseWrapper(cfg);
  const [file, ...args] = argv;
  if (!file) throw new Error('placement: empty argv[0]');
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(baseEnv ?? {})) {
    if (v !== undefined) merged[k] = v;
  }
  return {
    file: wrapper,
    // The wrapper execs "$@": its argv must carry the FULL original argv (binary first).
    args: [file, ...args],
    // Full merged child env: the caller's env with the placement vars added, so a call
    // site can pass `plan.env` straight to spawn without a second merge.
    env: Object.assign(merged, env),
    group,
    cleanup: () => {
      try {
        const cg = groupPath(cfg, group);
        if (!cg) return;
        try {
          fs.writeFileSync(path.join(cg, 'cgroup.kill'), '1');
        } catch {
          /* group may be gone */
        }
        fs.rmdirSync(cg);
      } catch {
        /* best effort: rmdir fails while populated; the sweep reaps later */
      }
    },
  };
}

/** Session-bound runtime spawn (claude/opencode/agy/cmdc/pi processes). */
export function planSpawnForSession(
  cfg: PlacementConfig,
  key: { kind: 'rt'; runtime: string; id: string },
  argv: readonly [string, ...string[]],
  env?: NodeJS.ProcessEnv,
): PlacementSpawnPlan | null {
  if (!cfg.enabled) return null;
  const rc = effectiveRoot(cfg);
  if (!rc) return null;
  return plan(rc, sessionGroupName('rt', key.runtime, key.id), argv, env);
}

/** Spawn that is not session-bound: its own unique group, removed when it exits. */
export function planSpawnOwn(
  cfg: PlacementConfig,
  argv: readonly [string, ...string[]],
  env?: NodeJS.ProcessEnv,
): PlacementSpawnPlan | null {
  if (!cfg.enabled) return null;
  const rc = effectiveRoot(cfg);
  if (!rc) return null;
  return plan(rc, ownGroupName(randomBytes), argv, env);
}

/** Environment for the bash tool's in-shell placement (prefix line reads these). */
export function placementBashEnv(cfg: PlacementConfig, sessionId: string): Record<string, string> | null {
  if (!cfg.enabled) return null;
  const rc = effectiveRoot(cfg);
  if (!rc) return null;
  return buildPlacementEnv(rc, sessionGroupName('pi', undefined, sessionId));
}

/**
 * The in-shell placement line: POSIX sh source prepended to the bash tool's command
 * (composed after the session's own shellCommandPrefix). Static text — all values ride
 * the environment set by the spawn hook. On any failure it appends one degrade line and
 * the command still runs (fail open).
 */
export function placementBashPrefixLine(_cfg: PlacementConfig): string {
  return [
    '{',
    'pl=0;',
    'if [ -n "${PI_TOOLS_CG:-}" ] && [ -d "${PI_TOOLS_ROOT:-}" ]; then',
    'rmax=""; [ -r "$PI_TOOLS_ROOT/memory.max" ] && rmax=$(cat "$PI_TOOLS_ROOT/memory.max" 2>/dev/null);',
    'case "$rmax" in ""|max) p2="${PI_TOOLS_ROOT%/*}"; [ -r "$p2/memory.max" ] && rmax=$(cat "$p2/memory.max" 2>/dev/null);; esac;',
    'case "$rmax" in ""|max|*[!0-9]*) : ;; *) pl=1 ;; esac;',
    'fi;',
    'if [ "$pl" -eq 1 ]; then',
    'mkdir -p -- "$PI_TOOLS_CG" 2>/dev/null || true;',
    'cur="";',
    '[ -r "$PI_TOOLS_CG/memory.max" ] && cur=$(cat "$PI_TOOLS_CG/memory.max" 2>/dev/null);',
    'if [ -d "$PI_TOOLS_CG" ] && { [ -z "$cur" ] || [ "$cur" = "max" ]; }; then',
    '[ -n "${PI_TOOLS_MEM_MAX:-}" ] && echo "$PI_TOOLS_MEM_MAX" > "$PI_TOOLS_CG/memory.max" 2>/dev/null || printf \'%s bash %s limit-write-failed-memory-max\n\' "$(date -u +%FT%TZ)" "${PI_TOOLS_GROUP:-unknown}" >> "$PI_TOOLS_DEGRADE_FILE" 2>/dev/null || true;',
    '[ -n "${PI_TOOLS_MEM_HIGH:-}" ] && echo "$PI_TOOLS_MEM_HIGH" > "$PI_TOOLS_CG/memory.high" 2>/dev/null || true;',
    '[ -n "${PI_TOOLS_PIDS_MAX:-}" ] && echo "$PI_TOOLS_PIDS_MAX" > "$PI_TOOLS_CG/pids.max" 2>/dev/null || true;',
    '[ -n "${PI_TOOLS_SWAP_MAX:-}" ] && echo "$PI_TOOLS_SWAP_MAX" > "$PI_TOOLS_CG/memory.swap.max" 2>/dev/null || true;',
    'fi;',
    'if [ -d "$PI_TOOLS_CG" ] && [ -w "$PI_TOOLS_CG" ]; then',
    'if echo $$ > "$PI_TOOLS_CG/cgroup.procs" 2>/dev/null; then echo 0 > /proc/self/oom_score_adj 2>/dev/null || true; else printf \'%s bash %s fell-open\n\' "$(date -u +%FT%TZ)" "${PI_TOOLS_GROUP:-unknown}" >> "$PI_TOOLS_DEGRADE_FILE" 2>/dev/null || true; fi;',
    'else',
    'printf \'%s bash %s fell-open\n\' "$(date -u +%FT%TZ)" "${PI_TOOLS_GROUP:-unknown}" >> "$PI_TOOLS_DEGRADE_FILE" 2>/dev/null || true;',
    'fi;',
    'else',
    '[ -n "${PI_TOOLS_CG:-}" ] && printf \'%s bash %s root-unavailable\n\' "$(date -u +%FT%TZ)" "${PI_TOOLS_GROUP:-unknown}" >> "$PI_TOOLS_DEGRADE_FILE" 2>/dev/null || true;',
    'fi; }',
  ].join('\n');
}
