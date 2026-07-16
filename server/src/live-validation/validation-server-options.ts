import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { acquireProcessFileLock, type ProcessFileLock } from '../utils/process-file-lock.js';

export interface ValidationDirectoryLock {
  path: string;
  release(): void;
}

export interface ValidationPortReservation {
  ports: number[];
  release(): void;
}

export function assertSafeValidationDirectory(validationDir: string, productionPaths: string[]): void {
  const target = resolve(validationDir);
  const canonicalTarget = canonicalizeExistingAncestors(target);
  const productionRoots = productionPaths.map((entry) => {
    const lexical = dirname(resolve(entry));
    return { lexical, canonical: canonicalizeExistingAncestors(lexical) };
  });
  const aliasesProduction = canonicalTarget !== target
    && productionRoots.some(({ canonical }) => canonicalTarget.startsWith(`${canonical}/`));
  if (productionRoots.some(({ lexical, canonical }) => target === lexical || canonicalTarget === canonical)
    || aliasesProduction) {
    throw new Error(`Refusing to use production state directory for disposable validation: ${target}`);
  }
}

function canonicalizeExistingAncestors(input: string): string {
  const missing: string[] = [];
  let current = input;
  let searching = true;
  while (searching) {
    try {
      return resolve(realpathSync(current), ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(current);
      if (parent === current) {
        searching = false;
        continue;
      }
      missing.push(current.slice(parent.length + (parent.endsWith('/') ? 0 : 1)));
      current = parent;
    }
  }
  return input;
}

/** Create a short private directory so the nested Unix socket stays under its platform path limit. */
export function createDefaultValidationDirectory(parent: string): string {
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  return mkdtempSync(join(parent, 'run-'));
}

/** Ask the kernel for currently available loopback ports. */
export async function findAvailablePorts(count: number): Promise<number[]> {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error('Port count must be a positive integer.');
  }

  const ports = new Set<number>();
  while (ports.size < count) ports.add(await findAvailablePort());
  return [...ports];
}

/**
 * Reserve available ports cooperatively across concurrent validation launchers.
 * Lock files remain held while the real listeners run, closing the launcher-to-
 * launcher race left by a bare ephemeral-port probe.
 */
export async function reserveAvailablePorts(count: number, lockDir: string): Promise<ValidationPortReservation> {
  return reserveValidationPorts(Array.from({ length: count }, () => undefined), lockDir);
}

/** Reserve explicit ports and fill undefined slots with kernel-selected ports. */
export async function reserveValidationPorts(
  requested: Array<number | undefined>,
  lockDir: string,
): Promise<ValidationPortReservation> {
  if (requested.length === 0) throw new Error('At least one validation port is required.');
  mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  const locks: ProcessFileLock[] = [];
  const ports: number[] = [];

  try {
    for (const requestedPort of requested) {
      if (requestedPort !== undefined && ports.includes(requestedPort)) {
        throw new Error(`Validation ports must be distinct (duplicate ${requestedPort}).`);
      }

      let claimed = false;
      for (let attempt = 0; attempt < 100 && !claimed; attempt += 1) {
        const port = requestedPort ?? await findAvailablePort();
        let lock: ProcessFileLock;
        try {
          lock = acquireProcessFileLock(join(lockDir, `port-${port}.lock`), `validation port ${port}`);
        } catch (error) {
          if (requestedPort !== undefined || (error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
          continue;
        }

        if (!(await isPortAvailable(port))) {
          lock.release();
          if (requestedPort !== undefined) throw new Error(`Validation port is already in use: ${port}`);
          continue;
        }

        locks.push(lock);
        ports.push(port);
        claimed = true;
      }
      if (!claimed) throw new Error('Unable to reserve an available validation port.');
    }
  } catch (error) {
    for (const lock of locks) lock.release();
    throw error;
  }

  let released = false;
  return {
    ports,
    release() {
      if (released) return;
      released = true;
      for (const lock of locks) lock.release();
    },
  };
}

export function acquireValidationDirectoryLock(validationDir: string): ValidationDirectoryLock {
  mkdirSync(validationDir, { recursive: true, mode: 0o700 });
  const lock = acquireProcessFileLock(
    join(validationDir, '.validation-server.lock'),
    `validation directory ${validationDir}`,
  );
  return { path: lock.path, release: () => lock.release() };
}

async function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Kernel did not return an ephemeral TCP port.'));
        return;
      }
      const { port } = address;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function isPortAvailable(port: number): Promise<boolean> {
  try {
    await new Promise<void>((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => server.close((error) => error ? reject(error) : resolve()));
    });
    return true;
  } catch {
    return false;
  }
}
