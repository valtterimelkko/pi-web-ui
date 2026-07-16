import { chmod, lstat, unlink } from 'node:fs/promises';
import { createConnection, type Server } from 'node:net';
import { acquireProcessFileLock, type ProcessFileLock } from '../utils/process-file-lock.js';

interface FileIdentity {
  dev: number;
  ino: number;
}

/** Bind a prepared Unix socket and apply owner-only mode before reporting readiness. */
export async function bindOwnerOnlyUnixSocket(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(socketPath, () => {
      server.off('error', onError);
      resolve();
    });
  });
  try {
    await chmod(socketPath, 0o600);
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }
}

/**
 * Owns one Unix-socket pathname under a cooperative same-user lifecycle lock.
 * Inode checks fail closed on observed replacement; this is not an adversarial
 * defence against a process that deliberately races pathname operations.
 */
export class UnixSocketOwner {
  private ownedIdentity: FileIdentity | null = null;
  private lifecycleLock: ProcessFileLock | null = null;

  constructor(
    private readonly socketPath: string,
    private readonly probeTimeoutMs = 250,
  ) {}

  async prepareForBind(): Promise<void> {
    if (this.lifecycleLock) throw new Error(`Internal API socket owner already prepared: ${this.socketPath}`);
    this.lifecycleLock = acquireProcessFileLock(`${this.socketPath}.owner.lock`, 'Internal API socket');
    try {
      const before = await this.identityAtPath();
      if (!before) return;

      const stats = await lstat(this.socketPath);
      if (stats.isSymbolicLink()) {
        throw new Error(`Refusing to replace symbolic link at Internal API socket path: ${this.socketPath}`);
      }
      if (!stats.isSocket()) {
        throw new Error(`Refusing to replace path that is not a Unix socket: ${this.socketPath}`);
      }

      const state = await this.probe();
      if (state === 'live') {
        const error = new Error(`Internal API socket is already owned by a live server: ${this.socketPath}`) as NodeJS.ErrnoException;
        error.code = 'EADDRINUSE';
        throw error;
      }

      // The path may have changed while it was probed. Re-check the inspected
      // stale inode immediately before unlink; cooperative owners cannot replace
      // it while the lifecycle lock is held.
      const after = await this.identityAtPath();
      if (!after) return;
      if (!sameIdentity(before, after)) {
        throw new Error(`Internal API socket path changed while checking ownership: ${this.socketPath}`);
      }
      await unlink(this.socketPath);
    } catch (error) {
      this.lifecycleLock.release();
      this.lifecycleLock = null;
      throw error;
    }
  }

  async captureOwnership(): Promise<void> {
    const stats = await lstat(this.socketPath);
    if (stats.isSymbolicLink() || !stats.isSocket()) {
      throw new Error(`Bound Internal API path is not a real Unix socket: ${this.socketPath}`);
    }
    this.ownedIdentity = { dev: stats.dev, ino: stats.ino };
  }

  async release(): Promise<void> {
    const owned = this.ownedIdentity;
    this.ownedIdentity = null;
    try {
      if (owned) {
        const current = await this.socketIdentityAtPath();
        if (current && sameIdentity(owned, current)) {
          await unlink(this.socketPath).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
          });
        }
      }
    } finally {
      this.lifecycleLock?.release();
      this.lifecycleLock = null;
    }
  }

  private async identityAtPath(): Promise<FileIdentity | null> {
    try {
      const stats = await lstat(this.socketPath);
      return { dev: stats.dev, ino: stats.ino };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private async socketIdentityAtPath(): Promise<FileIdentity | null> {
    try {
      const stats = await lstat(this.socketPath);
      if (stats.isSymbolicLink() || !stats.isSocket()) return null;
      return { dev: stats.dev, ino: stats.ino };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private async probe(): Promise<'live' | 'stale'> {
    return new Promise((resolve, reject) => {
      const socket = createConnection({ path: this.socketPath });
      let settled = false;
      const finish = (outcome: 'live' | 'stale' | Error) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (outcome instanceof Error) reject(outcome);
        else resolve(outcome);
      };

      socket.setTimeout(this.probeTimeoutMs, () => {
        finish(new Error(`Timed out while checking Internal API socket ownership: ${this.socketPath}`));
      });
      socket.once('connect', () => finish('live'));
      socket.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') {
          finish('stale');
        } else {
          finish(new Error(`Could not safely determine Internal API socket ownership (${error.code ?? 'unknown'}): ${this.socketPath}`));
        }
      });
    });
  }
}

function sameIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}
