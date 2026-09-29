/**
 * B3a live proof — pristine pi-ai, disposable server, incident-class fixture.
 *
 * Drives the compiled server built by pristine-harness.mts (pristine
 * @earendil-works/pi-ai in BOTH resolution copies) against a local SSE fixture
 * that reproduces the 2026-09-12 pattern: one tool call whose arguments stream
 * in fine 4-char deltas. Scenarios:
 *
 *   cap-on  — default budget (64 KB/call, 256 KB/run): the turn must abort at
 *             the cap, the receipt must carry RUN_BUDGET_EXCEEDED, and a second
 *             session must keep streaming throughout.
 *   cap-off — positive control (PI_TOOL_ARGS_MAX_CALL_CHARS=0 /
 *             PI_TOOL_ARGS_MAX_TURN_CHARS=0): the same fixture accumulates past
 *             the cap bound, demonstrating the stall class the cap removes.
 *
 * Event-loop lag is read from the server's A2 metrics file (the same
 * instrument as production) for each scenario window.
 *
 * Run under `systemd-run --scope --collect` so nothing shares the production
 * cgroup. Usage:
 *   systemd-run --scope --collect node server/tests/unit/pi-ai/tool-args-live-proof.mts \
 *     --scratch /tmp/b3a-live --scenario both
 * (run through tsx; see package tooling) — prints a JSON verdict and writes
 * <scratch>/verdict.json.
 */
import http from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const harness = path.join(here, 'pristine-harness.mts');

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function log(message) {
  process.stderr.write(`[live-proof] ${message}\n`);
}

function fail(message) {
  process.stderr.write(`[live-proof] FATAL: ${message}\n`);
  process.exit(1);
}

const scratch = arg('scratch');
const scenario = arg('scenario', 'both');
const controlMaxBytes = Number(arg('control-max-bytes', '98304'));
const fixturePort = Number(arg('fixture-port', '0'));
const paceDeltaMs = Number(arg('pace-delta-ms', '0'));
const capOnEnv = Object.fromEntries(
  (arg('cap-on-env', '') ?? '')
    .split(',')
    .filter(Boolean)
    .map((pair) => pair.split('='))
    .map(([key, ...rest]) => [key, rest.join('=')]),
);
const label = arg('label', scenario);
if (!scratch) fail('--scratch <root> is required');
if (!existsSync(path.join(scratch, 'state'))) fail(`scratch not built: ${scratch}`);

const stateDir = path.join(scratch, 'state');
const workspace = path.join(stateDir, 'workspace');
mkdirSync(path.join(stateDir, 'logs'), { recursive: true });

// ─── fixture provider (local SSE; runs in THIS process, never the server's) ──

const fixtureState = { requests: 0, log: [] };

