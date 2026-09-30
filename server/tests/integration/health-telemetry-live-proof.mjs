#!/usr/bin/env node
/**
 * A2 telemetry — disposable-server live proof (Orchestration Scaling Readiness
 * Plan, step A2). This is a manual live-validation driver, NOT part of the
 * vitest suite: it needs a disposable validation server that the operator boots
 * under its own systemd scope (never inside the production cgroup) and a Node
 * inspector port on the same process.
 *
 * It proves, against a real server process:
 *   1. the metrics file grows at the configured cadence and rotates at its bound;
 *   2. lowered heap thresholds fire exactly ONE alert and then exactly ONE
 *      recovered message (hysteresis plus L1 incident grouping; no flapping),
 *      driven by a real heap rise and a real forced GC over the Chrome
 *      DevTools Protocol. Because grouping closes an incident only after the
 *      quiet period, the server must be started with a short
 *      `OBSERVABILITY_HEALTH_ALERT_QUIET_PERIOD_MS` (for example `5000`); the
 *      driver waits `--quiet-wait-seconds` (default 20) before judging;
 *   3. alerts are captured to a file inside the run directory, the startup log
 *      says the operator is not notified, and nothing reaches the operator path;
 *   4. `[MultiSessionManager] Memory:` journal lines per hour, measured over the
 *      same window and load as the pre-A2 baseline.
 *
 * Usage (server already running):
 *   node server/tests/integration/health-telemetry-live-proof.mjs \
 *     --dir <validation dir> --socket <dir>/internal-api.sock \
 *     --token <dir>/internal-api-token --inspect-port <port> --log <server log>
 *
 * Refusal mode (correction 02, finding 1): the server was started with a
 * forbidden metrics directory or alert sink; prove it refused and wrote nothing:
 *   node … --dir <dir> --log <log> --mode refusal --expect-refusal-text /root/.pi-web-ui/metrics
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { userInfo } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import WebSocket from 'ws';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}

// One ballast round appends 2M page-held objects by index assignment.
// Wrapped in an IIFE: a top-level `const base` would persist in the page's
// global lexical scope and the second evaluation would fail on redeclaration.
const A2_BALLAST_ROUND = '(function () { globalThis.__a2_ballast = globalThis.__a2_ballast || [];'
  + 'const base = globalThis.__a2_ballast.length;'
  + 'for (let i = 0; i < 2000000; i++) { globalThis.__a2_ballast[base + i] = { a: i, b: i * 2, c: "s" + i }; }'
  + 'return globalThis.__a2_ballast.length; })()';

const runDir = args.get('--dir');
const socketPath = args.get('--socket') ?? path.join(runDir, 'internal-api.sock');
const tokenPath = args.get('--token') ?? path.join(runDir, 'internal-api-token');
const inspectPort = Number(args.get('--inspect-port'));
const logPath = args.get('--log') ?? path.join(runDir, 'server.log');
const journalWindowSeconds = Number(args.get('--journal-window-seconds') ?? 360);
const mode = args.get('--mode') ?? 'proof';
const quietWaitSeconds = Number(args.get('--quiet-wait-seconds') ?? 20);
const productionMetricsDir = path.join(userInfo().homedir, '.pi-web-ui', 'metrics');
const productionNotificationsDir = path.join(userInfo().homedir, '.pi-web-ui', 'notifications');

if (mode === 'refusal') {
  const expectedRefusalText = args.get('--expect-refusal-text');
  if (!runDir || !expectedRefusalText) {
    console.error('refusal mode needs --dir and --expect-refusal-text');
    process.exit(64);
  }
  const startedAt = Date.now();
  const started = new Date(startedAt).toISOString();
  const report = { mode, startedAt: started, runDir, expectedRefusalText, checks: {}, numbers: {}, receipts: [] };
  const lines = readLines(logPath);
  const disabledLine = lines.find((line) => line.includes('[HealthTelemetry] disabled:'));
  const samplingLine = lines.find((line) => line.includes('[HealthTelemetry] metrics →'));
  const metricsFile = path.join(runDir, 'metrics', 'health-metrics.jsonl');
  const ingressDir = path.join(runDir, 'notifications', 'ingress');
  const ingressFiles = existsSync(ingressDir) ? readdirSync(ingressDir) : [];
  const productionNotificationWrites = existsSync(productionNotificationsDir)
    ? readdirSync(productionNotificationsDir, { recursive: true })
        .map((entry) => path.join(productionNotificationsDir, String(entry)))
        .filter((entry) => { try { return statSync(entry).mtimeMs >= startedAt; } catch { return false; } })
    : [];

  const checks = {
    'a refusal is logged and names the refused path': Boolean(disabledLine) && disabledLine.includes(expectedRefusalText),
    'telemetry never started sampling': !samplingLine,
    'no metrics file was created in the run directory': !existsSync(metricsFile),
    'the production metrics path was not created': !existsSync(productionMetricsDir),
    'no notification-ingress record was written': ingressFiles.length === 0,
    'no production notification file was touched during the run': productionNotificationWrites.length === 0,
  };
  for (const [name, ok] of Object.entries(checks)) report.checks[name] = { ok, detail: ok ? 'ok' : 'failed' };
  report.numbers = {
    refusedLine: disabledLine ?? null,
    samplingLine: samplingLine ?? null,
    productionMetricsDirExists: existsSync(productionMetricsDir),
    runMetricsFileExists: existsSync(metricsFile),
    ingressFiles,
    productionNotificationWrites,
  };
  report.finishedAt = new Date().toISOString();
  report.ok = Object.values(checks).every(Boolean);
  writeFileSync(path.join(runDir, 'refusal-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  console.log(`REFUSAL ${report.ok ? 'OK' : 'FAILED'} — report: ${path.join(runDir, 'refusal-report.json')}`);
  process.exit(report.ok ? 0 : 1);
}

if (!runDir || !Number.isInteger(inspectPort)) {
  console.error('usage: node health-telemetry-live-proof.mjs --dir <dir> --inspect-port <port> [--socket <path>] [--token <path>] [--log <path>] [--journal-window-seconds <n>]');
  process.exit(64);
}

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

const token = readFileSync(tokenPath, 'utf8').trim();
const metricsDir = path.join(runDir, 'metrics');
const metricsPath = path.join(metricsDir, 'health-metrics.jsonl');
const alertsPath = path.join(metricsDir, 'alerts.jsonl');

function readLines(file) {
  try {
    return readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '');
  } catch {
    return [];
  }
}

function api(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = httpRequest({
      socketPath,
      path: urlPath,
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (response) => {
      let raw = '';
      response.on('data', (chunk) => { raw += chunk; });
      response.on('end', () => {
        let parsed;
        try { parsed = raw ? JSON.parse(raw) : undefined; } catch { parsed = raw; }
        resolve({ status: response.statusCode, body: parsed });
      });
    });
    request.on('error', reject);
    request.setTimeout(15_000, () => request.destroy(new Error(`${method} ${urlPath} timed out`)));
    if (payload) request.write(payload);
    request.end();
  });
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
    // Surface a thrown expression instead of swallowing it: the old ballast's
    // `push(...2M)` exceeded the V8 argument limit and died silently here
    // (correction 01, finding 3 diagnosis; same defect class as the L1 driver).
    if (result.exceptionDetails) {
      const description = result.exceptionDetails.exception?.description
        ?? result.exceptionDetails.text
        ?? 'unknown evaluation exception';
      throw new Error(`Runtime.evaluate failed: ${description}`);
    }
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(description, predicate, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${description} after ${timeoutMs}ms`);
}

function parseAlerts() {
  return readLines(alertsPath).map((line) => JSON.parse(line));
}

/**
 * Distinct sample timestamps across every retained generation. Rotation moves
 * the current file into a generation, so "lines in one file" is not a cadence
 * measure; a timestamp set difference is.
 */
