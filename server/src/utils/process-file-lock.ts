import { randomBytes } from 'node:crypto';
import { closeSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface ProcessFileLock {
  path: string;
  release(): void;
}

/**
 * Cooperative process-lifetime lock whose public pathname appears atomically
 * only after its complete owner record has been written.
 */
export function acquireProcessFileLock(lockPath: string, label: string): ProcessFileLock {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const tempPath = `${lockPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    let tempFd: number | undefined;
    try {
      tempFd = openSync(tempPath, 'wx', 0o600);
      writeFileSync(tempFd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), label }));
      closeSync(tempFd);
      tempFd = undefined;
      linkSync(tempPath, lockPath);
      const owned = lstatSync(lockPath);
      unlinkSync(tempPath);
      let released = false;
      return {
        path: lockPath,
        release() {
          if (released) return;
          released = true;
          try {
            const current = lstatSync(lockPath);
            if (current.isFile() && current.dev === owned.dev && current.ino === owned.ino) unlinkSync(lockPath);
          } catch {
            // Missing or replaced: never remove an unverified path.
          }
        },
      };
    } catch (error) {
      if (tempFd !== undefined) closeSync(tempFd);
      try { unlinkSync(tempPath); } catch { /* absent */ }
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;
      if (attempt < 2 && removeVerifiedDeadOwner(lockPath)) continue;
      const conflict = new Error(`${label} is already in use`) as NodeJS.ErrnoException;
      conflict.code = 'EADDRINUSE';
      throw conflict;
    }
  }

  throw new Error(`Unable to acquire ${label}`);
}

function removeVerifiedDeadOwner(lockPath: string): boolean {
  let parsed: { pid?: unknown };
  try {
    parsed = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: unknown };
  } catch {
    // A malformed/unreadable owner is ambiguous. Fail closed rather than steal it.
    return false;
  }
  if (typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid) || parsed.pid < 1) return false;

  try {
    process.kill(parsed.pid, 0);
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return false;
    if (code !== 'ESRCH') return false;
  }

  try {
    const before = lstatSync(lockPath);
    // Re-read after the liveness check so a cooperative replacement is detected.
    const current = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: unknown };
    const after = lstatSync(lockPath);
    if (current.pid !== parsed.pid || before.dev !== after.dev || before.ino !== after.ino) return false;
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}
