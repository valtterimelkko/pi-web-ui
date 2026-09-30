#!/usr/bin/env node
/**
 * L1 — incident-grouped health alerts and CPU telemetry: disposable-server live
 * proof (Orchestration Scaling Readiness Plan, wave-3 lane L1). This is a manual
 * live-validation driver, NOT part of the vitest suite: it needs a disposable
 * validation server under its own systemd scope with the L1 pacing env and a
 * Node inspector port on the same process.
 *
 * It proves, against a real server process and a real heap:
 *   1. every sample carries the CPU fields (process percentage of one core and
 *      the main-thread figure from /proc, source `proc-thread-self` on Linux);
 *   2. several real heap crossings inside one un-recovered window produce exactly
 *      ONE alert message and ONE recovered message, and the recovered message
 *      carries the folded crossing count, the peak, the start/end and duration;
 *   3. every raw transition is still journaled beside the grouped notifications;
 *   4. a new incident inside the cooldown is silent, and its recovered message
 *      says it reopened during the cooldown;
 *   5. nothing reaches the operator ingress path and the production metrics
 *      directory is untouched.
 *
 * The server must be started with (see /root/l1-validation/run3/launch.sh):
 *   OBSERVABILITY_METRICS_INTERVAL_MS=1000
 *   OBSERVABILITY_HEALTH_ALERT_HEAP_FRACTION=0.10
 *   OBSERVABILITY_HEALTH_ALERT_HEAP_RECOVER_FRACTION=0.06
 *   OBSERVABILITY_HEALTH_ALERT_QUIET_PERIOD_MS=20000
 *   OBSERVABILITY_HEALTH_ALERT_COOLDOWN_MS=60000
 *   OBSERVABILITY_HEALTH_ALERT_DEBOUNCE_READINGS=2
 *
 * Usage (server already running):
 *   node server/tests/integration/health-incident-live-proof.mjs \
 *     --dir <validation dir> --socket <dir>/internal-api.sock \
 *     --token <dir>/internal-api-token --inspect-port <port> --log <server log>
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { userInfo } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import WebSocket from 'ws';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}

const runDir = args.get('--dir');
const socketPath = args.get('--socket') ?? path.join(runDir, 'internal-api.sock');
const tokenPath = args.get('--token') ?? path.join(runDir, 'internal-api-token');
const inspectPort = Number(args.get('--inspect-port'));
const logPath = args.get('--log') ?? path.join(runDir, 'server.log');
const productionMetricsDir = path.join(userInfo().homedir, '.pi-web-ui', 'metrics');
const productionMetricsEntriesBefore = existsSync(productionMetricsDir) ? readdirSync(productionMetricsDir) : [];
const productionNotificationsDir = path.join(userInfo().homedir, '.pi-web-ui', 'notifications');

if (!runDir || !Number.isInteger(inspectPort)) {
  console.error('usage: node health-incident-live-proof.mjs --dir <dir> --inspect-port <port> [--socket <path>] [--token <path>] [--log <path>]');
  process.exit(64);
}

const metricsDir = path.join(runDir, 'metrics');
const metricsPath = path.join(metricsDir, 'health-metrics.jsonl');
const alertsPath = path.join(metricsDir, 'alerts.jsonl');

const report = {
  startedAt: new Date().toISOString(),
  runDir,
  inspectPort,
  checks: {},
  numbers: {},
  receipts: [],
};
const receipts = [];
function receipt(line) {
  const stamped = `${new Date().toISOString()} ${line}`;
  receipts.push(stamped);
  report.receipts = receipts;
  console.log(stamped);
}
function check(name, ok, detail) {
  report.checks[name] = { ok: Boolean(ok), detail };
  receipt(`${ok ? 'PASS' : 'FAIL'} ${name}: ${detail}`);
  return Boolean(ok);
}

function readLines(file) {
  try {
    return readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '');
  } catch {
    return [];
  }
}
function parseAlerts() {
  return readLines(alertsPath).map((line) => JSON.parse(line));
}
function parseSamples() {
  return readLines(metricsPath).map((line) => JSON.parse(line));
}
/** Raw evaluator transitions are journaled beside the grouped notifications. */
function rawAlertLines() {
  return readLines(logPath).filter(
    (line) => line.includes('[HealthTelemetry] heap_pressure alert:') && !line.includes('heap pressure incident:'),
  );
}
function groupedRecoveryLines() {
  return readLines(logPath).filter((line) => line.includes('[HealthTelemetry] heap_pressure recovery: heap pressure incident recovered:'));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(description, predicate, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${description} after ${timeoutMs}ms`);
}

class Cdp {
  constructor(webSocketUrl) {
    this.ws = new WebSocket(webSocketUrl);
    this.nextId = 0;
    this.pending = new Map();
    this.ws.on('message', (data) => {
      const message = JSON.parse(data.toString());
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result);
    });
  }

  static async connect(port) {
    const targets = await new Promise((resolve, reject) => {
      const request = httpRequest({ host: '127.0.0.1', port, path: '/json/list' }, (response) => {
        let raw = '';
        response.on('data', (chunk) => { raw += chunk; });
        response.on('end', () => resolve(JSON.parse(raw)));
      });
      request.on('error', reject);
      request.end();
    });
    if (!targets.length) throw new Error(`no inspector target on 127.0.0.1:${port}`);
    const client = new Cdp(targets[0].webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      client.ws.once('open', resolve);
      client.ws.once('error', reject);
    });
    await client.send('Runtime.enable');
    await client.send('HeapProfiler.enable');
    return client;
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return result.result?.value;
  }

  async heapFraction() {
    const raw = await this.evaluate('JSON.stringify({ used: process.memoryUsage().heapUsed, limit: process.getBuiltinModule("v8").getHeapStatistics().heap_size_limit })');
    const { used, limit } = JSON.parse(raw);
    return { used, limit, fraction: used / limit };
  }

  async collectGarbage() {
    await this.send('HeapProfiler.collectGarbage');
  }

  close() {
    this.ws.close();
  }
}

const BALLAST = 'globalThis.__l1_ballast = Array.from({ length: 2000000 }, (_, i) => ({ a: i, b: i * 2, c: "s" + i }));'
  + 'globalThis.__l1_ballast.push(...Array.from({ length: 2000000 }, (_, i) => ({ a: i, b: i * 2, c: "s" + i })));'
  + 'globalThis.__l1_ballast.length';

async function holdBallast(cdp) {
  await cdp.evaluate(BALLAST);
}

async function releaseBallast(cdp) {
  await cdp.evaluate('globalThis.__l1_ballast = null; "released"');
  await cdp.collectGarbage();
  await sleep(500);
  await cdp.collectGarbage();
}

async function main() {
  const productionBefore = existsSync(productionMetricsDir);

  // ── 0. the disposable server is up ───────────────────────────────────────
  await waitFor('the validation token file', () => existsSync(tokenPath), 60_000);
  await waitFor('the validation socket', () => existsSync(socketPath), 60_000);
  await waitFor('the metrics file', () => existsSync(metricsPath), 30_000);
  receipt(`disposable server ready: ${runDir}`);

  // ── 1. every sample carries the CPU fields ───────────────────────────────
  await waitFor('three metric samples', () => parseSamples().length >= 3, 30_000);
  const samples = parseSamples();
  const first = samples[0];
  const last = samples[samples.length - 1];
  report.numbers.cpuFirst = {
    cpuPercentOfCore: first.cpuPercentOfCore,
    mainThreadCpuPercentOfCore: first.mainThreadCpuPercentOfCore,
    mainThreadCpuSource: first.mainThreadCpuSource,
  };
  report.numbers.cpuLast = {
    cpuPercentOfCore: last.cpuPercentOfCore,
    mainThreadCpuPercentOfCore: last.mainThreadCpuPercentOfCore,
    mainThreadCpuSource: last.mainThreadCpuSource,
  };
  check('the first sample reports no interval (CPU null, not a fake zero)', first.cpuPercentOfCore === null && first.mainThreadCpuPercentOfCore === null, JSON.stringify(report.numbers.cpuFirst));
  check(
    'later samples carry a real process CPU percentage of one core',
    samples.slice(1).every((sample) => typeof sample.cpuPercentOfCore === 'number' && Number.isFinite(sample.cpuPercentOfCore) && sample.cpuPercentOfCore >= 0),
    `last=${last.cpuPercentOfCore}`,
  );
  check(
    'the main-thread figure comes from /proc on Linux and is a finite percentage',
    last.mainThreadCpuSource === 'proc-thread-self' && typeof last.mainThreadCpuPercentOfCore === 'number' && Number.isFinite(last.mainThreadCpuPercentOfCore) && last.mainThreadCpuPercentOfCore >= 0,
    `source=${last.mainThreadCpuSource} last=${last.mainThreadCpuPercentOfCore}`,
  );

  const cdp = await Cdp.connect(inspectPort);
  const steady = await cdp.heapFraction();
  report.numbers.heapFractionSteady = Number(steady.fraction.toFixed(4));
  const alertsAtStart = parseAlerts().length;
  const rawAtStart = rawAlertLines().length;

  // ── 2. three real crossings, one incident: one alert + one recovered ─────
  await holdBallast(cdp);
  await waitFor(
    'the grouped alert record',
    () => parseAlerts().slice(alertsAtStart).some((alert) => alert.kind === 'heap_pressure' && alert.transition === 'alert' && alert.incident),
    60_000,
  );
  const peakHigh = await cdp.heapFraction();
  report.numbers.heapFractionPeak = Number(peakHigh.fraction.toFixed(4));
  const afterAlert = parseAlerts().slice(alertsAtStart);
  check('exactly one grouped alert message opens the incident', afterAlert.filter((alert) => alert.transition === 'alert').length === 1, JSON.stringify(afterAlert.filter((entry) => entry.transition === 'alert')));

  for (const crossing of [2, 3]) {
    await releaseBallast(cdp);
    await sleep(3_500); // at least three 1 s samples below the recovery threshold
    await holdBallast(cdp);
    await waitFor(
      `raw crossing ${crossing}`,
      () => rawAlertLines().length >= rawAtStart + crossing,
      45_000,
    );
  }

  await releaseBallast(cdp);
  await waitFor('the grouped recovered record', () => parseAlerts().slice(alertsAtStart).some((alert) => alert.kind === 'heap_pressure' && alert.transition === 'recovery'), 45_000);
  await sleep(2_000); // let anything else that was going to fire fire
  const incidentA = parseAlerts().slice(alertsAtStart);
  const alertsA = incidentA.filter((alert) => alert.transition === 'alert');
  const recoveriesA = incidentA.filter((alert) => alert.transition === 'recovery');
  const rawAlertsA = rawAlertLines().length - rawAtStart;
  const recoveredA = recoveriesA[0];
  report.numbers.incidentA = {
    rawAlertCrossings: rawAlertsA,
    alertRecords: alertsA.length,
    recoveredRecords: recoveriesA.length,
    summary: recoveredA?.incident ?? null,
    message: recoveredA?.message ?? null,
  };
  check('three-plus real crossings produced exactly one alert record', alertsA.length === 1 && rawAlertsA >= 3, `raw crossings=${rawAlertsA} alert records=${alertsA.length}`);
  check('they produced exactly one recovered record', recoveriesA.length === 1, `recovered records=${recoveriesA.length}`);
  check(
    'the recovered record folds every raw crossing',
    recoveredA?.incident?.alertCrossings === rawAlertsA,
    `alertCrossings=${recoveredA?.incident?.alertCrossings} raw=${rawAlertsA}`,
  );
  check(
    'the recovered record carries start, end, duration and a peak above the steady heap',
    typeof recoveredA?.incident?.startedAt === 'string'
      && typeof recoveredA?.incident?.endedAt === 'string'
      && typeof recoveredA?.incident?.durationMs === 'number' && recoveredA.incident.durationMs > 0
      && typeof recoveredA.incident.peakValue === 'number'
      && recoveredA.incident.peakValue > report.numbers.heapFractionSteady,
    JSON.stringify(recoveredA?.incident ?? null),
  );
  check(
    'the recovered message is self-contained and human-readable',
    typeof recoveredA?.message === 'string'
      && recoveredA.message.includes('incident recovered')
      && /alert crossings? folded/.test(recoveredA.message)
      && recoveredA.message.includes(recoveredA.incident.endedAt),
    recoveredA?.message ?? 'no recovered message',
  );
  report.numbers.rawAlertLines = rawAlertLines().slice(-8);
  check(
    'every raw transition is still journaled beside the grouped notifications',
    rawAlertsA >= 3 && groupedRecoveryLines().length >= 1,
    `${rawAlertsA} raw alert line(s); ${groupedRecoveryLines().length} grouped recovered line(s)`,
  );

  // ── 3. a new incident inside the cooldown is silent, and says so ─────────
  const alertsBeforeB = parseAlerts().length;
  const rawBeforeB = rawAlertLines().length;
  await holdBallast(cdp);
  await waitFor('the silent reopen raw crossing', () => rawAlertLines().length > rawBeforeB, 45_000);
  await sleep(4_000); // several high samples while the incident is silently open
  const duringB = parseAlerts().slice(alertsBeforeB);
  check('no alert message is sent inside the cooldown', duringB.filter((alert) => alert.transition === 'alert').length === 0, `alert records during cooldown=${duringB.filter((alert) => alert.transition === 'alert').length}`);
  await releaseBallast(cdp);
  await waitFor('the silent incident recovered', () => parseAlerts().slice(alertsBeforeB).some((alert) => alert.transition === 'recovery'), 45_000);
  const incidentB = parseAlerts().slice(alertsBeforeB);
  const recoveredB = incidentB.find((alert) => alert.transition === 'recovery');
  report.numbers.incidentB = {
    alertRecords: incidentB.filter((alert) => alert.transition === 'alert').length,
    recoveredRecords: incidentB.filter((alert) => alert.transition === 'recovery').length,
    summary: recoveredB?.incident ?? null,
    message: recoveredB?.message ?? null,
  };
  check('exactly one recovered record for the silent reopen', incidentB.filter((alert) => alert.transition === 'recovery').length === 1, `recovered=${incidentB.filter((alert) => alert.transition === 'recovery').length}`);
  check(
    'the silent reopen is reported on the recovered message',
    recoveredB?.incident?.reopenedDuringCooldown === true && recoveredB.message.includes('during the cooldown'),
    recoveredB?.message ?? 'no recovered message',
  );

  // ── 4. operator path untouched; production untouched ─────────────────────
  const ingressDir = path.join(runDir, 'notifications', 'ingress');
  const ingressFiles = existsSync(ingressDir) ? readdirSync(ingressDir) : [];
  const productionNotificationWrites = existsSync(productionNotificationsDir)
    ? readdirSync(productionNotificationsDir, { recursive: true })
        .map((entry) => path.join(productionNotificationsDir, String(entry)))
        .filter((entry) => { try { return statSync(entry).mtimeMs >= Date.parse(report.startedAt); } catch { return false; } })
    : [];
  // The real production server legitimately keeps writing its own metrics file,
  // so the isolation claim is: this disposable server created NO new entry in
  // the production metrics directory (its own sink/métrics names would appear
  // there) and wrote its metrics/capture inside the run directory instead.
  const productionMetricsEntriesAfter = existsSync(productionMetricsDir) ? readdirSync(productionMetricsDir) : [];
  const newProductionEntries = productionMetricsEntriesAfter.filter((entry) => !productionMetricsEntriesBefore.includes(entry));
  report.numbers.productionMetricsEntriesBefore = productionMetricsEntriesBefore;
  report.numbers.newProductionEntries = newProductionEntries;
  const startupLine = readLines(logPath).find((line) => line.includes('[HealthTelemetry] metrics →'));
  check('no notification-ingress record was written (operator not messaged)', ingressFiles.length === 0, `${ingressFiles.length} file(s) in ${ingressDir}`);
  check('no production notification file was touched during the run', productionNotificationWrites.length === 0, `${productionNotificationWrites.length} recent file(s)`);
  check(
    'the disposable server wrote inside the run directory and created no production metrics entry',
    Boolean(startupLine) && startupLine.includes(metricsPath) && newProductionEntries.length === 0,
    `startup=${startupLine ?? 'missing'}; new production entries=${JSON.stringify(newProductionEntries)}`,
  );
  report.numbers.productionMetricsDirExistedBefore = productionBefore;

  cdp.close();
}

main()
  .then(() => {
    report.finishedAt = new Date().toISOString();
    report.ok = Object.values(report.checks).every((entry) => entry.ok);
    writeFileSync(path.join(runDir, 'incident-proof-report.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`PROOF ${report.ok ? 'OK' : 'FAILED'} — report: ${path.join(runDir, 'incident-proof-report.json')}`);
    process.exit(report.ok ? 0 : 1);
  })
  .catch((error) => {
    report.finishedAt = new Date().toISOString();
    report.ok = false;
    report.failure = error instanceof Error ? (error.stack ?? error.message) : String(error);
    try {
      writeFileSync(path.join(runDir, 'incident-proof-report.json'), `${JSON.stringify(report, null, 2)}\n`);
    } catch { /* best effort */ }
    console.error(`PROOF FAILED: ${report.failure}`);
    process.exit(1);
  });
