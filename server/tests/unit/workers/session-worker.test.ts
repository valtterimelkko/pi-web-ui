import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SessionWorker } from '../../../src/workers/session-worker.js';
import { OperationalMetrics } from '../../../src/observability/operational-metrics.js';
import { setLogTap, type LogRecord } from '../../../src/logging/logger.js';
import { getCrashLogger, resetCrashLogger } from '../../../src/workers/crash-logger.js';
import type { WorkerLauncher } from '../../../src/workers/worker-launcher.js';

describe('SessionWorker', () => {
  let worker: SessionWorker;

  const testOptions = {
    sessionPath: '/tmp/test-session.jsonl',
    maxOldSpaceSize: 256,
  };

  beforeEach(() => {
    worker = new SessionWorker(testOptions);
  });

  afterEach(async () => {
    resetCrashLogger();
    if (worker) {
      await worker.terminate().catch(() => undefined);
    }
  });

  describe('constructor', () => {
    it('should initialize with correct session path', () => {
      expect(worker.sessionPath).toBe('/tmp/test-session.jsonl');
    });

    it('should start in spawning status', () => {
      expect(worker.status).toBe('spawning');
    });
  });

  it('rejects a contained assignment whose durable session path differs from the worker path', () => {
    expect(() => new SessionWorker(testOptions, {
      assignment: {
        sessionId: 'session-1', sessionPath: '/tmp/other.jsonl', runId: 'run-1',
        executionInstanceId: 'phase6-v1', attemptEpoch: 1, profile: 'heavy',
      },
    })).toThrow(/sessionPath.*does not match/i);
  });

  describe('subscribe', () => {
    it('should allow event subscription', () => {
      const handler = vi.fn();
      const unsubscribe = worker.subscribe(handler);
      
      expect(typeof unsubscribe).toBe('function');
      unsubscribe();
    });
  });

  it('uses the injected launcher identity and delegates exact resource teardown', async () => {
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, {
      pid: 1111,
      stdin: { write: vi.fn() },
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });
    const terminate = vi.fn(async () => {
      child.emit('exit', 0, 'SIGTERM');
    });
    const snapshot = vi.fn(async () => ({
      observedAt: '2026-08-05T00:00:00.000Z', populated: true, memberPids: [2222],
      memoryCurrentBytes: 1024, memoryEvents: { high: 0 }, pidsCurrent: 1, pidsEvents: { max: 0 },
    }));
    const launcher: WorkerLauncher = {
      launch: vi.fn(async () => {
        setImmediate(() => child.emit('spawn'));
        return {
          process: child,
          resourceIdentity: {
            kind: 'systemd-transient',
            mainPid: 2222,
            launcherPid: 1111,
            unitName: 'pi-web-ui-phase6-test-worker.service',
            sliceName: 'pi-web-ui-phase6-test.slice',
            cgroupPath: '/pi-web-ui-phase6-test.slice/pi-web-ui-phase6-test-worker.service',
            launchTokenSha256: '0'.repeat(64),
            observedProperties: {},
          },
          terminate,
          snapshot,
        };
      }),
    };
    worker = new SessionWorker(testOptions, {
      launcher,
      executable: '/opt/pi/bin/pi',
      readinessFallbackMs: 50,
    });

    await worker.spawn();
    expect(launcher.launch).toHaveBeenCalledWith(expect.objectContaining({ executable: '/opt/pi/bin/pi' }));
    expect(worker.pid).toBe(2222);
    expect(worker.resourceIdentity).toMatchObject({ kind: 'systemd-transient', mainPid: 2222, launcherPid: 1111 });
    expect(await worker.snapshotResource()).toMatchObject({ populated: true, memberPids: [2222], memoryCurrentBytes: 1024 });
    expect(snapshot).toHaveBeenCalledTimes(1);

    await worker.terminate();
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('reconciles a launch handle that arrives after termination was requested', async () => {
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, {
      pid: 2111,
      stdin: { write: vi.fn() }, stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(),
    });
    let resolveLaunch!: (handle: Awaited<ReturnType<WorkerLauncher['launch']>>) => void;
    const delayedLaunch = new Promise<Awaited<ReturnType<WorkerLauncher['launch']>>>((resolve) => { resolveLaunch = resolve; });
    const terminate = vi.fn(async () => { child.emit('exit', 0, 'SIGTERM'); });
    const launcher: WorkerLauncher = { launch: vi.fn(() => delayedLaunch) };
    worker = new SessionWorker(testOptions, { launcher, readinessFallbackMs: 50 });

    const spawning = worker.spawn();
    const terminating = worker.terminate();
    resolveLaunch({
      process: child,
      resourceIdentity: { kind: 'plain', mainPid: 2111, launcherPid: 2111 },
      snapshot: vi.fn(async () => ({ observedAt: new Date().toISOString(), populated: true, memberPids: [2111] })),
      terminate,
    });

    await expect(spawning).rejects.toThrow(/termination was requested/i);
    await expect(terminating).resolves.toBeUndefined();
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(worker.resourceLifecycle).toBe('released');
  });

  it('quarantines ownership when exact resource teardown fails after process exit', async () => {
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, {
      pid: 3111,
      stdin: { write: vi.fn() }, stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(),
    });
    const teardownError = new Error('cgroup remained populated');
    const launcher: WorkerLauncher = {
      launch: vi.fn(async () => {
        setImmediate(() => child.emit('spawn'));
        return {
          process: child,
          resourceIdentity: {
            kind: 'systemd-transient', mainPid: 3222, launcherPid: 3111,
            unitName: 'pi-web-ui-phase6-test-worker-deadbeef.service',
            sliceName: 'pi-web-ui-phase6-test.slice',
            cgroupPath: '/pi-web-ui-phase6-test.slice/pi-web-ui-phase6-test-worker-deadbeef.service',
            launchTokenSha256: '0'.repeat(64),
            observedProperties: {},
          },
          snapshot: vi.fn(),
          terminate: vi.fn(async () => {
            child.emit('exit', 0, 'SIGTERM');
            throw teardownError;
          }),
        };
      }),
    };
    worker = new SessionWorker(testOptions, { launcher, readinessFallbackMs: 50 });
    const released = vi.fn();
    worker.onTerminated(released);
    await worker.spawn();

    await expect(worker.terminate()).rejects.toThrow(/cgroup remained populated/i);
    expect(worker.resourceLifecycle).toBe('quarantined');
    expect(released).not.toHaveBeenCalled();
  });

  // Note: Actual default-launcher spawn tests require the pi binary and are integration tests.
  it('should track stable spawn and activity timestamps', () => {
    const initial = worker.lastActivity;
    expect(initial).toBeGreaterThan(0);
    expect(worker.spawnedAt).toBeGreaterThan(0);
  });

  it('does not classify a normal zero-code exit as a crash', () => {
    const crashLogger = getCrashLogger({ logToConsole: false });
    (worker as unknown as { handleExit(code: number | null, signal: string | null): void }).handleExit(0, null);
    expect(crashLogger.getStats().totalCrashes).toBe(0);
  });

  it('records a warning and metric when readiness uses the bounded fallback', async () => {
    const metrics = new OperationalMetrics();
    const fallbackWorker = new SessionWorker(testOptions, { metrics, readinessFallbackMs: 5 });
    const records: LogRecord[] = [];
    setLogTap((record) => records.push(record));
    try {
      await (fallbackWorker as unknown as { waitForReady(timeout?: number): Promise<void> }).waitForReady(100);
      expect(metrics.snapshot().pipeline.workerReadinessFallbacks).toBe(1);
      expect(records.some((record) =>
        record.component === 'SessionWorker'
        && record.level === 'warn'
        && record.msg.includes('readiness fallback'),
      )).toBe(true);
    } finally {
      setLogTap(null);
      await fallbackWorker.terminate();
    }
  });
});
