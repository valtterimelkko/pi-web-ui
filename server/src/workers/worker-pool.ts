/**
 * Worker Pool
 * Manages lifecycle of multiple session workers.
 */

import { SessionWorker } from './session-worker.js';
import type { WorkerOptions, WorkerManagerConfig } from './types.js';
import { WorkerPoolStats, WorkerInfo } from '@pi-web-ui/shared';
import { getCrashLogger, CrashStats } from './crash-logger.js';

export class WorkerPool {
  private workers: Map<string, SessionWorker> = new Map();
  private config: Required<WorkerManagerConfig>;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private readonly terminationUnsubscribers = new Map<SessionWorker, () => void>();
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;

  constructor(config: WorkerManagerConfig = {}) {
    this.config = {
      maxWorkers: config.maxWorkers ?? 15,
      idleTimeoutMs: config.idleTimeoutMs ?? 30 * 60 * 1000, // 30 minutes
      maxOldSpaceSize: config.maxOldSpaceSize ?? 512,
      piPath: config.piPath ?? 'pi',
    };
  }

  /**
   * Get or create a worker for a session.
   */
  async getOrCreate(sessionPath: string, options?: Partial<WorkerOptions>): Promise<SessionWorker> {
    if (this.shuttingDown) {
      throw new Error('Worker pool is shutting down');
    }

    // Sweep any workers whose process has exited/crashed (status 'terminated')
    // so they no longer occupy capacity. This is the lazy half of the unified
    // cleanup path; explicit terminate()/cleanupIdle()/shutdownAll() release
    // eagerly. Converges exit/crash/explicit-delete onto one idempotent path.
    this.cleanupTerminated();

    // Check if worker already exists
    const existing = this.workers.get(sessionPath);
    if (existing && existing.status !== 'terminated') {
      return existing;
    }
    // Existing entry is terminated -> release it before recreating.
    if (existing) {
      this.release(sessionPath, existing);
    }

    // Check max workers limit
    if (this.workers.size >= this.config.maxWorkers) {
      // Try to cleanup idle workers first and wait for processes to exit.
      await this.cleanupIdle();
      this.cleanupTerminated();

      if (this.workers.size >= this.config.maxWorkers) {
        throw new Error(`Maximum worker limit reached (${this.config.maxWorkers})`);
      }
    }

    // Create new worker
    const workerOptions: WorkerOptions = {
      sessionPath,
      maxOldSpaceSize: this.config.maxOldSpaceSize,
      ...options,
    };

    const worker = new SessionWorker(workerOptions);
    this.workers.set(sessionPath, worker);
    const unsubscribeTermination = worker.onTerminated(() => {
      this.release(sessionPath, worker);
    });
    this.terminationUnsubscribers.set(worker, unsubscribeTermination);

    try {
      // Spawn the worker process
      await worker.spawn();
      return worker;
    } catch (error) {
      this.release(sessionPath, worker);
      await worker.terminate();
      throw error;
    }
  }

  /**
   * Get an existing worker without creating.
   */
  get(sessionPath: string): SessionWorker | undefined {
    return this.workers.get(sessionPath);
  }

  /**
   * Idempotently remove a worker from the pool map. Only deletes the entry if
   * it still points at `expected` (or `expected` is omitted), so a stale
   * reference cannot remove a newer worker that reused the same path. This is
   * the single cleanup primitive shared by terminate/cleanupIdle/shutdown.
   */
  private release(sessionPath: string, expected?: SessionWorker): boolean {
    const current = this.workers.get(sessionPath);
    if (!current || (expected !== undefined && current !== expected)) {
      return false;
    }
    this.workers.delete(sessionPath);
    const unsubscribeTermination = this.terminationUnsubscribers.get(current);
    if (unsubscribeTermination) {
      unsubscribeTermination();
      this.terminationUnsubscribers.delete(current);
    }
    return true;
  }

  /**
   * Remove every worker whose process has exited/crashed ('terminated'). These
   * hold no live process and must not occupy capacity. Called lazily from
   * getOrCreate and from the periodic cleanup so exit/crash converges on the
   * same release path as explicit termination.
   */
  private cleanupTerminated(): number {
    let removed = 0;
    for (const [path, worker] of this.workers) {
      if (worker.status === 'terminated') {
        this.release(path, worker);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Remove idle workers and return count removed.
   */
  async cleanupIdle(maxIdleMs?: number): Promise<number> {
    const idleThreshold = maxIdleMs ?? this.config.idleTimeoutMs;
    const now = Date.now();
    const terminations: Promise<void>[] = [];

    for (const [path, worker] of this.workers) {
      const idleTime = now - worker.lastActivity;
      const isIdle = worker.status === 'idle' || worker.status === 'ready';

      if (isIdle && idleTime > idleThreshold) {
        terminations.push(worker.terminate());
        this.release(path, worker);
      }
    }

    // Also purge any already-terminated workers in the same sweep.
    this.cleanupTerminated();

    await Promise.all(terminations);
    return terminations.length;
  }

  /**
   * Terminate a specific worker.
   */
  async terminate(sessionPath: string): Promise<void> {
    const worker = this.workers.get(sessionPath);
    if (worker) {
      await worker.terminate();
      this.release(sessionPath, worker);
    }
  }

  /**
   * Get crash statistics from the crash logger.
   */
  getCrashStats(): CrashStats {
    return getCrashLogger().getStats();
  }

  /**
   * Get recent crash records.
   */
  getRecentCrashes(limit = 10) {
    return getCrashLogger().getRecords({ limit });
  }

  /**
   * Get crash count for a specific session.
   */
  getSessionCrashCount(sessionPath: string): number {
    return getCrashLogger().getSessionCrashCount(sessionPath);
  }

  /**
   * Get pool statistics.
   */
  getStats(): WorkerPoolStats {
    let active = 0;
    let idle = 0;

    for (const worker of this.workers.values()) {
      if (worker.status === 'streaming' || worker.status === 'spawning') {
        active++;
      } else {
        idle++;
      }
    }

    return {
      active,
      idle,
      total: this.workers.size,
      maxWorkers: this.config.maxWorkers,
    };
  }

  /**
   * Get info for all workers.
   */
  getAllWorkers(): WorkerInfo[] {
    return Array.from(this.workers.entries()).map(([sessionPath, worker]) => ({
      sessionPath,
      status: worker.status,
      pid: worker.pid,
      lastActivity: worker.lastActivity,
      spawnedAt: worker.spawnedAt
    }));
  }

  /**
   * Start periodic cleanup.
   */
  startCleanupInterval(intervalMs = 60000): void {
    this.stopCleanupInterval();
    this.cleanupInterval = setInterval(() => {
      void this.cleanupIdle();
    }, intervalMs);
    this.cleanupInterval.unref?.();
  }

  /**
   * Stop periodic cleanup.
   */
  stopCleanupInterval(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Shutdown all workers.
   */
  shutdownAll(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    this.stopCleanupInterval();

    const entries = Array.from(this.workers.entries());
    this.shutdownPromise = Promise.all(entries.map(async ([sessionPath, worker]) => {
      try {
        await worker.terminate();
      } finally {
        this.release(sessionPath, worker);
      }
    })).then(() => undefined);

    return this.shutdownPromise;
  }
}