function startFixture(port) {
  const server = http.createServer((req, res) => {
    res.on('error', () => { /* client aborted (the cap) — stop writing */ });
    req.on('error', () => { /* same */ });
    fixtureState.requests += 1;
    const started = Date.now();
    const record = { request: fixtureState.requests, started, bytes: 0, kind: 'unknown' };
    fixtureState.log.push(record);
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const chunk = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const chunkBody = { id: 'chatcmpl-b3a', object: 'chat.completion.chunk', created: 1_700_000_000, model: 'b3a-runaway' };

    if (fixtureState.requests === 1) {
      // The runaway: one bash tool call whose arguments accumulate in 4-char deltas.
      record.kind = 'runaway';
      chunk({ ...chunkBody, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'bash', arguments: '{"cmd":"' } }] }, finish_reason: null }] });
      let sent = 7; // '{"cmd":'
      let i = 0;
      const writeDeltas = () => {
        const writeOne = () => {
          if (res.destroyed) return; // the cap aborted the request — stop feeding
          chunk({ ...chunkBody, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'xxxx' } }] }, finish_reason: null }] });
          sent += 4;
          i += 1;
          if (sent < controlMaxBytes) {
            if (paceDeltaMs > 0) setTimeout(writeOne, paceDeltaMs);
            else if (res.writableNeedDrain) setImmediate(writeOne);
            else writeOne();
          } else {
            record.bytes = sent;
            chunk({ ...chunkBody, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
            res.write('data: [DONE]\n\n');
            record.finished = Date.now();
            res.end();
          }
        };
        writeOne();
      };
      writeDeltas();
      return;
    }

    // Every later request: instant, clean stop (session B; the control's post-tool turn).
    record.kind = 'instant-stop';
    chunk({ ...chunkBody, choices: [{ index: 0, delta: { role: 'assistant', content: 'done' }, finish_reason: null }] });
    chunk({ ...chunkBody, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    res.write('data: [DONE]\n\n');
    record.bytes = 4;
    record.finished = Date.now();
    res.end();
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

// ─── Internal API client over the unix socket ────────────────────────────────

function apiRequest(socketPath, token, method, apiPath, body) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    const chunks = [];
    socket.setTimeout(300_000);
    socket.on('connect', () => {
      const headers = [
        `${method} ${apiPath} HTTP/1.1`,
        'Host: localhost',
        `Authorization: Bearer ${token}`,
        'Connection: close',
      ];
      if (payload !== undefined) {
        headers.push('content-type: application/json', `content-length: ${Buffer.byteLength(payload)}`);
      }
      socket.write(`${headers.join('\r\n')}\r\n\r\n${payload ?? ''}`);
    });
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('timeout', () => { socket.destroy(); reject(new Error(`timeout on ${method} ${apiPath}`)); });
    socket.on('error', reject);
    socket.on('close', () => {
      const raw = Buffer.concat(chunks).toString();
      const split = raw.indexOf('\r\n\r\n');
      const head = raw.slice(0, split);
      let bodyText = raw.slice(split + 4);
      // Dechunk (Node answers chunked when the body has no content-length).
      if (/transfer-encoding:\s*chunked/i.test(head)) {
        const parts = [];
        let cursor = 0;
        for (;;) {
          const lineEnd = bodyText.indexOf('\r\n', cursor);
          if (lineEnd === -1) break;
          const size = parseInt(bodyText.slice(cursor, lineEnd), 16);
          if (!Number.isFinite(size) || size === 0) break;
          parts.push(bodyText.slice(lineEnd + 2, lineEnd + 2 + size));
          cursor = lineEnd + 2 + size + 2;
        }
        bodyText = parts.join('');
      }
      const status = Number(head.split(' ')[1]);
      let json;
      try { json = JSON.parse(bodyText); } catch { json = undefined; }
      resolve({ status, head, text: bodyText, json });
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function createSession(socketPath, token, label) {
  const created = await apiRequest(socketPath, token, 'POST', '/api/v1/sessions', {
    runtime: 'pi',
    cwd: workspace,
    model: 'b3a-fixture/b3a-runaway',
  });
  if (created.status !== 200 && created.status !== 201) {
    fail(`session ${label} create failed: ${created.status} ${created.text.slice(0, 300)}`);
  }
  const sessionId = created.json?.session?.id ?? created.json?.id ?? created.json?.sessionId;
  if (!sessionId) fail(`session ${label} create returned no id: ${created.text.slice(0, 300)}`);
  return sessionId;
}

async function promptAndWait(socketPath, token, sessionId, message) {
  const started = Date.now();
  const response = await apiRequest(socketPath, token, 'POST', `/api/v1/sessions/${sessionId}/prompt`, { message });
  return { response, wallMs: Date.now() - started };
}

async function getReceipt(socketPath, token, runId) {
  const response = await apiRequest(socketPath, token, 'GET', `/api/v1/runs/${runId}`);
  return response.json;
}

// ─── metrics window ──────────────────────────────────────────────────────────

function analyseMetrics(metricsDir, windowStart, windowEnd) {
  const file = path.join(metricsDir, 'health-metrics.jsonl');
  if (!existsSync(file)) return { available: false, reason: 'metrics file missing' };
  const lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  const samples = [];
  for (const line of lines) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    const ts = record.atMs ?? record.at ?? record.timestamp;
    const time = typeof ts === 'number' ? ts : Date.parse(ts ?? '');
    if (!Number.isFinite(time)) continue;
    if (time < windowStart || time > windowEnd) continue;
    samples.push(record);
  }
  const lagValues = samples
    .map((record) => record.lagP99Ms ?? record.lag_p99_ms ?? record.lagP99)
    .filter((value) => typeof value === 'number');
  const lagMaxValues = samples
    .map((record) => record.lagMaxMs ?? record.lag_max_ms ?? record.lagMax)
    .filter((value) => typeof value === 'number');
  if (samples.length === 0) return { available: false, reason: 'no samples in window', totalLines: lines.length };
  return {
    available: true,
    samples: samples.length,
    lagP99Max: lagValues.length ? Math.max(...lagValues) : null,
    lagMaxMax: lagMaxValues.length ? Math.max(...lagMaxValues) : null,
    p99Over300: lagValues.filter((value) => value >= 300).length,
    sampleKeys: Object.keys(samples[0]),
  };
}

// ─── scenarios ───────────────────────────────────────────────────────────────

async function runScenario(kind, socketPath, token) {
  fixtureState.requests = 0; // each scenario's first provider request is its runaway
  log(`scenario ${kind}: creating sessions …`);
  const sessionA = await createSession(socketPath, token, 'A');
  const windowStart = Date.now();

  // Fire A's runaway WITHOUT awaiting it.
  const aPromise = promptAndWait(socketPath, token, sessionA, 'stream the runaway fixture');

  await sleep(2_000); // let A get mid-stream
  const sessionB = await createSession(socketPath, token, 'B');
  const b = await promptAndWait(socketPath, token, sessionB, 'answer briefly');
  const bReceiptRunId = b.response.json?.runId;
  const bReceipt = bReceiptRunId ? await getReceipt(socketPath, token, bReceiptRunId) : undefined;

  const a = await aPromise;
  const windowEnd = Date.now();
  const aRunId = a.response.json?.runId;
  const aReceipt = aRunId ? await getReceipt(socketPath, token, aRunId) : undefined;

  const aErrorCode = a.response.json?.code ?? aReceipt?.errorCode;
  const result = {
    kind,
    a: {
      httpStatus: a.response.status,
      errorCode: aErrorCode,
      wallMs: a.wallMs,
      receiptStatus: aReceipt?.status,
      receiptErrorCode: aReceipt?.errorCode,
      runId: aRunId,
      servedModel: aReceipt?.servedModel ?? aReceipt?.model,
    },
    b: {
      httpStatus: b.response.status,
      wallMs: b.wallMs,
      receiptStatus: bReceipt?.status,
      servedModel: bReceipt?.servedModel ?? bReceipt?.model,
    },
    fixture: { requests: fixtureState.requests, log: fixtureState.log.slice() },
    metrics: analyseMetrics(path.join(stateDir, 'metrics'), windowStart, windowEnd),
  };
  fixtureState.log.length = 0;
  return result;
}

// ─── orchestration ───────────────────────────────────────────────────────────

async function tsx(args) {
  const { spawnSync } = await import('node:child_process');
  const run = spawnSync('npx', ['tsx', harness, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  return { status: run.status, stdout: run.stdout ?? '' };
}

async function main() {
  let port = fixturePort;
  if (!port) {
    port = await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const chosen = typeof address === 'object' && address ? address.port : 0;
        server.close(() => (chosen ? resolve(chosen) : reject(new Error('no port'))));
      });
      server.on('error', reject);
    });
  }
  log(`fixture provider on 127.0.0.1:${port}`);
  await startFixture(port);

  log('building scratch resolution root (idempotent) …');
  const build = await tsx(['build', scratch, '--fixture-port', String(port)]);
  if (build.status !== 0) fail(`harness build failed (exit ${build.status})`);

  const serveOnce = async (envOverrides) => {
    const args = ['serve', scratch, '--fixture-port', String(port)];
    for (const [key, value] of Object.entries(envOverrides)) args.push('--env', `${key}=${value}`);
    // serve stays in the foreground until ready and prints one JSON line.
    const { spawnSync } = await import('node:child_process');
    const run = spawnSync('npx', ['tsx', harness, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: 180_000 });
    if (run.status !== 0) fail(`harness serve failed (exit ${run.status})`);
    const line = (run.stdout ?? '').trim().split('\n').filter(Boolean).pop();
    return JSON.parse(line);
  };

  const stopServer = async () => {
    const { spawnSync } = await import('node:child_process');
    spawnSync('npx', ['tsx', harness, 'stop', scratch], { encoding: 'utf8', stdio: 'inherit' });
  };

  const verdict = { scenarios: {}, fixturePort: port, scratch, paceDeltaMs, controlMaxBytes };
  const tokenPath = path.join(stateDir, 'internal-api-token');

  try {
    if (scenario === 'both' || scenario === 'cap-on') {
      log(`── scenario cap-on ${Object.keys(capOnEnv).length ? `(${JSON.stringify(capOnEnv)})` : '(default budget)'} ──`);
      const server = await serveOnce(capOnEnv);
      const token = readFileSync(tokenPath, 'utf8').trim();
      verdict.scenarios[label] = await runScenario(label, server.socketPath, token);
      await stopServer();
    }

    if (scenario === 'both' || scenario === 'cap-off') {
      log('── scenario cap-off (positive control) ──');
      const server = await serveOnce({ PI_TOOL_ARGS_MAX_CALL_CHARS: '0', PI_TOOL_ARGS_MAX_TURN_CHARS: '0' });
      const token = readFileSync(tokenPath, 'utf8').trim();
      verdict.scenarios[scenario === 'cap-off' ? label : 'cap-off'] = await runScenario(
        scenario === 'cap-off' ? label : 'cap-off', server.socketPath, token,
      );
      await stopServer();
    }
  } finally {
    await stopServer(); // idempotent; no orphan may survive a FATAL
  }

  writeFileSync(path.join(scratch, 'verdict.json'), `${JSON.stringify(verdict, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
  process.exit(0);
}

main().catch((error) => fail(error instanceof Error ? error.stack ?? error.message : String(error)));
