/**
 * J6 defence-in-depth: in validation mode a disposable server must never
 * enable placement — and therefore never sweep — a tools root the run does not
 * own (01-design.md §3.2, hardened by 01-answer.md and 02-correction.md).
 *
 * Refusals, all decided from the CANONICAL candidate path BEFORE
 * `resolveToolsRoot` performs any write (the `cgroup.subtree_control` enable
 * included):
 *
 *   1. the production anchor/tools-slice NAME forms;
 *   2. the absolute-path form of any path at or under the production tools
 *      slice — checked on the RAW value and again on the CANONICAL path, so a
 *      symlink alias cannot hide a production-slice target;
 *   3. a candidate that cannot be canonicalised (dangling symlink, missing
 *      path) — refused, never waved through;
 *   4. the server's own cgroup: both sides are converted to ONE coordinate
 *      system (cgroup-relative, after stripping the configured cgroup root)
 *      before the equality/ancestor comparison — `readSelfCgroup()` returns a
 *      cgroup-relative path while resolved roots are filesystem paths, and
 *      comparing them unconverted never matches.
 *
 * Pure functions over parsed inputs, modelled on validation-cgroup-guard.ts, so
 * every refusal is testable without touching a real cgroup tree (the alias
 * tests build real symlinks under a temp dir, never the real cgroup fs).
 * Outside validation mode the gate is inert.
 */
import fs from 'node:fs';
import type { PlacementConfig } from './config.js';
import { candidateToolsRootPath } from './config.js';

/** The production tools slice: every root at or under it belongs to production. */
export const PRODUCTION_TOOLS_SLICE_NAME = 'pi-web-ui-tools.slice';

/** The anchor service production currently runs inside that slice (early tripwire). */
export const PRODUCTION_TOOLS_ANCHOR_SLICE = 'pi-web-ui-tools-anchor.service';

export interface ValidationPlacementInput {
  /** `config.validationMode` — the gate is inert unless this is true. */
  validationMode: boolean;
  /** The raw placement config (`resolvePlacementConfig`). */
  cfg: Pick<PlacementConfig, 'enabled' | 'slicePath'>;
  /**
   * The configured cgroup root. Required for the own-cgroup check to compare
   * coordinates correctly: resolved roots arrive as filesystem paths
   * (`/sys/fs/cgroup/…`), the self cgroup as a cgroup-relative path
   * (`/system.slice/…`). Without it the comparison runs unconverted.
   */
  cgroupRoot?: string;
  /** The resolved + verified absolute tools root, when one exists. */
  resolvedRoot?: string;
  /** The server's own cgroup path (`readSelfCgroup`), when detectable. */
  selfCgroupPath?: string | null;
}

export type ValidationPlacementRefusal =
  | 'production-name-form'
  | 'production-tools-slice-root'
  | 'own-cgroup-root'
  | 'not-canonicalisable';

function atOrUnderPath(p: string, segment: string): boolean {
  return p.replace(/\/+$/, '').split('/').includes(segment);
}

/** Strip the cgroup root so both sides of the own-cgroup comparison are cgroup-relative. */
function toCgroupRelative(p: string, cgroupRoot?: string): string {
  const t = p.replace(/\/+$/, '');
  const prefix = cgroupRoot?.replace(/\/+$/, '');
  if (prefix && t.startsWith(`${prefix}/`)) return t.slice(prefix.length);
  return t;
}

export function validationPlacementRefusal(input: ValidationPlacementInput): ValidationPlacementRefusal | null {
  if (!input.validationMode || !input.cfg.enabled) return null;
  const raw = input.cfg.slicePath.replace(/\/+$/, '');
  // Pre-resolution: production's anchor or tools slice, by NAME.
  if (raw === PRODUCTION_TOOLS_ANCHOR_SLICE || raw === PRODUCTION_TOOLS_SLICE_NAME) {
    return 'production-name-form';
  }
  // Pre-resolution: the absolute-path form naming production's tools slice.
  if (raw.startsWith('/') && atOrUnderPath(raw, PRODUCTION_TOOLS_SLICE_NAME)) {
    return 'production-tools-slice-root';
  }
  // Post-resolution (or post-canonicalisation): whatever the raw form resolved
  // to must not sit at or under the production tools slice, and must not be
  // (an ancestor of) the server's own cgroup — compared in ONE coordinate system.
  if (input.resolvedRoot) {
    const root = input.resolvedRoot.replace(/\/+$/, '');
    if (atOrUnderPath(root, PRODUCTION_TOOLS_SLICE_NAME)) return 'production-tools-slice-root';
    if (input.selfCgroupPath) {
      const rootRel = toCgroupRelative(root, input.cgroupRoot);
      const selfRel = toCgroupRelative(input.selfCgroupPath, input.cgroupRoot);
      if (rootRel === selfRel || selfRel.startsWith(`${rootRel}/`)) return 'own-cgroup-root';
    }
  }
  return null;
}

export interface ValidationPlacementCheckDeps {
  cgroupRoot: string;
  /** The server's own cgroup path (`readSelfCgroup`), when detectable. */
  selfCgroupPath?: string | null;
  /** Canonicalise the candidate (default `fs.realpathSync`). */
  realpath?: (p: string) => string;
  /** `systemctl show <unit> -p ControlGroup --value` for slice-NAME forms. */
  systemctlShowControlGroup?: () => string | undefined;
}

/**
 * The whole pre-resolution validation-mode gate in one call: NAME-form
 * tripwires, then the candidate (read-only `systemctl` for names), then
 * canonicalisation, then the pure refusal rules on the CANONICAL path. Runs
 * BEFORE `resolveToolsRoot`, so a refusal means no write of any kind — no
 * `cgroup.subtree_control` enable, no wrapper, no sweep.
 */
export function validationPlacementRefusalForConfig(
  cfg: Pick<PlacementConfig, 'cgroupRoot' | 'enabled' | 'slicePath'>,
  deps: ValidationPlacementCheckDeps,
): ValidationPlacementRefusal | null {
  if (!cfg.enabled) return null;
  // NAME-form tripwires need no filesystem access at all.
  const raw = cfg.slicePath.replace(/\/+$/, '');
  if (raw === PRODUCTION_TOOLS_ANCHOR_SLICE || raw === PRODUCTION_TOOLS_SLICE_NAME) {
    return 'production-name-form';
  }
  if (raw.startsWith('/') && atOrUnderPath(raw, PRODUCTION_TOOLS_SLICE_NAME)) {
    return 'production-tools-slice-root';
  }
  // Candidate path (read-only), then canonicalise BEFORE anything is written.
  const cand = candidateToolsRootPath(cfg, { systemctlShowControlGroup: deps.systemctlShowControlGroup });
  if (!cand.ok) return 'not-canonicalisable';
  let canonical: string;
  try {
    canonical = (deps.realpath ?? fs.realpathSync)(cand.path);
  } catch {
    return 'not-canonicalisable';
  }
  return validationPlacementRefusal({
    validationMode: true,
    cfg,
    cgroupRoot: deps.cgroupRoot,
    resolvedRoot: canonical,
    selfCgroupPath: deps.selfCgroupPath,
  });
}
