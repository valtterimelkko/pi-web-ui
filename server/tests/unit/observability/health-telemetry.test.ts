import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HealthTelemetry,
  createFileAlertSink,
  createHealthTelemetryConfig,
  createIngressAlertSink,
  createNoopAlertSink,
  resolveObservabilityMetricsDir,
  type HealthAlertSink,
} from '../../../src/observability/health-telemetry.js';
import type { HealthAlert } from '../../../src/observability/health-alerts.js';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'a2-telemetry-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface MemoryState {
  heapUsed: number;
  heapTotal: number;
  rss: number;
  external: number;
}

function telemetryOptions(overrides: {
  dir: string;
  sink?: HealthAlertSink;
  state: MemoryState;
  intervalMs?: number;
  maxFileBytes?: number;
  maxFiles?: number;
  heapFractionHigh?: number;
  heapFractionLow?: number;
  now?: () => number;
}) {
  return {
    config: {
      enabled: true,
      dir: overrides.dir,
      intervalMs: overrides.intervalMs ?? 1_000,
      maxFileBytes: overrides.maxFileBytes ?? 100_000,
      maxFiles: overrides.maxFiles ?? 3,
      thresholds: {
        heapFractionHigh: overrides.heapFractionHigh ?? 0.8,
        heapFractionLow: overrides.heapFractionLow ?? 0.7,
        lagP99HighMs: 60_000,
        lagP99LowMs: 30_000,
      },
      sink: overrides.sink ?? createNoopAlertSink(),
      sinkDescription: 'test',
      suppressOperatorNotifications: false,
    },
    sources: {
      now: overrides.now ?? (() => 1_700_000_000_000),
      uptimeSec: () => 12,
      memoryUsage: () => ({ ...overrides.state }),
      heapLimitBytes: () => 100_000,
      lagWindow: () => ({ windowMs: 60_000, sampleCount: 5, p50Ms: 1, p99Ms: 2, maxMs: 3 }),
      residentSessions: () => 2,
    },
  };
}

describe('resolveObservabilityMetricsDir', () => {
  it('defaults to the production metrics directory', () => {
    expect(resolveObservabilityMetricsDir({} as NodeJS.ProcessEnv)).toBe(
      path.join(homedir(), '.pi-web-ui', 'metrics'),
    );
  });

  it('never resolves the production path for a validation server', () => {
    const dir = resolveObservabilityMetricsDir({
      HOME: '/root',
      PI_WEB_UI_VALIDATION_MODE: 'true',
      PI_WEB_UI_VALIDATION_RECORD_DIR: '/root/a2-validation/run-1',
    } as NodeJS.ProcessEnv);
    expect(dir).toBe('/root/a2-validation/run-1/metrics');
    expect(dir).not.toContain(path.join('.pi-web-ui', 'metrics'));
  });

  it('honours an explicit absolute override but rejects a relative one', () => {
    expect(resolveObservabilityMetricsDir({ OBSERVABILITY_METRICS_DIR: '/tmp/a2-metrics' } as NodeJS.ProcessEnv)).toBe('/tmp/a2-metrics');
    expect(() => resolveObservabilityMetricsDir({ OBSERVABILITY_METRICS_DIR: 'relative/path' } as NodeJS.ProcessEnv)).toThrow(/absolute/);
  });
});

