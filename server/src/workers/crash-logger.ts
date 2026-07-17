/**
 * Worker Crash Logger
 * Tracks and logs worker process crashes for monitoring and debugging.
 * Maintains a circular buffer of recent crashes with categorization.
 */

import { WorkerStatus } from '@pi-web-ui/shared';
import { createLogger } from '../logging/logger.js';

const structuredLogger = createLogger('CrashLogger');

export type CrashType = 'graceful' | 'oom_killed' | 'crashed' | 'signal_terminated' | 'spawn_failed' | 'unknown';

export interface WorkerCrashRecord {
  /** Unique ID for this crash record */
  id: string;
  /** Session path that the worker was serving */
  sessionPath: string;
  /** Process ID of the worker */
  pid?: number;
  /** When the crash occurred */
  timestamp: number;
  /** Type of crash */
  type: CrashType;
  /** Exit code (null if killed by signal) */
  exitCode: number | null;
  /** Signal that terminated the process (null if exited normally) */
  signal: string | null;
  /** Memory limit in MB that was set for this worker */
  memoryLimitMB: number;
  /** How long the worker was alive (ms) */
  lifetimeMs: number;
  /** Error message if available */
  errorMessage?: string;
  /** Previous status before crash */
  previousStatus: WorkerStatus;
}

export interface CrashStats {
  /** Total crashes recorded */
  totalCrashes: number;
  /** Crashes in the last 24 hours */
  crashesLast24h: number;
  /** Crashes in the last hour */
  crashesLastHour: number;
  /** Count by crash type */
  byType: Record<CrashType, number>;
  /** Sessions with most crashes */
  topSessions: Array<{ sessionPath: string; crashCount: number }>;
  /** OOM-specific stats */
  oomStats: {
    total: number;
    last24h: number;
    averageLifetimeMs: number;
  };
}

export interface CrashLoggerConfig {
  /** Maximum number of crash records to keep (circular buffer) */
  maxRecords: number;
  /** Whether to log crashes to console */
  logToConsole: boolean;
  /** Optional file path to persist crashes */
  persistPath: string | undefined;
}

export class CrashLogger {
  private records: WorkerCrashRecord[] = [];
  private config: Required<CrashLoggerConfig>;
  private sessionCrashCounts: Map<string, number> = new Map();

  constructor(config: Partial<CrashLoggerConfig> = {}) {
    this.config = {
      maxRecords: config.maxRecords ?? 100,
      logToConsole: config.logToConsole ?? true,
      persistPath: config.persistPath,
    };
  }

  /**
   * Record a worker crash.
   */
  recordCrash(params: {
    sessionPath: string;
    pid?: number;
    exitCode: number | null;
    signal: string | null;
    memoryLimitMB: number;
    spawnedAt: number;
    errorMessage?: string;
    previousStatus: WorkerStatus;
  }): WorkerCrashRecord {
    const {
      sessionPath,
      pid,
      exitCode,
      signal,
      memoryLimitMB,
      spawnedAt,
      errorMessage,
      previousStatus,
    } = params;

    const timestamp = Date.now();
    const lifetimeMs = timestamp - spawnedAt;
    const type = this.categorizeCrash(exitCode, signal, errorMessage);

    const record: WorkerCrashRecord = {
      id: this.generateId(),
      sessionPath,
      pid,
      timestamp,
      type,
      exitCode,
      signal,
      memoryLimitMB,
      lifetimeMs,
      errorMessage,
      previousStatus,
    };

    // Add to circular buffer
    this.records.push(record);
    if (this.records.length > this.config.maxRecords) {
      this.records.shift();
    }

    // Update session crash count
    const currentCount = this.sessionCrashCounts.get(sessionPath) ?? 0;
    this.sessionCrashCounts.set(sessionPath, currentCount + 1);

    // Log to console if enabled
    if (this.config.logToConsole) {
      this.logCrash(record);
    }

    // Persist if path configured
    if (this.config.persistPath) {
      this.persistRecord(record).catch((err) => {
        structuredLogger.child({ sessionId: record.sessionPath, crashType: record.type })
          .errorObject('failed to persist worker crash record', err);
      });
    }

    return record;
  }

  /**
   * Categorize a crash based on exit code and signal.
   */
  private categorizeCrash(
    exitCode: number | null,
    signal: string | null,
    errorMessage?: string
  ): CrashType {
    // Check for spawn failure first
    if (errorMessage?.includes('spawn') || errorMessage?.includes('ENOENT')) {
      return 'spawn_failed';
    }

    // Normal exit
    if (exitCode === 0 && signal === null) {
      return 'graceful';
    }

    // OOM detection: SIGKILL (null exit code, signal 9) often indicates OOM
    if (signal === 'SIGKILL' || signal === '9') {
      return 'oom_killed';
    }

    // Signal termination (not OOM)
    if (signal !== null) {
      return 'signal_terminated';
    }

    // Non-zero exit code = crash
    if (exitCode !== null && exitCode !== 0) {
      // Common Node.js crash codes that indicate OOM
      if (exitCode === 134 || exitCode === 139) {
        return 'oom_killed';
      }
      return 'crashed';
    }

    return 'unknown';
  }

