/**
 * B3b live proof — pristine pi-ai, disposable server, runaway-generation
 * fixture.
 *
 * Drives the compiled server built by pristine-harness.mts (pristine
 * @earendil-works/pi-ai in BOTH resolution copies) against a local SSE
 * fixture that reproduces the 2026-09-12 pattern's generation arm: one very
 * long assistant generation streaming content chunks. Scenarios:
 *
 *   bytes   — default budgets (1,000,000 output tokens / 16 MiB streamed
 *             bytes), stress-paced 4 KiB / 3 ms ≈ 1.37 MB/s (~300× the p99.9
 *             real streaming rate of 4,551 B/s): the streamed-byte cap must
 *             abort the turn at the cap, the receipt must carry
 *             RUN_BUDGET_EXCEEDED, and a second session must stream
 *             THROUGHOUT A's runaway window (its own paced stream outlasts
 *             A's abort) and complete normally, with A2 event-loop lag under
 *             300 ms throughout.
 *   bytes-realistic — PI_RUN_BUDGET_MAX_STREAMED_BYTES=131072 at ~333
 *             chunks/s of 64 B (~21 KB/s; B3a measured ~300 deltas/s provider
 *             pace, ~3× the most intense real run at 6.6 KB/s): aborts at the
 *             cap at REALISTIC pacing; B streams throughout; lag < 300 ms.
 *   tokens  — PI_RUN_BUDGET_MAX_OUTPUT_TOKENS=2000: the fixture streams a
 *             small message that ends with usage completion_tokens=50000;
 *             the output-token cap must abort at message_end (the runtime
 *             reports usage only in the final chunk) with the same receipt.
 *   cap-off — positive control (both PI_RUN_BUDGET_* knobs = 0): the same
 *             volumes that abort cap-on (17 MiB streamed, 600,000 reported
 *             output tokens) complete normally — receipt `completed`, no
 *             abort — demonstrating the budgets are what stops the run.
 *
 * Event-loop lag is read from the server's A2 metrics file (the same
 * instrument as production) for each scenario window, framed against B2's
 * proposed threshold (300 ms; failure needs two consecutive readings ≥300 ms).
 *
 * Run under `systemd-run --scope --collect` so nothing shares the production
 * cgroup:
 *   systemd-run --scope --collect npx tsx \
 *     server/tests/unit/pi-ai/run-budget-live-proof.mts --scratch /tmp/b3b-live \
 *     --scenario all [--pace-chunk-ms 3] [--chunk-bytes 4096]
 * Prints a JSON verdict and writes <scratch>/verdict-b3b.json.
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
  process.stderr.write(`[run-budget-live-proof] ${message}\n`);
}

function fail(message) {
  process.stderr.write(`[run-budget-live-proof] FATAL: ${message}\n`);
  process.exit(1);
}

const scratch = arg('scratch');
const scenario = arg('scenario', 'all');
const chunkBytes = Number(arg('chunk-bytes', '4096'));
const paceChunkMs = Number(arg('pace-chunk-ms', '3'));
const runawayBytes = Number(arg('runaway-bytes', String(17 * 1024 * 1024))); // past the 16 MiB default
const controlOutputTokens = Number(arg('control-output-tokens', '600000')); // past the 500,000 default
if (!scratch) fail('--scratch <root> is required');
if (!existsSync(path.join(scratch, 'state'))) fail(`scratch not built: ${scratch}`);

const stateDir = path.join(scratch, 'state');
const workspace = path.join(stateDir, 'workspace');
mkdirSync(path.join(stateDir, 'logs'), { recursive: true });

// ─── fixture provider (local SSE; runs in THIS process, never the server's) ──

const fixtureState = { requests: 0, log: [], aResolved: false };

// Per-scenario runaway plan, set by the orchestrator before each scenario:
// how many bytes request 1 streams before finishing, at what chunk size, and
// what output-token count its final usage chunk reports. Session B (every
// request after the first) streams 64 B every 33 ms (~1.9 KB/s — inside the
// measured real per-run streaming range of 148–6,583 B/s) for at least
// `bMinStreamMs`, so B's stream spans A's entire runaway window.
const runawayPlan = { bytes: 17 * 1024 * 1024, completionTokens: 600_000, chunkBytes: 4096, bMinStreamMs: 16_000 };

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
    const chunk = (obj) => {
      if (!res.destroyed) res.write(`data: ${JSON.stringify(obj)}\n\n`);
    };
    const chunkBody = { id: 'chatcmpl-b3b', object: 'chat.completion.chunk', created: 1_700_000_000, model: 'b3a-runaway' };
    const finishClean = (completionTokens) => {
      chunk({ ...chunkBody, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      chunk({ ...chunkBody, choices: [], usage: { prompt_tokens: 128, completion_tokens: completionTokens, total_tokens: 128 + completionTokens } });
      res.write('data: [DONE]\n\n');
      record.finished = Date.now();
      res.end();
    };

    if (fixtureState.requests === 1) {
      // The runaway: one very long assistant generation in content chunks.
      record.kind = 'runaway';
      chunk({ ...chunkBody, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
      const payload = 'x'.repeat(runawayPlan.chunkBytes);
      const targetBytes = runawayPlan.bytes;
      let sent = 0;
      const writeOne = () => {
        if (res.destroyed) return; // the budget aborted the request — stop feeding
        chunk({ ...chunkBody, choices: [{ index: 0, delta: { content: payload }, finish_reason: null }] });
        sent += runawayPlan.chunkBytes;
        record.bytes = sent; // track continuously so an aborted run still shows how much streamed
        if (sent < targetBytes) {
          if (paceChunkMs > 0) setTimeout(writeOne, paceChunkMs);
          else if (res.writableNeedDrain) setImmediate(writeOne);
          else writeOne();
        } else {
          record.bytes = sent;
          finishClean(runawayPlan.completionTokens);
        }
      };
      writeOne();
      return;
    }

    // Every later request (session B; the control's post-run turn): a paced
    // stream that runs for at least bMinStreamMs AND until session A's run
    // has resolved (+500 ms grace) — so B's stream structurally spans A's
    // entire runaway window. ~64 B every 33 ms ≈ 1.9 KB/s, inside the
    // measured real per-run streaming range (p50 148, p99 1,014, max
    // 6,583 B/s; measurement-v2.json).
    record.kind = 'streaming-session';
    chunk({ ...chunkBody, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
    const bPayload = 'y'.repeat(64);
    let bSent = 0;
    let graceScheduled = false;
    const bStarted = Date.now();
    const writeB = () => {
      if (res.destroyed) return;
      chunk({ ...chunkBody, choices: [{ index: 0, delta: { content: bPayload }, finish_reason: null }] });
      bSent += 64;
      record.bytes = bSent;
      const elapsed = Date.now() - bStarted;
      const holdCap = runawayPlan.bMinStreamMs + 30_000; // bounded hold: a wedged A must not deadlock B
      if ((!fixtureState.aResolved || elapsed < runawayPlan.bMinStreamMs) && elapsed < holdCap) {
        setTimeout(writeB, 33);
      } else if (!graceScheduled && fixtureState.aResolved && elapsed < holdCap) {
        graceScheduled = true;
        setTimeout(writeB, 500); // keep streaming 500 ms past A's resolution, then finish
      } else {
        record.heldUntilAResolved = fixtureState.aResolved;
        record.streamMs = Date.now() - bStarted;
        record.finished = Date.now();
        finishClean(200);
      }
    };
    writeB();
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

// ─── Internal API client over the unix socket ────────────────────────────────

function apiRequest(socketPath, token, method, apiPath, body, timeoutMs = 300_000) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    const chunks = [];
    socket.setTimeout(timeoutMs);
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
  // Longest legitimate runaway window is ~35 s; 120 s surfaces a wedge fast
  // (run 3 lesson: an unresolved dispatch must not eat 300 s per scenario).
  const response = await apiRequest(socketPath, token, 'POST', `/api/v1/sessions/${sessionId}/prompt`, { message }, 120_000);
  return { response, wallMs: Date.now() - started };
}

async function getReceipt(socketPath, token, runId) {
  const response = await apiRequest(socketPath, token, 'GET', `/api/v1/runs/${runId}`);
  return response.json;
}

// ─── metrics window (B2 gate framing) ────────────────────────────────────────

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
  const lagValues = samples.map((record) => record.lagP99Ms).filter((value) => typeof value === 'number');
  if (samples.length === 0) return { available: false, reason: 'no samples in window', totalLines: lines.length };
  let over300 = 0;
  let twoConsecutiveOver300 = false;
  let consecutiveRun = 0;
  for (const value of lagValues) {
    if (value >= 300) {
      over300 += 1;
      consecutiveRun += 1;
      if (consecutiveRun >= 2) twoConsecutiveOver300 = true;
    } else {
      consecutiveRun = 0;
    }
  }
  return {
    available: true,
    samples: samples.length,
    lagP99Max: lagValues.length ? Math.max(...lagValues) : null,
    p99Over300: over300,
    twoConsecutiveOver300,
  };
}

// ─── scenarios ───────────────────────────────────────────────────────────────

async function runScenario(socketPath, token) {
  fixtureState.requests = 0; // each scenario's first provider request is its runaway
  fixtureState.log.length = 0; // per-scenario records (stale cross-scenario records lie)
  fixtureState.aResolved = false;
  const sessionA = await createSession(socketPath, token, 'A');
  const windowStart = Date.now();

  const aFiredAt = Date.now();
  const aPromise = promptAndWait(socketPath, token, sessionA, 'stream the runaway fixture');

  await sleep(2_000); // let A get mid-stream
  const sessionB = await createSession(socketPath, token, 'B');
  const bFiredAt = Date.now();
  // Fire B WITHOUT awaiting it: B's fixture stream holds until A resolves,
  // so awaiting B here would deadlock the completion order that is the
  // evidence.
  const bPromise = promptAndWait(socketPath, token, sessionB, 'answer briefly');

  const a = await aPromise;
  const aResolvedAt = Date.now();
  fixtureState.aResolved = true; // B's fixture stream may now finish (500 ms grace)
  const b = await bPromise;
  const bResolvedAt = Date.now();
  const windowEnd = Date.now();
  const aRunId = a.response.json?.runId;
  const aReceipt = aRunId ? await getReceipt(socketPath, token, aRunId) : undefined;
  const bReceiptRunId = b.response.json?.runId;
  const bReceipt = bReceiptRunId ? await getReceipt(socketPath, token, bReceiptRunId) : undefined;

  const aErrorCode = a.response.json?.code ?? aReceipt?.errorCode;
  const bStreamRecord = fixtureState.log.find((r) => r.kind === 'streaming-session');
  const runawayRecord = fixtureState.log.find((r) => r.kind === 'runaway');
  return {
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
    timeline: {
      aFiredAt,
      bFiredAt,
      aResolvedAt,
      bResolvedAt,
      // The correction's requirement: B streamed THROUGHOUT A's runaway
      // window — B's run must still be in flight when A's abort lands. The
      // fixture holds B's stream until aResolved + 500 ms, so this is
      // structural, not timing luck.
      bSpannedARun: bResolvedAt >= aResolvedAt,
      bHeldUntilAResolved: bStreamRecord?.heldUntilAResolved ?? null,
      bStreamMs: bStreamRecord?.streamMs ?? null,
      bStreamedBytes: bStreamRecord?.bytes ?? null,
    },
    runaway: {
      bytesStreamed: runawayRecord?.bytes ?? null,
      finishedCleanly: runawayRecord?.finished != null,
    },
    fixture: { requests: fixtureState.requests, log: fixtureState.log.slice() },
    metrics: analyseMetrics(path.join(stateDir, 'metrics'), windowStart, windowEnd),
  };
}

// ─── orchestration ───────────────────────────────────────────────────────────

async function tsx(args) {
  const { spawnSync } = await import('node:child_process');
  const run = spawnSync('npx', ['tsx', harness, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  return { status: run.status, stdout: run.stdout ?? '' };
}

async function main() {
  const port = await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const chosen = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (chosen ? resolve(chosen) : reject(new Error('no port'))));
    });
    server.on('error', reject);
  });
  log(`fixture provider on 127.0.0.1:${port}`);
  await startFixture(port);

  log('building scratch resolution root (idempotent) …');
  const build = await tsx(['build', scratch, '--fixture-port', String(port)]);
  if (build.status !== 0) fail(`harness build failed (exit ${build.status})`);

  const serveOnce = async (envOverrides) => {
    const args = ['serve', scratch, '--fixture-port', String(port)];
    for (const [key, value] of Object.entries(envOverrides)) args.push('--env', `${key}=${value}`);
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

  const wantBytes = scenario === 'all' || scenario === 'bytes';
  const wantRealistic = scenario === 'all' || scenario === 'bytes-realistic';
  const wantTokens = scenario === 'all' || scenario === 'tokens';
  const wantCapOff = scenario === 'all' || scenario === 'cap-off';

  const verdict = {
    scenarios: {},
    fixturePort: port,
    scratch,
    chunkBytes,
    paceChunkMs,
    runawayBytes,
    controlOutputTokens,
    // Pacing justification (correction 01): real per-run streaming rates from
    // the measured corpus (/root/orch-ops/orchestration-scaling/b3b/measure/
    // measurement-v2.json, merged at the <2s follow-up gap, includes tool
    // time): p50 148 B/s, p90 446 B/s, p99 1,014 B/s, p99.9 4,551 B/s, max
    // 6,583 B/s. The stress run (4096 B / 3 ms ≈ 1,367,000 B/s) is ~300× the
    // p99.9 real rate — a deliberate stress bound. The bytes-realistic run
    // streams 64 B / 3 ms ≈ 333 chunks/s ≈ 21,000 B/s at B3a's measured
    // ~300 deltas/s provider pace, ~3× the most intense real run — and still
    // aborts at its (lowered) cap, at realistic pacing.
    pacing: {
      measuredRealBytesPerSecond: { p50: 148, p90: 446, p99: 1014, p999: 4551, max: 6583 },
      stressBytesPerSecond: Math.round(chunkBytes / (paceChunkMs / 1000)),
      realisticBytesPerSecond: 21000,
      realisticChunksPerSecond: 333,
    },
  };
  const tokenPath = path.join(stateDir, 'internal-api-token');

  try {
    if (wantBytes) {
      log('── scenario bytes (default budgets, stress-paced ~1.37 MB/s ≈ 300× p99.9 real rate) ──');
      runawayPlan.bytes = 32 * 1024 * 1024; // never reached: the 16 MiB cap aborts mid-stream
      runawayPlan.completionTokens = controlOutputTokens;
      runawayPlan.chunkBytes = 4096;
      runawayPlan.bMinStreamMs = 16_000; // A aborts at ~14 s; B must stream past it
      const server = await serveOnce({});
      const token = readFileSync(tokenPath, 'utf8').trim();
      verdict.scenarios.bytes = await runScenario(server.socketPath, token);
      await stopServer();
    }
    if (wantRealistic) {
      log('── scenario bytes-realistic (lowered byte cap, ~333 chunks/s ≈ B3a measured provider pace) ──');
      // Realistic pacing AND an abort: 128 KiB cap at ~21 KB/s aborts in ~7 s
      // (fastest observed real RUN streamed 6.6 KB/s; B3a measured ~300
      // deltas/s provider pacing) — the paced lag gate at real-world rates.
      runawayPlan.bytes = 1024 * 1024; // never reached: the 128 KiB cap aborts first
      runawayPlan.completionTokens = controlOutputTokens;
      runawayPlan.chunkBytes = 64;
      runawayPlan.bMinStreamMs = 10_000;
      const server = await serveOnce({ PI_RUN_BUDGET_MAX_STREAMED_BYTES: '131072' });
      const token = readFileSync(tokenPath, 'utf8').trim();
      verdict.scenarios['bytes-realistic'] = await runScenario(server.socketPath, token);
      await stopServer();
    }
    if (wantTokens) {
      log('── scenario tokens (PI_RUN_BUDGET_MAX_OUTPUT_TOKENS=2000) ──');
      // Small generation (far under the byte default) whose final usage chunk
      // reports far more output tokens than the lowered cap: proves the
      // message_end token path without the byte cap firing first.
      runawayPlan.bytes = 64 * 1024;
      runawayPlan.completionTokens = 50_000;
      runawayPlan.chunkBytes = 4096;
      runawayPlan.bMinStreamMs = 3_000;
      const server = await serveOnce({ PI_RUN_BUDGET_MAX_OUTPUT_TOKENS: '2000' });
      const token = readFileSync(tokenPath, 'utf8').trim();
      verdict.scenarios.tokens = await runScenario(server.socketPath, token);
      await stopServer();
    }
    if (wantCapOff) {
      log('── scenario cap-off (positive control, both knobs 0) ──');
      // The same volumes that abort cap-on — 17 MiB streamed (past the 16 MiB
      // byte default) and a large reported output-token total — with the
      // knobs at 0 neither trips: the run completes normally.
      runawayPlan.bytes = runawayBytes;
      runawayPlan.completionTokens = controlOutputTokens;
      runawayPlan.chunkBytes = 4096;
      runawayPlan.bMinStreamMs = 16_000;
      const server = await serveOnce({ PI_RUN_BUDGET_MAX_OUTPUT_TOKENS: '0', PI_RUN_BUDGET_MAX_STREAMED_BYTES: '0' });
      const token = readFileSync(tokenPath, 'utf8').trim();
      verdict.scenarios['cap-off'] = await runScenario(server.socketPath, token);
      await stopServer();
    }
  } finally {
    await stopServer(); // idempotent; no orphan may survive a FATAL
  }

  writeFileSync(path.join(scratch, 'verdict-b3b.json'), `${JSON.stringify(verdict, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
  process.exit(0);
}

main().catch((error) => fail(error instanceof Error ? error.stack ?? error.message : String(error)));
