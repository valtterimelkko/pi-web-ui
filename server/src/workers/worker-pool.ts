/**
 * Worker Pool
 * Manages lifecycle of multiple session workers.
 */

import { SessionWorker } from './session-worker.js';
import type { WorkerOptions, WorkerManagerConfig, EventHandler, RPCEvent } from './types.js';
import { WorkerStatus, WorkerPoolStats, WorkerInfo } from '@pi-web-ui/shared';

export class WorkerPool {
  private workers: Map<string, SessionWorker> = new Map();
  private config: Required<WorkerManagerConfig>;
  private cleanupInterval: NodeJS.Timeout | null = null;

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
    // Check if worker already exists
    const existing = this.workers.get(sessionPath);
    if (existing && existing.status !== 'terminated') {
      return existing;
    }

    // Check max workers limit
    if (this.workers.size >= this.config.maxWorkers) {
      // Try to cleanup idle workers first
      this.cleanupIdle();
      
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

    // Spawn the worker process
    await worker.spawn();

    return worker;
  }

  /**
   * Get an existing worker without creating.
   */
  get(sessionPath: string): SessionWorker | undefined {
    return this.workers.get(sessionPath);
  }

  /**
   * Remove idle workers and return count removed.
   */
  cleanupIdle(maxIdleMs?: number): number {
    const idleThreshold = maxIdleMs ?? this.config.idleTimeoutMs;
    const now = Date.now();
    let removed = 0;

    for (const [path, worker] of this.workers) {
      const idleTime = now - worker.lastActivity;
      const isIdle = worker.status === 'idle' || worker.status === 'ready';
      
      if (isIdle && idleTime > idleThreshold) {
        worker.terminate();
        this.workers.delete(path);
        removed++;
      }
    }

    return removed;
  }

  /**
   * Terminate a specific worker.
   */
  async terminate(sessionPath: string): Promise<void> {
    const worker = this.workers.get(sessionPath);
    if (worker) {
      await worker.terminate();
      this.workers.delete(sessionPath);
    }
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
    const now = Date.now();
    return Array.from(this.workers.entries()).map(([sessionPath, worker]) => ({
      sessionPath,
      status: worker.status,
      pid: worker.pid,
      lastActivity: worker.lastActivity,
      spawnedAt: now, // Approximation
    }));
  }

  /**
   * Start periodic cleanup.
   */
  startCleanupInterval(intervalMs = 60000): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanupIdle();
    }, intervalMs);
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
  async shutdownAll(): Promise<void> {
    this.stopCleanupInterval();
    
    const terminations = Array.from(this.workers.values()).map((worker) =>
      worker.terminate()
    );

    await Promise.all(terminations);
    this.workers.clear();
  }
}
