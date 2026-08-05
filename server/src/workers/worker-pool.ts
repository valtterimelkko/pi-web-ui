/**
 * Worker Pool
 * Manages lifecycle of multiple session workers.
 */

import { SessionWorker } from './session-worker.js';
import type { WorkerOptions, WorkerManagerConfig } from './types.js';
import type { WorkerAssignmentIdentity, WorkerLauncher } from './worker-launcher.js';
import { WorkerPoolStats, WorkerInfo } from '@pi-web-ui/shared';
import { getCrashLogger, CrashStats } from './crash-logger.js';

type WorkerOwnershipKind = 'plain' | 'contained';

interface GlobalWorkerOwner {
  poolId: symbol;
  kind: WorkerOwnershipKind;
}

const globalWorkerOwners = new Map<string, GlobalWorkerOwner>();

export interface WorkerPoolConfig extends WorkerManagerConfig {
  /** Internal launcher policy; never populated from a request body. */
  workerLauncher?: WorkerLauncher;
  commandTimeoutMs?: number;
  readinessFallbackMs?: number;
  ownershipKind?: WorkerOwnershipKind;
}

export class WorkerPool {
  private workers: Map<string, SessionWorker> = new Map();
  private config: Required<WorkerManagerConfig>;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private readonly terminationUnsubscribers = new Map<SessionWorker, () => void>();
  private readonly creating = new Map<string, Promise<SessionWorker>>();
  private readonly terminating = new Map<string, Promise<void>>();
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;
  private readonly workerLauncher?: WorkerLauncher;
  private readonly commandTimeoutMs?: number;
  private readonly readinessFallbackMs?: number;
  private readonly poolId = Symbol('worker-pool');
  private readonly ownershipKind: WorkerOwnershipKind;

  constructor(config: WorkerPoolConfig = {}) {
    this.config = {
      maxWorkers: config.maxWorkers ?? 15,
      idleTimeoutMs: config.idleTimeoutMs ?? 30 * 60 * 1000, // 30 minutes
      maxOldSpaceSize: config.maxOldSpaceSize ?? 512,
      piPath: config.piPath ?? 'pi',
    };
    this.workerLauncher = config.workerLauncher;
    this.commandTimeoutMs = config.commandTimeoutMs;
    this.readinessFallbackMs = config.readinessFallbackMs;
    this.ownershipKind = config.ownershipKind ?? (config.workerLauncher ? 'contained' : 'plain');
  }

