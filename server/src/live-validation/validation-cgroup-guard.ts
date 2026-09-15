/**
 * Disposable-validation cgroup hygiene (2026-09-15).
 *
 * `docs/LIVE-VALIDATION.md` already warns that a disposable validation server
 * must not run inside the production service's control group. A warning is not a
 * guard, and on 2026-09-15 at 08:30 the cost of that gap was paid in full:
 * systemd SIGKILLed `/system.slice/pi-web-ui.service` with
 * `KillMode=control-group`, and the process list shows it taking
 * `npm run validate:server`, `npm exec tsx`, three `esbuild` processes and four
 * mid-turn orchestration children with it.
 *
 * Of all of those, the validation server is the one the repository can refuse to
 * start in the wrong place. The check is a pure function over the content of
 * `/proc/self/cgroup` so that the refusal is testable without actually being
 * inside the production cgroup.
 */

import { readFileSync } from 'node:fs';

/** The production service cgroup, as it appears in `/proc/self/cgroup`. */
export const PRODUCTION_SERVICE_CGROUP = '/system.slice/pi-web-ui.service';

/** Escape hatch, for the rare case where the operator really means it. */
export const CGROUP_OVERRIDE_ENV = 'PI_WEB_UI_VALIDATION_ALLOW_PRODUCTION_CGROUP';

export interface ValidationCgroupInput {
  /**
   * The process' own cgroup **path**, as returned by `readSelfCgroup` (for
   * example `/system.slice/pi-web-ui.service`), or null when undetectable.
   *
   * Deliberately not the raw `/proc/self/cgroup` file content: an earlier
   * revision of this module accepted the file text and re-parsed it here, so
   * passing an already-parsed path silently produced `undetectable` and the
   * guard allowed exactly what it exists to refuse. The field name and the
   * `readSelfCgroup`/`parseSelfCgroupPath` split now make the two steps hard to
   * confuse.
   */
  cgroupPath: string | null;
  /** Defaults to `PRODUCTION_SERVICE_CGROUP`. */
  forbiddenCgroup?: string;
  /** Defaults to `process.env[CGROUP_OVERRIDE_ENV]`. */
  overrideEnv?: string | undefined;
}

export type ValidationCgroupVerdict =
  | { allowed: true; reason: 'outside-production-cgroup' | 'override' | 'undetectable' }
  | { allowed: false; reason: 'inside-production-cgroup'; message: string; recipe: string };

/**
 * Extract the cgroup path from `/proc/self/cgroup`.
 *
 * Unified-hierarchy systems emit a single `0::<path>` line; hybrid systems emit
 * one line per controller. The last path wins, which is the controller-based
 * path on hybrid and the only path on unified.
 */
export function parseSelfCgroupPath(content: string): string | null {
  if (!content) return null;
  let last: string | null = null;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(':');
    // "<hierarchy-id>:<controllers>:<path>"
    if (parts.length < 3) continue;
    const path = parts.slice(2).join(':');
    if (path) last = path;
  }
  return last;
}

/** Read the current process' cgroup path. Returns null when unreadable. */
export function readSelfCgroup(file = '/proc/self/cgroup'): string | null {
  try {
    return parseSelfCgroupPath(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** The recipe printed alongside a refusal: run the server outside the unit. */
export function validationCgroupRecipe(unitName = 'pi-web-ui-validate-<nonce>'): string {
  return (
    `systemd-run --scope --collect --unit=${unitName} \\\n` +
    `  --setenv=PI_WEB_UI_VALIDATION_DIR=/tmp/pi-web-ui-validation \\\n` +
    `  npm run validate:server`
  );
}

/**
 * Decide whether a disposable validation server may start where it is.
 *
 * A cgroup that cannot be read is treated as permissive: refusing to start
 * because `/proc` was unavailable would break validation on hosts where the
 * check is meaningless, and the guard exists to stop a known trap, not to be a
 * second obstacle.
 */
export function checkValidationCgroup(input: ValidationCgroupInput): ValidationCgroupVerdict {
  const forbidden = input.forbiddenCgroup ?? PRODUCTION_SERVICE_CGROUP;
  const override = input.overrideEnv ?? process.env[CGROUP_OVERRIDE_ENV];

  // Only an affirmative value counts as consent.
  if (override === '1' || override === 'true' || override === 'yes') {
    return { allowed: true, reason: 'override' };
  }

  const path = input.cgroupPath;
  if (!path) return { allowed: true, reason: 'undetectable' };

  const inside = path === forbidden || path.startsWith(`${forbidden}/`);
  if (!inside) return { allowed: true, reason: 'outside-production-cgroup' };

  return {
    allowed: false,
    reason: 'inside-production-cgroup',
    message:
      `Refusing to start a disposable validation server inside the production service cgroup ` +
      `(${path}).\n` +
      `systemd stops this unit with KillMode=control-group, so a stop or restart SIGKILLs every\n` +
      `process in it — including this validation server and any in-flight orchestration children.\n` +
      `Run it in its own scope instead:\n\n${validationCgroupRecipe()}\n\n` +
      `If you are certain this is what you want, set ${CGROUP_OVERRIDE_ENV}=1.`,
    recipe: validationCgroupRecipe(),
  };
}