function sampleTimestamps() {
  const set = new Set();
  for (const name of readdirSync(metricsDir).filter((entry) => entry.startsWith('health-metrics'))) {
    for (const line of readLines(path.join(metricsDir, name))) {
      try { set.add(JSON.parse(line).atMs); } catch { /* ignore a torn line, if any */ }
    }
  }
  return set;
}

async function main() {
  const productionBefore = existsSync(productionMetricsDir);
  const productionEntriesBefore = existsSync(productionMetricsDir) ? readdirSync(productionMetricsDir) : [];
  if (!check('metrics file exists', existsSync(metricsPath), metricsPath)) return;

  // ── 1. startup line: sink target and operator suppression ─────────────────
  const startupLine = readLines(logPath).find((line) => line.includes('[HealthTelemetry] metrics →'));
  check(
    'startup log names the run-directory metrics file and the capture sink',
    Boolean(startupLine) && startupLine.includes(metricsPath) && startupLine.includes(`file:${alertsPath}`)
      && startupLine.includes('operator notifications suppressed'),
    startupLine ?? 'no [HealthTelemetry] startup line found',
  );

  // ── 2. cadence: the file grows at the configured interval ─────────────────
  const timestampsBefore = sampleTimestamps();
  await sleep(5_000);
  const timestampsAfter = sampleTimestamps();
  const grew = [...timestampsAfter].filter((at) => !timestampsBefore.has(at)).length;
  report.numbers.cadenceNewSamplesInFiveSeconds = grew;
  check('metrics file grows at the configured cadence (~1/s)', grew >= 3 && grew <= 7, `+${grew} new samples in 5 s (interval 1000 ms; counted across generations)`);

  const firstSample = JSON.parse(readLines(metricsPath)[0]);
  report.numbers.metricsFields = Object.keys(firstSample);
  report.numbers.heapLimitBytes = firstSample.heapLimitBytes;
  check(
    'sample carries every A2 field (heap, lim, rss, external, lag p50/p99/max, turns, sessions, registry)',
    ['heapUsedBytes', 'heapTotalBytes', 'heapLimitBytes', 'heapFraction', 'rssBytes', 'externalBytes', 'lagP50Ms', 'lagP99Ms', 'lagMaxMs', 'activeTurnsByClass', 'activeTurns', 'residentSessions', 'registryEntries']
      .every((field) => field in firstSample),
    Object.keys(firstSample).join(','),
  );

  // ── 3. rotation bound ────────────────────────────────────────────────────
  await waitFor('a rotated generation', () => existsSync(path.join(metricsDir, 'health-metrics.1.jsonl')), 60_000);
  await waitFor('a second rotated generation', () => existsSync(path.join(metricsDir, 'health-metrics.2.jsonl')), 60_000);
  await sleep(10_000);
  const generations = readdirSync(metricsDir).filter((name) => name.startsWith('health-metrics'));
  const sizes = generations.map((name) => ({ name, bytes: statSync(path.join(metricsDir, name)).size }));
  report.numbers.metricsGenerations = sizes;
  check(
    'rotation keeps at most maxFiles generations inside maxFileBytes',
    generations.length <= 3 && sizes.every((entry) => entry.bytes <= 4096),
    JSON.stringify(sizes),
  );

  // ── 4. the same load as the pre-A2 baseline: six resident Pi sessions ────
  const created = [];
  for (let index = 0; index < 6; index++) {
    const response = await api('POST', '/api/v1/sessions', { runtime: 'pi', cwd: path.join(runDir, 'workspace') });
    if (response.status !== 201) throw new Error(`session create returned ${response.status}: ${JSON.stringify(response.body)}`);
    created.push(response.body.sessionId);
  }
  const listed = await api('GET', '/api/v1/sessions?runtime=pi');
  report.numbers.piSessionsResident = Array.isArray(listed.body?.sessions) ? listed.body.sessions.length : undefined;
  check('six resident Pi sessions created', created.length === 6, `${created.length} created, registry lists ${report.numbers.piSessionsResident}`);

  // ── 5. alert on a real heap rise, then exactly one grouped recovered
  //       message after GC plus the server's quiet period (L1 grouping) ──────
  // Only records written from here on are judged, so the proof is re-runnable
  // against a metrics directory that already holds earlier runs.
  const alertRecordsAtStart = parseAlerts().length;
  const newAlerts = () => parseAlerts().slice(alertRecordsAtStart);
  const cdp = await Cdp.connect(inspectPort);
  const steady = await cdp.heapFraction();
  report.numbers.heapFractionSteady = Number(steady.fraction.toFixed(4));

  // Grow the held ballast until the post-GC RETAINED floor clears the alert
  // threshold by a margin, rather than relying on allocation transients
  // (correction 01, finding 3). The threshold must match the server's
  // OBSERVABILITY_HEALTH_ALERT_HEAP_FRACTION; the default is 0.10.
  const heapAlertFraction = Number(args.get('--heap-alert-fraction') ?? 0.1);
  let ballastRounds = 0;
  let retainedFraction = steady.fraction;
  while (retainedFraction < heapAlertFraction + 0.02 && ballastRounds < 10) {
    await cdp.evaluate(A2_BALLAST_ROUND);
    await cdp.collectGarbage();
    retainedFraction = (await cdp.heapFraction()).fraction;
    ballastRounds += 1;
  }
  report.numbers.ballast = { rounds: ballastRounds, retainedFraction: Number(retainedFraction.toFixed(4)) };
  check(
    'the held ballast keeps the retained heap above the alert threshold with margin',
    retainedFraction >= heapAlertFraction + 0.02,
    `${(retainedFraction * 100).toFixed(2)}% retained after ${ballastRounds} round(s) vs threshold ${(heapAlertFraction * 100).toFixed(1)}%`,
  );
  const loaded = await cdp.heapFraction();
  report.numbers.heapFractionAfterBallast = Number(loaded.fraction.toFixed(4));

  await waitFor('the heap alert', () => newAlerts().some((alert) => alert.kind === 'heap_pressure' && alert.transition === 'alert'), 30_000);
  const afterAlert = newAlerts();
  check('exactly one heap alert fired', afterAlert.filter((alert) => alert.transition === 'alert').length === 1, JSON.stringify(afterAlert));

  const alertLine = readLines(logPath).find((line) => line.includes('[HealthTelemetry] heap_pressure alert'));
  check('alert is also journaled with its numbers', Boolean(alertLine), alertLine ?? 'no alert log line');
  const groupedAlertLine = readLines(logPath).find((line) => line.includes('[HealthTelemetry] heap_pressure alert: heap pressure incident:'));
  check('the grouped incident message is journaled', Boolean(groupedAlertLine), groupedAlertLine ?? 'no grouped incident log line');

  await cdp.evaluate('globalThis.__a2_ballast = null; "released"');
  await cdp.collectGarbage();
  await sleep(1_000);
  await cdp.collectGarbage();
  const recovered = await cdp.heapFraction();
  report.numbers.heapFractionAfterGc = Number(recovered.fraction.toFixed(4));

  await waitFor(
    'the grouped heap recovered message (after the server quiet period)',
    () => newAlerts().some((alert) => alert.transition === 'recovery'),
    quietWaitSeconds * 1_000 + 20_000,
  );
  await sleep(15_000);
  const finalAlerts = newAlerts();
  const alerts = finalAlerts.filter((alert) => alert.transition === 'alert').length;
  const recoveries = finalAlerts.filter((alert) => alert.transition === 'recovery').length;
  report.numbers.alertRecords = finalAlerts;
  check('no flapping: exactly one alert and one recovered message after the settle', alerts === 1 && recoveries === 1, `alerts=${alerts} recoveries=${recoveries}`);
  const recoveredRecord = finalAlerts.find((alert) => alert.transition === 'recovery');
  check(
    'the recovered message carries the incident summary',
    Boolean(recoveredRecord?.incident) && recoveredRecord.incident.alertCrossings >= 1 && typeof recoveredRecord.incident.peakValue === 'number',
    JSON.stringify(recoveredRecord?.incident ?? null),
  );

  const recoveryLine = readLines(logPath).find((line) => line.includes('[HealthTelemetry] heap_pressure recovery'));
  check('recovery is also journaled', Boolean(recoveryLine), recoveryLine ?? 'no recovery log line');

  // ── 6. the operator path got nothing; production metrics untouched ───────
  const ingressDir = path.join(runDir, 'notifications', 'ingress');
  const ingressFiles = existsSync(ingressDir) ? readdirSync(ingressDir) : [];
  check('no notification-ingress record written (operator not messaged)', ingressFiles.length === 0, `${ingressDir}: ${ingressFiles.length} file(s)`);
  // The real production server legitimately keeps writing its own rotating
  // health-metrics file, so the isolation claim is narrower: this disposable
  // server created no NON-rotation entry there (its `alerts.jsonl` capture file
  // would appear), and its startup line names the run-directory metrics path.
  const productionEntriesAfter = existsSync(productionMetricsDir) ? readdirSync(productionMetricsDir) : [];
  const newProductionEntries = productionEntriesAfter.filter(
    (entry) => !productionEntriesBefore.includes(entry) && !/^health-metrics(\.\d+)?\.jsonl$/.test(entry),
  );
  report.numbers.newProductionMetricsEntries = newProductionEntries;
  check(
    'the disposable server created no production metrics entry',
    newProductionEntries.length === 0 && startupLine.includes(metricsPath),
    `new entries=${JSON.stringify(newProductionEntries)} (existed before=${productionBefore}); startup=${startupLine}`,
  );

  // ── 7. journal volume under the same load ────────────────────────────────
  // Two windows: A contains the causal transitions of this run's load (boot,
  // session regime), B is pure steady state. The pre-A2 baseline window was
  // pure steady state too, so B is the comparable number.
  const memoryLines = () => readLines(logPath).filter((line) => line.includes('[MultiSessionManager] Memory:'));
  report.numbers.memoryLinesBeforeWindow = memoryLines().length;
  report.numbers.memoryLinesBeforeWindowSample = memoryLines().slice(-3);
  receipt(`journal windows: ${journalWindowSeconds}s each with ${created.length} resident Pi sessions`);

  async function journalWindow(label, seconds) {
    const before = memoryLines().length;
    const started = Date.now();
    await sleep(seconds * 1_000);
    const after = memoryLines().length;
    const elapsed = (Date.now() - started) / 1_000;
    const lines = after - before;
    const perHour = Math.round((lines / elapsed) * 3600 * 100) / 100;
    receipt(`journal window ${label}: ${lines} line(s) in ${Math.round(elapsed)} s → ${perHour} lines/hour`);
    return { lines, perHour, seconds: Math.round(elapsed), sample: memoryLines().slice(-lines) };
  }

  const windowA = await journalWindow('A (load transitions)', journalWindowSeconds);
  const windowB = await journalWindow('B (steady state)', journalWindowSeconds);
  report.numbers.journalWindowA = windowA;
  report.numbers.journalWindowB = windowB;
  report.numbers.journalLinesPerHourWindowA = windowA.perHour;
  report.numbers.journalLinesPerHourWindowB = windowB.perHour;
  report.numbers.journalLinesTotal = memoryLines().length;
  check(
    'window A: only the load-transition lines, not periodic samples',
    windowA.lines <= 2,
    `${windowA.lines} causal transition line(s) in ${windowA.seconds} s; window B owns the steady-state rate`,
  );
  check(
    'window B: steady state is silent (heartbeat is 2/hour by configuration)',
    windowB.perHour <= 10,
    `${windowB.lines} line(s) in ${windowB.seconds} s → ${windowB.perHour} lines/hour (pre-A2 gate: 120)`,
  );
  // The policy is not silently dead: it must have journaled this run's real
  // transitions (boot at sessions=0, then the session regime at sessions=6).
  const journaled = memoryLines();
  report.numbers.memoryLinesTotal = journaled.length;
  report.numbers.memoryLines = journaled;
  check(
    'the policy journaled the causal transitions (boot and session regime)',
    journaled.length >= 2 && journaled.some((line) => line.includes('sessions=6')) && journaled.some((line) => line.includes('sessions=0')),
    `${journaled.length} Memory: line(s) total: ${journaled.join(' | ')}`,
  );

  cdp.close();
}

main()
  .then(() => {
    report.finishedAt = new Date().toISOString();
    report.ok = Object.values(report.checks).every((entry) => entry.ok);
    writeFileSync(path.join(runDir, 'proof-report.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`PROOF ${report.ok ? 'OK' : 'FAILED'} — report: ${path.join(runDir, 'proof-report.json')}`);
    process.exit(report.ok ? 0 : 1);
  })
  .catch((error) => {
    report.finishedAt = new Date().toISOString();
    report.ok = false;
    report.failure = error instanceof Error ? (error.stack ?? error.message) : String(error);
    try {
      mkdirSync(runDir, { recursive: true });
      appendFileSync(path.join(runDir, 'proof-report.json'), `${JSON.stringify(report, null, 2)}\n`);
    } catch { /* best effort */ }
    console.error(`PROOF FAILED: ${report.failure}`);
    process.exit(1);
  });