  /**
   * Get or create a worker for a session.
   */
  async getOrCreate(
    sessionPath: string,
    options?: Partial<WorkerOptions>,
    assignment?: WorkerAssignmentIdentity,
  ): Promise<SessionWorker> {
    if (this.shuttingDown) {
      throw new Error('Worker pool is shutting down');
    }

    const pendingTermination = this.terminating.get(sessionPath);
    if (pendingTermination) {
      await pendingTermination;
      return this.getOrCreate(sessionPath, options, assignment);
    }
    const pendingCreation = this.creating.get(sessionPath);
    if (pendingCreation) return pendingCreation;

    // Sweep any workers whose process has exited/crashed (status 'terminated')
    // so they no longer occupy capacity. This is the lazy half of the unified
    // cleanup path; explicit terminate()/cleanupIdle()/shutdownAll() release
    // eagerly. Converges exit/crash/explicit-delete onto one idempotent path.
    this.cleanupTerminated();

    // Check if worker already exists
    const existing = this.workers.get(sessionPath);
    if (existing && existing.status !== 'terminated') {
      this.validateWarmAssignment(existing, assignment);
      return existing;
    }
    // A terminated process remains owned until its launcher proves the full
    // resource boundary empty/collected. Quarantine blocks unsafe re-creation.
    if (existing) {
      if (existing.resourceLifecycle !== 'released') {
        throw new Error(`Worker session resource is quarantined or reconciling: ${sessionPath}`);
      }
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

    this.claimOwnership(sessionPath);

    // Create new worker
    const workerOptions: WorkerOptions = {
      sessionPath,
      maxOldSpaceSize: this.config.maxOldSpaceSize,
      ...options,
    };

    let worker: SessionWorker;
    try {
      worker = new SessionWorker(workerOptions, {
        executable: this.config.piPath,
        launcher: this.workerLauncher,
        assignment,
        commandTimeoutMs: this.commandTimeoutMs,
        readinessFallbackMs: this.readinessFallbackMs,
      });
    } catch (error) {
      const owner = globalWorkerOwners.get(sessionPath);
      if (owner?.poolId === this.poolId) globalWorkerOwners.delete(sessionPath);
      throw error;
    }
    this.workers.set(sessionPath, worker);
    const unsubscribeTermination = worker.onTerminated(() => {
      this.release(sessionPath, worker);
    });
    this.terminationUnsubscribers.set(worker, unsubscribeTermination);

    const creation = (async () => {
      try {
        await worker.spawn();
        return worker;
      } catch (error) {
        await worker.terminate();
        this.release(sessionPath, worker);
        throw error;
      }
    })();
    this.creating.set(sessionPath, creation);
    try {
      return await creation;
    } finally {
      if (this.creating.get(sessionPath) === creation) this.creating.delete(sessionPath);
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
    if (current.resourceLifecycle !== undefined && current.resourceLifecycle !== 'released') return false;
    this.workers.delete(sessionPath);
    const owner = globalWorkerOwners.get(sessionPath);
    if (owner?.poolId === this.poolId) globalWorkerOwners.delete(sessionPath);
    const unsubscribeTermination = this.terminationUnsubscribers.get(current);
    if (unsubscribeTermination) {
      unsubscribeTermination();
      this.terminationUnsubscribers.delete(current);
    }
    return true;
  }

  private validateWarmAssignment(worker: SessionWorker, requested?: WorkerAssignmentIdentity): void {
    const bound = worker.assignmentIdentity;
    if (!bound && !requested) return;
    if (!bound || !requested) {
      throw new Error('Worker assignment identity cannot change between plain and contained ownership');
    }
    if (
      bound.sessionId !== requested.sessionId
      || bound.sessionPath !== requested.sessionPath
      || bound.executionInstanceId !== requested.executionInstanceId
      || bound.profile !== requested.profile
      || requested.attemptEpoch < bound.attemptEpoch
      || (requested.attemptEpoch === bound.attemptEpoch && requested.runId !== bound.runId)
    ) {
      throw new Error(`Warm worker assignment owner identity mismatch: ${requested.sessionId}`);
    }
  }

  private claimOwnership(sessionPath: string): void {
    const existing = globalWorkerOwners.get(sessionPath);
    if (existing && existing.poolId !== this.poolId) {
      throw new Error(`Worker session is already owned by ${existing.kind} path: ${sessionPath}`);
    }
    globalWorkerOwners.set(sessionPath, { poolId: this.poolId, kind: this.ownershipKind });
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
      if (worker.status === 'terminated' && worker.resourceLifecycle === 'released') {
        if (this.release(path, worker)) removed++;
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
        terminations.push(this.terminateOwned(path, worker));
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
    const pending = this.terminating.get(sessionPath);
    if (pending) return pending;
    const worker = this.workers.get(sessionPath);
    if (worker) await this.terminateOwned(sessionPath, worker);
  }

  private terminateOwned(sessionPath: string, worker: SessionWorker): Promise<void> {
    const pending = this.terminating.get(sessionPath);
    if (pending) return pending;
    const termination = (async () => {
      await worker.terminate();
      this.release(sessionPath, worker);
    })();
    this.terminating.set(sessionPath, termination);
    void termination.finally(() => {
      if (this.terminating.get(sessionPath) === termination) this.terminating.delete(sessionPath);
    }).catch(() => undefined);
    return termination;
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

  /** Bounded lifecycle cardinality for cleanup/reconciliation evidence. */
  getLifecycleCardinality(): {
    workers: number;
    creating: number;
    terminating: number;
    terminationObservers: number;
    cleanupTimers: number;
  } {
    return {
      workers: this.workers.size,
      creating: this.creating.size,
      terminating: this.terminating.size,
      terminationObservers: this.terminationUnsubscribers.size,
      cleanupTimers: this.cleanupInterval ? 1 : 0,
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
    this.shutdownPromise = (async () => {
      const teardownResults = await Promise.allSettled(entries.map(async ([sessionPath, worker]) => {
        await worker.terminate();
        this.release(sessionPath, worker);
      }));
      await Promise.allSettled(this.creating.values());
      this.creating.clear();
      const failures = teardownResults
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason);
      if (failures.length > 0) {
        const detail = failures.map((failure) => failure instanceof Error ? failure.message : String(failure)).join('; ');
        throw new AggregateError(failures, `Worker pool shutdown failed after all owners settled: ${detail}`);
      }
    })();

    return this.shutdownPromise;
  }
}
