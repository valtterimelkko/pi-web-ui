import { readFileSync, realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import path from 'node:path';
import type { AdmissionCountsReading } from './health-readings.js';

/**
 * J3: validation-only leak injection for the admission turn-count detector.
 *
 * The detector is a meter, not a fix (plan §6 J3): to prove on a disposable
 * server that a leaked admission permit pages, a validation run needs a way to
 * plant "admission holds one more permit than the runtimes report" without
 * changing `AdmissionController` behaviour. This override decorates the counts
 * the A2 sampler reads with a phantom permit; admission itself is untouched
 * and the production path never constructs the override.
 *
 * The guard mirrors `createValidationPressureOverride` (admission-controller.ts)
 * exactly: NODE_ENV cannot be the guard (the compiled validation server may
 * inherit NODE_ENV=production), so the override requires evidence the
 * production service cannot produce from its environment alone — ALL of:
 *  - `PI_WEB_UI_VALIDATION_MODE=true` and `PI_WEB_UI_VALIDATION_SERVER_CHILD=1`;
 *  - an absolute `PI_WEB_UI_VALIDATION_RECORD_DIR` holding the identity record
 *    `server-process.json` written by scripts/validation-server-child.ts before
 *    importing the server, whose `pid` is THIS process and whose `validationDir`
 *    is that record dir;
 *  - the Internal API socket and the leak file both inside the record dir;
 *  - a record dir that is neither the production state root nor an ancestor of it.
 *
 * The leak file is re-read on every sample (a missing or malformed file means
 * "no leak", so a validation run can raise and clear the leak without
 * restarting): `{ "leakActiveTurns"?: number, "leakClass"?: "P0".."P3",
 * "leakRuntime"?: string }`. `leakClass` defaults to P2 — the class of the
 * 2026-10-02 incident. Invalid values are ignored per key.
 */

export interface ValidationLeakOverride {
  /** Applies the phantom permit to one counts reading. Total: never throws. */
  apply: (counts: AdmissionCountsReading) => AdmissionCountsReading;
  /** Human-readable description for the startup warning. */
  describe: () => string;
}

export interface ValidationLeakOverrideOptions {
  /** This process's pid (test seam). */
  pid?: number;
  /** Production state root (test seam); defaults to the account's real ~/.pi-web-ui. */
  productionStateRoot?: string;
  /** Called once with the reason when the override was requested but refused. */
  onRefused?: (reason: string) => void;
}

/** realpath that tolerates not-yet-existing leaves (mirrors admission-controller). */
function canonicalPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    const parent = path.dirname(p);
    return parent === p ? p : path.join(canonicalPath(parent), path.basename(p));
  }
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** The real production state root, independent of a (possibly fake) $HOME. */
function realProductionStateRoot(): string {
  try {
    return path.join(userInfo().homedir, '.pi-web-ui');
  } catch {
    return path.join('/root', '.pi-web-ui');
  }
}

const KNOWN_LEAK_CLASSES = new Set(['P0', 'P1', 'P2', 'P3']);

interface LeakFile {
  leakActiveTurns?: unknown;
  leakClass?: unknown;
  leakRuntime?: unknown;
}

export function createValidationLeakOverride(
  env: NodeJS.ProcessEnv = process.env,
  options: ValidationLeakOverrideOptions = {},
): ValidationLeakOverride | undefined {
  const file = env.INTERNAL_API_ADMISSION_TEST_LEAK_FILE?.trim();
  if (!file) return undefined;
  const refuse = (reason: string): undefined => {
    options.onRefused?.(`validation leak override refused: ${reason}`);
    return undefined;
  };
  if (env.PI_WEB_UI_VALIDATION_MODE !== 'true' || env.PI_WEB_UI_VALIDATION_SERVER_CHILD !== '1') {
    return refuse('not a validation server child (PI_WEB_UI_VALIDATION_MODE / PI_WEB_UI_VALIDATION_SERVER_CHILD)');
  }
  const recordDirRaw = env.PI_WEB_UI_VALIDATION_RECORD_DIR?.trim();
  if (!recordDirRaw || !path.isAbsolute(recordDirRaw)) return refuse('PI_WEB_UI_VALIDATION_RECORD_DIR is not an absolute path');
  const recordDir = canonicalPath(recordDirRaw);
  const productionRoot = canonicalPath(options.productionStateRoot ?? realProductionStateRoot());
  if (recordDir === productionRoot || isInside(productionRoot, recordDir)) {
    return refuse(`record dir ${recordDir} is or contains the production state root`);
  }
  let identity: { pid?: unknown; validationDir?: unknown };
  try {
    identity = JSON.parse(readFileSync(path.join(recordDir, 'server-process.json'), 'utf8')) as typeof identity;
  } catch {
    return refuse('no validation child identity record (server-process.json) in the record dir');
  }
  const pid = options.pid ?? process.pid;
  if (identity.pid !== pid || typeof identity.validationDir !== 'string' || canonicalPath(identity.validationDir) !== recordDir) {
    return refuse('the validation identity record does not belong to this process');
  }
  const socket = env.INTERNAL_API_SOCKET_PATH?.trim();
  if (!socket || !path.isAbsolute(socket) || !isInside(canonicalPath(socket), recordDir)) {
    return refuse('the Internal API socket is not inside the validation record dir');
  }
  if (!path.isAbsolute(file) || !isInside(canonicalPath(file), recordDir)) {
    return refuse('the leak file is not inside the validation record dir');
  }

  const readLeak = (): LeakFile => {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as LeakFile;
      return typeof parsed === 'object' && parsed !== null ? parsed : {};
    } catch {
      return {};
    }
  };

  return {
    apply: (counts: AdmissionCountsReading): AdmissionCountsReading => {
      const leak = readLeak();
      const amount = typeof leak.leakActiveTurns === 'number' && Number.isSafeInteger(leak.leakActiveTurns) && leak.leakActiveTurns > 0
        ? leak.leakActiveTurns
        : 0;
      if (amount === 0) return counts;
      const leakClass = typeof leak.leakClass === 'string' && KNOWN_LEAK_CLASSES.has(leak.leakClass) ? leak.leakClass : 'P2';
      const leakRuntime = typeof leak.leakRuntime === 'string' && leak.leakRuntime.length > 0 ? leak.leakRuntime : undefined;
      return {
        ...counts,
        activeTurns: counts.activeTurns + amount,
        classes: Object.fromEntries(
          Object.entries(counts.classes).map(([name, entry]) => [name, name === leakClass ? { active: entry.active + amount } : entry]),
        ),
        ...(counts.runtimes
          ? {
              runtimes: leakRuntime
                ? { ...counts.runtimes, [leakRuntime]: { activeTurns: (counts.runtimes[leakRuntime]?.activeTurns ?? 0) + amount } }
                : counts.runtimes,
            }
          : {}),
      };
    },
    describe: () => `leak file ${file} (phantom admission permit; disposable validation server only)`,
  };
}
