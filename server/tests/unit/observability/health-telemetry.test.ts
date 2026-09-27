import { mkdtemp, readFile, readdir, rm, mkdir, symlink } from 'node:fs/promises';
import { homedir, tmpdir, userInfo } from 'node:os';
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
      warnings: [],
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
  it('defaults to the real production metrics directory, independent of HOME', () => {
    // HOME is mutable (a validation child gets a fake one); the production
    // boundary must come from the account database instead.
    expect(resolveObservabilityMetricsDir({ HOME: '/tmp/fake-home' } as NodeJS.ProcessEnv)).toBe(
      path.join(userInfo().homedir, '.pi-web-ui', 'metrics'),
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

// ─── Correction 02, finding 1: production-path confinement in validation mode ──
//
// The production boundary must not be derived from the mutable HOME: a
// validation child gets a fake HOME, so `os.homedir()`-based comparisons are
// useless there. The confinement rule is canonical/symlink-resolved containment
// inside the validation run directory, plus the real production metrics dir as
// an explicitly forbidden target.
describe('validation-mode production-path confinement', () => {
  async function runFixture() {
    const root = await tempDir();
    const recordDir = path.join(root, 'validation');
    const home = path.join(root, 'home');
    await mkdir(path.join(recordDir, 'metrics'), { recursive: true });
    await mkdir(home, { recursive: true });
    return { root, recordDir, home };
  }

  it('refuses an explicit production metrics directory under a fake HOME', async () => {
    const { recordDir, home } = await runFixture();
    // The real (getpwuid) production metrics dir, whatever HOME says.
    const productionDir = path.join(userInfo().homedir, '.pi-web-ui', 'metrics');
    const config = createHealthTelemetryConfig({
      HOME: home,
      PI_WEB_UI_VALIDATION_MODE: 'true',
      PI_WEB_UI_VALIDATION_RECORD_DIR: recordDir,
      OBSERVABILITY_METRICS_DIR: productionDir,
    } as NodeJS.ProcessEnv);
    expect(config.enabled).toBe(false);
    expect(config.dir).toBe(productionDir);
    expect(config.suppressedReason).toContain(productionDir);
    expect(config.suppressedReason).toMatch(/validation run directory|production/);
  });

  it('refuses an explicit production file: alert sink', async () => {
    const { recordDir, home } = await runFixture();
    const productionSink = path.join(userInfo().homedir, '.pi-web-ui', 'metrics', 'alerts.jsonl');
    const config = createHealthTelemetryConfig({
      HOME: home,
      PI_WEB_UI_VALIDATION_MODE: 'true',
      PI_WEB_UI_VALIDATION_RECORD_DIR: recordDir,
      OBSERVABILITY_HEALTH_ALERT_SINK: `file:${productionSink}`,
    } as NodeJS.ProcessEnv);
    expect(config.enabled).toBe(false);
    expect(config.suppressedReason).toContain(productionSink);
  });

  it('refuses a metrics directory that reaches outside through a symlink', async () => {
    const { root, recordDir, home } = await runFixture();
    const outside = path.join(root, 'outside-metrics');
    await mkdir(outside, { recursive: true });
    // <recordDir>/escape -> <root>/outside-metrics (an alias of a path outside the run dir)
    await symlink(outside, path.join(recordDir, 'escape'), 'dir');
    const config = createHealthTelemetryConfig({
      HOME: home,
      PI_WEB_UI_VALIDATION_MODE: 'true',
      PI_WEB_UI_VALIDATION_RECORD_DIR: recordDir,
      OBSERVABILITY_METRICS_DIR: path.join(recordDir, 'escape'),
    } as NodeJS.ProcessEnv);
    expect(config.enabled).toBe(false);
    // The reason names the resolved target the write would have reached.
    expect(config.suppressedReason).toContain(path.join(root, 'outside-metrics'));
    expect(config.suppressedReason).toMatch(/outside the validation run directory/);
  });

  it('keeps a canonical path inside the run directory enabled', async () => {
    const { recordDir, home } = await runFixture();
    const config = createHealthTelemetryConfig({
      HOME: home,
      PI_WEB_UI_VALIDATION_MODE: 'true',
      PI_WEB_UI_VALIDATION_RECORD_DIR: recordDir,
      OBSERVABILITY_METRICS_DIR: path.join(recordDir, 'metrics', 'nested'),
    } as NodeJS.ProcessEnv);
    expect(config.enabled).toBe(true);
    expect(config.suppressOperatorNotifications).toBe(true);
  });

  it('forces a non-delivering capture sink when notifications are requested in validation mode', async () => {
    const { recordDir, home } = await runFixture();
    const config = createHealthTelemetryConfig({
      HOME: home,
      PI_WEB_UI_VALIDATION_MODE: 'true',
      PI_WEB_UI_VALIDATION_RECORD_DIR: recordDir,
      NOTIFICATIONS_DIR: path.join(recordDir, 'notifications'),
      NOTIFICATIONS_ENABLED: 'true',
      TELEGRAM_BOT_TOKEN: 'would-be-secret',
      TELEGRAM_CHAT_ID: 'would-be-chat',
      OBSERVABILITY_HEALTH_ALERT_SINK: 'notifications',
    } as NodeJS.ProcessEnv);
    expect(config.enabled).toBe(true);
    expect(config.suppressOperatorNotifications).toBe(true);
    expect(config.sinkDescription).toBe(`file:${path.join(recordDir, 'metrics', 'alerts.jsonl')}`);
    expect(config.warnings.join(' ')).toContain('OBSERVABILITY_HEALTH_ALERT_SINK');
  });
});

describe('createHealthTelemetryConfig', () => {
  it('refuses to write the production metrics path while in validation mode', () => {
    const recordDir = path.join(tmpdir(), `a2-telemetry-guard-${process.pid}`);
    const config = createHealthTelemetryConfig({
      PI_WEB_UI_VALIDATION_MODE: 'true',
      PI_WEB_UI_VALIDATION_RECORD_DIR: recordDir,
      OBSERVABILITY_METRICS_DIR: path.join(homedir(), '.pi-web-ui', 'metrics'),
    } as NodeJS.ProcessEnv);
    expect(config.enabled).toBe(false);
    expect(config.suppressedReason).toMatch(/validation run directory|production/);
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

describe('createHealthTelemetryConfig bounds (correction 02, finding 4)', () => {
  it('falls back to the default interval with a warning when the value is out of range', () => {
    const config = createHealthTelemetryConfig({ OBSERVABILITY_METRICS_INTERVAL_MS: '10' } as NodeJS.ProcessEnv);
    expect(config.intervalMs).toBe(30_000);
    expect(config.warnings.join(' ')).toContain('OBSERVABILITY_METRICS_INTERVAL_MS');
  });

  it('rejects an interval above the safe timer range instead of clamping to 1 ms', () => {
    const config = createHealthTelemetryConfig({ OBSERVABILITY_METRICS_INTERVAL_MS: '2147483648' } as NodeJS.ProcessEnv);
    expect(config.intervalMs).toBe(30_000);
    expect(config.warnings.join(' ')).toContain('OBSERVABILITY_METRICS_INTERVAL_MS');
  });

  it('documents why: Node clamps a setInterval delay above 2**31-1 to 1 ms', async () => {
    let fired = 0;
    const timer = setInterval(() => { fired += 1; }, 2 ** 31);
    await new Promise((resolve) => setTimeout(resolve, 50));
    clearInterval(timer);
    expect(fired).toBeGreaterThan(0);
  });

  it('bounds the rotation settings and rejects unsafe integers', () => {
    const tiny = createHealthTelemetryConfig({ OBSERVABILITY_METRICS_MAX_FILE_BYTES: '10', OBSERVABILITY_METRICS_MAX_FILES: '100000' } as NodeJS.ProcessEnv);
    expect(tiny.maxFileBytes).toBe(5 * 1024 * 1024);
    expect(tiny.maxFiles).toBe(5);
    expect(tiny.warnings.join(' ')).toContain('OBSERVABILITY_METRICS_MAX_FILE_BYTES');
    expect(tiny.warnings.join(' ')).toContain('OBSERVABILITY_METRICS_MAX_FILES');

    const unsafe = createHealthTelemetryConfig({ OBSERVABILITY_METRICS_MAX_FILE_BYTES: '1e20', OBSERVABILITY_METRICS_MAX_FILES: '4.5' } as NodeJS.ProcessEnv);
    expect(unsafe.maxFileBytes).toBe(5 * 1024 * 1024);
    expect(unsafe.maxFiles).toBe(5);
    expect(unsafe.warnings).toHaveLength(2);
  });

  it('keeps valid in-range values without warnings', () => {
    const config = createHealthTelemetryConfig({
      OBSERVABILITY_METRICS_INTERVAL_MS: '1000',
      OBSERVABILITY_METRICS_MAX_FILE_BYTES: '4096',
      OBSERVABILITY_METRICS_MAX_FILES: '3',
    } as NodeJS.ProcessEnv);
    expect(config).toMatchObject({ intervalMs: 1_000, maxFileBytes: 4_096, maxFiles: 3, warnings: [] });
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

  it('evaluates and delivers alerts even when the metrics append fails (correction 02, finding 3)', async () => {
    const dir = await tempDir();
    const alerts: HealthAlert[] = [];
    // 0.9 of 100_000 is above the 0.8 high water mark: an alert is due.
    const state: MemoryState = { heapUsed: 90_000, heapTotal: 95_000, rss: 100_000, external: 1 };
    const metricsFile = {
      currentPath: path.join(dir, 'health-metrics.jsonl'),
      append: async () => { throw new Error('EACCES: permission denied'); },
    } as unknown as import('../../../src/observability/health-metrics-file.js').RotatingMetricsFile;
    const telemetry = new HealthTelemetry({ ...telemetryOptions({ dir, state, sink: async (alert) => { alerts.push(alert); } }), metricsFile });

    const readings = await telemetry.sampleOnce();

    expect(readings?.heapFraction).toBe(0.9);
    expect(alerts.map((alert) => `${alert.kind}:${alert.transition}`)).toEqual(['heap_pressure:alert']);
    expect(telemetry.appendFailures).toBe(1);
    // And the failure does not wedge the next sample either.
    const again = await telemetry.sampleOnce();
    expect(again).toBeDefined();
    expect(telemetry.appendFailures).toBe(2);
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
