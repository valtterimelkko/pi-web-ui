/**
 * Resource allocation and run-directory layout for the lab capsule.
 *
 * Two safety rules live here:
 *
 *  1. The lab refuses to target production or another agent's resources. Run
 *     directories and display numbers are checked against the known shared
 *     paths before anything is created.
 *  2. Every run gets its own directory, and every attempt inside it is
 *     separate and immutable once finalised. A failed attempt is never deleted
 *     or overwritten: "we retried until it passed" is not evidence, and the
 *     retained failure is often the most informative artefact.
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';

/** Paths the lab must never write to or delete. */
export const FORBIDDEN_ROOTS = [
  '/root/pi-web-ui',
  '/root/authelia',
  '/etc',
  '/usr',
  '/var',
  '/boot',
  '/root/.pi-web-ui',
];

export function assertSafeLabRoot(root: string): string {
  const resolved = path.resolve(root);
  if (!path.isAbsolute(resolved)) throw new Error(`Lab root must be absolute: ${root}`);
  if (resolved === '/') throw new Error('Refusing to use / as the lab root');
  for (const forbidden of FORBIDDEN_ROOTS) {
    if (resolved === forbidden || resolved.startsWith(`${forbidden}/`)) {
      // Allow the dedicated operations evidence root, which is the documented
      // home for this lab's records; refuse everything else under those trees.
      const allowedEvidence = '/root/.pi-web-ui/operations/audio-lab-20260914/';
      if (!resolved.startsWith(allowedEvidence)) {
        throw new Error(
          `Refusing to use ${resolved}: it is inside protected path ${forbidden}. ` +
            'The lab only writes to its own root (or the operations evidence root).'
        );
      }
    }
  }
  if (resolved.startsWith('/root/pi-web-ui/')) {
    throw new Error(`Refusing to write inside the canonical checkout: ${resolved}`);
  }
  return resolved;
}

export const RUN_DIRS = [
  'capture',
  'capture/pulse',
  'source',
  'events',
  'clips',
  'logs',
  'screenshots',
] as const;

export interface RunLayout {
  root: string;
  runId: string;
  runDir: string;
  attemptDir: string;
  attempt: number;
}

export function createRunLayout(root: string, runId: string, attempt: number): RunLayout {
  const safeRoot = assertSafeLabRoot(root);
  const runDir = path.join(safeRoot, 'runs', runId);
  const attemptDir = path.join(runDir, `attempt-${String(attempt).padStart(2, '0')}`);
  if (existsSync(attemptDir)) {
    throw new Error(`Attempt directory already exists (refusing to overwrite evidence): ${attemptDir}`);
  }
  mkdirSync(attemptDir, { recursive: true, mode: 0o700 });
  for (const dir of RUN_DIRS) mkdirSync(path.join(attemptDir, dir), { recursive: true, mode: 0o700 });
  return { root: safeRoot, runId, runDir, attemptDir, attempt };
}

export function listAttempts(root: string, runId: string): number[] {
  const runDir = path.join(root, 'runs', runId);
  if (!existsSync(runDir)) return [];
  return readdirSync(runDir)
    .map((name) => /^attempt-(\d+)$/.exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number.parseInt(match[1], 10))
    .sort((a, b) => a - b);
}

export function nextAttempt(root: string, runId: string): number {
  const attempts = listAttempts(root, runId);
  return attempts.length === 0 ? 1 : attempts[attempts.length - 1] + 1;
}

function writeJsonExclusive(filePath: string, value: unknown): void {
  if (existsSync(filePath)) {
    throw new Error(`Refusing to overwrite immutable record: ${filePath}`);
  }
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

/** Finalise a run: the manifest is written once and never rewritten. */
export function finaliseAttempt(attemptDir: string, manifest: unknown): string {
  writeJsonExclusive(path.join(attemptDir, 'manifest.json'), manifest);
  writeFileSync(path.join(attemptDir, 'FINALISED'), new Date().toISOString() + '\n', { mode: 0o600 });
  const manifestPath = path.join(attemptDir, 'manifest.json');
  writeFileSync(path.join(attemptDir, 'manifest.sha256'), `${sha256File(manifestPath)}\n`, {
    mode: 0o600,
  });
  return manifestPath;
}

export function sha256File(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

export function sha256Bytes(buffer: Buffer | Uint8Array): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Ask the kernel for an unused TCP port on loopback. */
export async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('Could not determine a free port'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

/** Find a display number whose socket and lock file are both free. */
export function findFreeDisplay(from = 90, to = 199): number {
  for (let display = from; display <= to; display += 1) {
    if (!existsSync(`/tmp/.X11-unix/X${display}`) && !existsSync(`/tmp/.X${display}-lock`)) {
      return display;
    }
  }
  throw new Error(`No free X display number in range ${from}..${to}`);
}

export function directorySizeBytes(dir: string): number {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) stack.push(full);
      else total += stat.size;
    }
  }
  return total;
}

export function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, 'utf8')) as T;
}