describe('createHealthTelemetryConfig', () => {
  it('refuses to write the production metrics path while in validation mode', () => {
    const config = createHealthTelemetryConfig({
      PI_WEB_UI_VALIDATION_MODE: 'true',
      OBSERVABILITY_METRICS_DIR: path.join(homedir(), '.pi-web-ui', 'metrics'),
    } as NodeJS.ProcessEnv);
    expect(config.enabled).toBe(false);
    expect(config.suppressedReason).toMatch(/production metrics path/);
  });

  it('defaults the alert sink to the notification ingress spool with hysteresis thresholds', () => {
    const config = createHealthTelemetryConfig({
      HOME: '/root',
      NOTIFICATIONS_DIR: '/root/.pi-web-ui/notifications',
    } as NodeJS.ProcessEnv);
    expect(config.enabled).toBe(true);
    expect(config.sinkDescription).toBe(`ingress:/root/.pi-web-ui/notifications/ingress`);
    expect(config.thresholds.heapFractionLow).toBeLessThan(config.thresholds.heapFractionHigh);
    expect(config.thresholds.lagP99LowMs).toBeLessThan(config.thresholds.lagP99HighMs);
  });

  it('captures alerts to a file in validation mode and says so through the description', () => {
    const config = createHealthTelemetryConfig({
      HOME: '/root',
      PI_WEB_UI_VALIDATION_MODE: 'true',
      PI_WEB_UI_VALIDATION_RECORD_DIR: '/tmp/a2-run',
      NOTIFICATIONS_DIR: '/tmp/a2-run/notifications',
    } as NodeJS.ProcessEnv);
    expect(config.sinkDescription).toBe('file:/tmp/a2-run/metrics/alerts.jsonl');
    expect(config.suppressOperatorNotifications).toBe(true);
  });

  it('accepts lowered thresholds from the environment for a live proof', () => {
    const config = createHealthTelemetryConfig({
      OBSERVABILITY_METRICS_INTERVAL_MS: '1000',
      OBSERVABILITY_METRICS_MAX_FILE_BYTES: '2048',
      OBSERVABILITY_METRICS_MAX_FILES: '4',
      OBSERVABILITY_HEALTH_ALERT_HEAP_FRACTION: '0.05',
      OBSERVABILITY_HEALTH_ALERT_HEAP_RECOVER_FRACTION: '0.04',
      OBSERVABILITY_HEALTH_ALERT_LAG_P99_MS: '800',
      OBSERVABILITY_HEALTH_ALERT_LAG_RECOVER_MS: '300',
    } as NodeJS.ProcessEnv);
    expect(config).toMatchObject({
      intervalMs: 1_000,
      maxFileBytes: 2_048,
      maxFiles: 4,
      thresholds: { heapFractionHigh: 0.05, heapFractionLow: 0.04, lagP99HighMs: 800, lagP99LowMs: 300 },
    });
  });
});

