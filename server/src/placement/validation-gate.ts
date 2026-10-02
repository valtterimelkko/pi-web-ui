/**
 * J6 defence-in-depth: in validation mode a disposable server must never
 * enable placement — and therefore never sweep — a tools root the run does not
 * own (01-design.md §3.2, hardened by 01-answer.md: the resolved-root check
 * covers every path at or under the production tools slice, so the anchor's
 * name cannot be traded for a new one).
 *
 * Refusals 1–2 (the name and absolute-path forms of production's anchor and
 * tools slice) are decidable from the RAW config and run BEFORE
 * `resolveToolsRoot`, whose `cgroup.subtree_control` writes must never land on
 * a production path. Refusal 3 re-checks the RESOLVED root after resolution;
 * refusal 4 refuses the server's own cgroup (a server must never sweep the
 * hierarchy it lives in).
 *
 * Pure function over parsed inputs, modelled on validation-cgroup-guard.ts, so
 * every refusal is testable without touching a real cgroup tree. Outside
 * validation mode the gate is inert.
 */
import type { PlacementConfig } from './config.js';

/** The production tools slice: every root at or under it belongs to production. */
export const PRODUCTION_TOOLS_SLICE_NAME = 'pi-web-ui-tools.slice';

/** The anchor service production currently runs inside that slice (early tripwire). */
export const PRODUCTION_TOOLS_ANCHOR_SLICE = 'pi-web-ui-tools-anchor.service';

export interface ValidationPlacementInput {
  /** `config.validationMode` — the gate is inert unless this is true. */
  validationMode: boolean;
  /** The raw placement config (`resolvePlacementConfig`). */
  cfg: Pick<PlacementConfig, 'enabled' | 'slicePath'>;
  /** The resolved + verified absolute tools root, when one exists. */
  resolvedRoot?: string;
  /** The server's own cgroup path (`readSelfCgroup`), when detectable. */
  selfCgroupPath?: string | null;
}

export type ValidationPlacementRefusal =
  | 'production-name-form'
  | 'production-tools-slice-root'
  | 'own-cgroup-root';

function atOrUnderPath(p: string, segment: string): boolean {
  return p.replace(/\/+$/, '').split('/').includes(segment);
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
  // Post-resolution: whatever the raw form resolved to must not sit at or
  // under the production tools slice, and must not be (an ancestor of) the
  // server's own cgroup.
  if (input.resolvedRoot) {
    const root = input.resolvedRoot.replace(/\/+$/, '');
    if (atOrUnderPath(root, PRODUCTION_TOOLS_SLICE_NAME)) return 'production-tools-slice-root';
    const self = input.selfCgroupPath?.replace(/\/+$/, '');
    if (self && (root === self || self.startsWith(`${root}/`))) return 'own-cgroup-root';
  }
  return null;
}
