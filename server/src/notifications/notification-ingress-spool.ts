import { randomBytes } from 'node:crypto';
import { chmod, link, lstat, mkdir, readFile, readdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('NotificationIngressSpool');

const recordSchema = z.object({
  version: z.literal(1),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
  title: z.string().trim().min(1).max(500),
  body: z.string().trim().min(1).max(20_000),
  deepLink: z.string().trim().max(2000).refine(isSafeDeepLink, {
    message: 'deepLink must be an app-relative path or an HTTP(S) URL',
  }).optional(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
}).strict();

export type NotificationIngressRecord = z.infer<typeof recordSchema>;

function isSafeDeepLink(value: string): boolean {
  if (value.startsWith('/') && !value.startsWith('//')) return true;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export interface NotificationIngressClaim {
  record: NotificationIngressRecord;
  claimedPath: string;
  originalPath: string;
}

export interface NotificationIngressSpoolOptions {
  now?: () => number;
  maxFiles?: number;
  maxFileBytes?: number;
}

/** Bounded per-file ingress queue written by terminal agents while the server is unavailable. */
export class NotificationIngressSpool {
  private readonly now: () => number;
  private readonly maxFiles: number;
  private readonly maxFileBytes: number;

  constructor(
    private readonly dir: string,
    options: NotificationIngressSpoolOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.maxFiles = options.maxFiles ?? 1000;
    this.maxFileBytes = options.maxFileBytes ?? 32 * 1024;
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700);
    await this.recoverClaims();
  }

  async claimBatch(): Promise<NotificationIngressClaim[]> {
    await this.init();
    const entries = await readdir(this.dir, { withFileTypes: true });
    const candidates = entries
      .filter((entry) => entry.name.endsWith('.json') && !entry.name.startsWith('.processing-'))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, this.maxFiles);
    const claims: NotificationIngressClaim[] = [];

    for (const entry of candidates) {
      const originalPath = path.join(this.dir, entry.name);
      let stats;
      try {
        stats = await lstat(originalPath);
      } catch {
        continue;
      }
      if (stats.isSymbolicLink() || !stats.isFile() || stats.size > this.maxFileBytes) {
        await unlink(originalPath).catch(() => { /* raced or already removed */ });
        logger.warn(`discarded unsafe notification ingress entry: ${entry.name}`);
        continue;
      }

      const claimedPath = path.join(
        this.dir,
        `.processing-${process.pid}-${randomBytes(6).toString('hex')}-${entry.name}`,
      );
      try {
        await rename(originalPath, claimedPath);
      } catch {
        continue;
      }

      try {
        const claimedStats = await lstat(claimedPath);
        if (!claimedStats.isFile() || claimedStats.isSymbolicLink() || claimedStats.size > this.maxFileBytes) {
          throw new Error('unsafe claimed entry');
        }
        await chmod(claimedPath, 0o600);
        const parsed = recordSchema.parse(JSON.parse(await readFile(claimedPath, 'utf8')));
        if (Date.parse(parsed.expiresAt) <= this.now()) throw new Error('expired ingress entry');
        claims.push({ record: parsed, claimedPath, originalPath });
      } catch (error) {
        await unlink(claimedPath).catch(() => { /* already removed */ });
        logger.warn(`discarded invalid notification ingress entry: ${entry.name}`, error);
      }
    }

    return claims;
  }

  async complete(claim: NotificationIngressClaim): Promise<void> {
    await unlink(claim.claimedPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }

  async retry(claim: NotificationIngressClaim): Promise<void> {
    await this.restoreWithoutOverwrite(claim.claimedPath, claim.originalPath);
  }

  private async recoverClaims(): Promise<void> {
    const entries = await readdir(this.dir, { withFileTypes: true });
    for (const entry of entries) {
      const match = entry.name.match(/^\.processing-\d+-[a-f0-9]+-(.+\.json)$/);
      if (!match) continue;
      const claimedPath = path.join(this.dir, entry.name);
      const originalPath = path.join(this.dir, match[1]);
      await this.restoreWithoutOverwrite(claimedPath, originalPath);
    }
  }

  private async restoreWithoutOverwrite(claimedPath: string, preferredPath: string): Promise<void> {
    let destination = preferredPath;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        // Hard-link creation is atomic and never replaces an existing record.
        await link(claimedPath, destination);
        await unlink(claimedPath);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return;
        if (code !== 'EEXIST' || attempt > 0) throw error;
        destination = path.join(
          this.dir,
          `.recovered-${randomBytes(6).toString('hex')}-${path.basename(preferredPath)}`,
        );
      }
    }
  }
}