describe('HealthTelemetry', () => {
  it('appends one JSON sample per cadence and fires exactly one alert then one recovery', async () => {
    const dir = await tempDir();
    const alerts: HealthAlert[] = [];
    const state: MemoryState = { heapUsed: 50_000, heapTotal: 60_000, rss: 70_000, external: 1 };
    const telemetry = new HealthTelemetry(
      telemetryOptions({ dir, state, sink: async (alert) => { alerts.push(alert); } }),
    );

    await telemetry.sampleOnce();
    expect(alerts).toHaveLength(0);
    state.heapUsed = 85_000; // 0.85 > 0.8
    await telemetry.sampleOnce();
    state.heapUsed = 80_500; // inside the band
    await telemetry.sampleOnce();
    state.heapUsed = 79_000; // inside the band
    await telemetry.sampleOnce();
    state.heapUsed = 69_000; // 0.69 < 0.7
    await telemetry.sampleOnce();

    expect(alerts.map((alert) => `${alert.kind}:${alert.transition}`)).toEqual([
      'heap_pressure:alert',
      'heap_pressure:recovery',
    ]);

    const lines = (await readFile(path.join(dir, 'health-metrics.jsonl'), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(5);
    const first = JSON.parse(lines[0]);
    expect(first).toMatchObject({
      heapUsedBytes: 50_000,
      heapLimitBytes: 100_000,
      heapFraction: 0.5,
      rssBytes: 70_000,
      externalBytes: 1,
      lagP50Ms: 1,
      lagP99Ms: 2,
      lagMaxMs: 3,
      residentSessions: 2,
      activeTurns: 0,
    });
    expect(typeof first.at).toBe('string');
  });

  it('rotates the metrics file at its configured bound while sampling', async () => {
    const dir = await tempDir();
    const state: MemoryState = { heapUsed: 10, heapTotal: 20, rss: 30, external: 1 };
    const telemetry = new HealthTelemetry(
      telemetryOptions({ dir, state, maxFileBytes: 600, maxFiles: 2 }),
    );
    for (let index = 0; index < 30; index++) await telemetry.sampleOnce();
    const names = (await readdir(dir)).sort();
    expect(names).toEqual(['health-metrics.1.jsonl', 'health-metrics.jsonl']);
    for (const name of names) {
      const content = await readFile(path.join(dir, name), 'utf8');
      expect(Buffer.byteLength(content)).toBeLessThanOrEqual(600);
    }
  });

  it('samples on the configured interval once started and stops cleanly', async () => {
    vi.useFakeTimers();
    const dir = await tempDir();
    const state: MemoryState = { heapUsed: 10, heapTotal: 20, rss: 30, external: 1 };
    // Cadence is asserted against a counting sink; the real file's growth at the
    // configured cadence is asserted by the disposable live proof.
    const lines: string[] = [];
    const metricsFile = {
      currentPath: path.join(dir, 'health-metrics.jsonl'),
      append: async (line: string) => { lines.push(line); },
    } as unknown as import('../../../src/observability/health-metrics-file.js').RotatingMetricsFile;
    const telemetry = new HealthTelemetry({ ...telemetryOptions({ dir, state, intervalMs: 1_000 }), metricsFile });
    telemetry.start();
    await vi.advanceTimersByTimeAsync(4_100);
    telemetry.stop();
    // One sample immediately on start, then one per interval tick (4).
    expect(lines).toHaveLength(5);
    expect(lines.every((line) => JSON.parse(line).heapUsedBytes === 10)).toBe(true);
  });

  it('is inert when disabled', async () => {
    const dir = path.join(await tempDir(), 'metrics');
    const state: MemoryState = { heapUsed: 10, heapTotal: 20, rss: 30, external: 1 };
    const options = telemetryOptions({ dir, state });
    const telemetry = new HealthTelemetry({ ...options, config: { ...options.config, enabled: false } });
    await telemetry.sampleOnce();
    await expect(readdir(dir)).rejects.toThrow();
  });
});

describe('alert sinks', () => {
  it('appends JSONL to the capture file for a validation run', async () => {
    const dir = await tempDir();
    const sink = createFileAlertSink(path.join(dir, 'nested', 'alerts.jsonl'));
    await sink({ kind: 'heap_pressure', transition: 'alert', at: 'now', value: 1, threshold: 0.5, message: 'm1' });
    await sink({ kind: 'heap_pressure', transition: 'recovery', at: 'now', value: 0, threshold: 0.5, message: 'm2' });
    const lines = (await readFile(path.join(dir, 'nested', 'alerts.jsonl'), 'utf8')).trim().split('\n');
    expect(lines.map((line) => JSON.parse(line).transition)).toEqual(['alert', 'recovery']);
  });

  it('writes a delivery-ready notification ingress record for the operator path', async () => {
    const dir = await tempDir();
    const sink = createIngressAlertSink({ ingressDir: dir, now: () => 1_700_000_000_000 });
    await sink({ kind: 'event_loop_lag', transition: 'alert', at: 'now', value: 900, threshold: 500, message: 'lag is high' });
    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    const record = JSON.parse(await readFile(path.join(dir, files[0]), 'utf8'));
    expect(record).toMatchObject({ version: 1, title: expect.stringContaining('event-loop lag') });
    expect(record.body).toContain('lag is high');
    expect(Date.parse(record.expiresAt)).toBeGreaterThan(Date.parse(record.createdAt));
    expect(record.idempotencyKey).toMatch(/^health-alert-/);
  });
});