  /** Publish a crash record through the central structured logger. */
  private logCrash(record: WorkerCrashRecord): void {
    const { type, sessionPath, exitCode, signal, lifetimeMs, pid } = record;
    const log = structuredLogger.child({
      sessionId: sessionPath,
      pid,
      crashType: type,
      exitCode,
      signal,
      lifetimeMs,
      memoryLimitMB: record.memoryLimitMB,
      previousStatus: record.previousStatus,
    });
    const message = `worker exited: type=${type} exit=${exitCode} signal=${signal} lifetimeMs=${lifetimeMs}`;

    switch (type) {
      case 'oom_killed':
        log.warn(`${message}; likely out of memory, consider increasing PI_WORKER_MEMORY`);
        break;
      case 'spawn_failed':
      case 'crashed':
        log.error(message);
        break;
      case 'signal_terminated':
        log.info(message);
        break;
      case 'graceful':
        break;
      default:
        log.warn(message);
    }

    const sessionCrashes = this.sessionCrashCounts.get(sessionPath) ?? 0;
    if (sessionCrashes > 1 && type !== 'graceful') {
      log.warn(`session worker has crashed ${sessionCrashes} times in the current process`);
    }
  }

  /**
   * Generate a unique ID for a crash record.
   */
  private generateId(): string {
    return `crash_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Persist a crash record to file.
   */
  private async persistRecord(record: WorkerCrashRecord): Promise<void> {
    // Dynamic import to avoid loading fs unnecessarily
    const { appendFile } = await import('fs/promises');
    const line = JSON.stringify(record) + '\n';
    await appendFile(this.config.persistPath!, line, 'utf-8');
  }

  /**
   * Get all crash records (newest first).
   */
  getRecords(options?: { limit?: number; type?: CrashType; sessionPath?: string }): WorkerCrashRecord[] {
    let records = [...this.records].reverse();

    if (options?.type) {
      records = records.filter((r) => r.type === options.type);
    }

    if (options?.sessionPath) {
      records = records.filter((r) => r.sessionPath === options.sessionPath);
    }

    if (options?.limit) {
      records = records.slice(0, options.limit);
    }

    return records;
  }

  /**
   * Get crash statistics.
   */
  getStats(): CrashStats {
    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    const oneHourAgo = now - 60 * 60 * 1000;

    const last24h = this.records.filter((r) => r.timestamp >= oneDayAgo);
    const lastHour = this.records.filter((r) => r.timestamp >= oneHourAgo);
    const oomRecords = this.records.filter((r) => r.type === 'oom_killed');
    const oomLast24h = oomRecords.filter((r) => r.timestamp >= oneDayAgo);

    // Count by type
    const byType: Record<CrashType, number> = {
      graceful: 0,
      oom_killed: 0,
      crashed: 0,
      signal_terminated: 0,
      spawn_failed: 0,
      unknown: 0,
    };

    for (const record of this.records) {
      byType[record.type]++;
    }

    // Top sessions by crash count
    const topSessions = Array.from(this.sessionCrashCounts.entries())
      .map(([sessionPath, crashCount]) => ({ sessionPath, crashCount }))
      .sort((a, b) => b.crashCount - a.crashCount)
      .slice(0, 10);

    // OOM average lifetime
    const oomLifetimeAvg =
      oomRecords.length > 0
        ? oomRecords.reduce((sum, r) => sum + r.lifetimeMs, 0) / oomRecords.length
        : 0;

    return {
      totalCrashes: this.records.length,
      crashesLast24h: last24h.length,
      crashesLastHour: lastHour.length,
      byType,
      topSessions,
      oomStats: {
        total: oomRecords.length,
        last24h: oomLast24h.length,
        averageLifetimeMs: Math.round(oomLifetimeAvg),
      },
    };
  }

  /**
   * Get crash count for a specific session.
   */
  getSessionCrashCount(sessionPath: string): number {
    return this.sessionCrashCounts.get(sessionPath) ?? 0;
  }

  /**
   * Get recent OOM kills.
   */
  getRecentOOMs(limit = 10): WorkerCrashRecord[] {
    return this.getRecords({ type: 'oom_killed', limit });
  }

  /**
   * Check if there have been any OOM kills recently.
   */
  hasRecentOOMs(withinMs: number = 60 * 60 * 1000): boolean {
    const cutoff = Date.now() - withinMs;
    return this.records.some(
      (r) => r.type === 'oom_killed' && r.timestamp >= cutoff
    );
  }

  /**
   * Clear all records (useful for testing).
   */
  clear(): void {
    this.records = [];
    this.sessionCrashCounts.clear();
  }
}

// Singleton instance
let globalCrashLogger: CrashLogger | null = null;

/**
 * Get or create the global crash logger instance.
 */
export function getCrashLogger(config?: Partial<CrashLoggerConfig>): CrashLogger {
  if (!globalCrashLogger) {
    globalCrashLogger = new CrashLogger(config);
  }
  return globalCrashLogger;
}

/**
 * Reset the global crash logger (useful for testing).
 */
export function resetCrashLogger(): void {
  globalCrashLogger = null;
}
