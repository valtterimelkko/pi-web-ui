#!/usr/bin/env node
/**
 * E2a-5 arm 2+3 — independent re-run of H1's view-only switch burst alongside
 * real children (H1.md §4 M5-arm method, re-written after reading the
 * executor's burst-driver.mjs; their numbers are claims to check).
 *
 * Subcommands (run OUTSIDE the server unit, against its unix socket + port):
 *   prepare   create N cold target sessions (+ write sessions.json)
 *   children  create the 2 real children: #0 goal-armed realistic pattern
 *             (real extension set, worktree-like cwd), #1 plain tool-using
 *   burst     fire the children's turns, hold until A2 shows the wanted
 *             concurrent active turns, then N switch_session at the production
 *             cadence; optionally spawn the Playwright browser check mid-burst
 *   collect   A2 lag p50/p99/max inside the burst window, activeTurns samples,
 *             latch replay, refusal count, switch wall p50/p99
 *
 * Every wall number is client-observed on 127.0.0.1; lag numbers come from the
 * A2 metrics of THIS run's server only.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn as spawnProc } from 'node:child_process';
import { parseArgs, now, readMetrics, windowStats, replayLatch, readTrim } from './lib.mjs';

const argv = parseArgs(process.argv.slice(2));
const COMMAND = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : undefined;
const RUN = path.resolve(argv['run-dir'] ?? process.cwd());
const SOCKET = path.join(RUN, 'server', 'internal-api.sock');
const TOKEN = path.join(RUN, 'server', 'internal-api-token');
const PORT_FILE = path.join(RUN, 'port');
if (!COMMAND || !fs.existsSync(SOCKET)) {
  console.error('usage: node h1-burst.mjs <prepare|children|burst|collect> --run-dir=<dir> [options]');
  process.exit(64);
}
const PORT = parseInt(fs.readFileSync(PORT_FILE, 'utf8').trim(), 10);

function arg(name, fallback) {
  const v = argv[name];
  return v === undefined ? fallback : v;
}

function apiCall(method, apiPath, body, timeoutMs = 600_000) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: SOCKET,
        path: apiPath,
        method,
        headers: {
          authorization: `Bearer ${readTrim(TOKEN)}`,
          'content-type': 'application/json',
          ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`request timeout ${method} ${apiPath}`)));
    if (payload) req.write(payload);
    req.end();
  });
}

// ── browser-shaped WS client (H1's method: cookie auth + Origin + /ws) ──────
function login(port, password = 'dev-password') {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ password });
    const req = http.request({
      host: '127.0.0.1', port, path: '/api/auth/login', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      const setCookie = res.headers['set-cookie'];
      const raw = setCookie?.find((c) => c.startsWith('accessToken='));
      if ((res.statusCode ?? 500) >= 400 || !raw) {
        let errBody = '';
        res.on('data', (d) => { errBody += d; });
        res.on('end', () => reject(new Error(`login failed: ${res.statusCode} ${errBody.slice(0, 200)}`)));
        return;
      }
      res.resume();
      resolve(raw.split(';')[0].split('=').slice(1).join('='));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

class BrowserClient {
  constructor() {
    this.inbox = [];
    this.waiters = [];
    this.ws = null;
  }
  async connect() {
    const token = await login(PORT);
    const { WebSocket } = await import('ws');
    this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, {
      headers: { Origin: 'http://localhost:3457', Cookie: `accessToken=${token}` },
      maxPayload: 256 * 1024 * 1024,
    });
    this.ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      const w = this.waiters.find((w) => w.match(msg));
      if (w) { this.waiters.splice(this.waiters.indexOf(w), 1); w.resolve(msg); }
      else this.inbox.push(msg);
    });
    await new Promise((resolve, reject) => { this.ws.once('open', resolve); this.ws.once('error', reject); });
    await this.waitFor((m) => m.type === 'authenticated', 15_000);
    return this;
  }
  waitFor(match, timeoutMs) {
    const idx = this.inbox.findIndex(match);
    if (idx >= 0) return Promise.resolve(this.inbox.splice(idx, 1)[0]);
    return new Promise((resolve, reject) => {
      const w = { match, resolve };
      this.waiters.push(w);
      setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) { this.waiters.splice(i, 1); reject(new Error('ws wait timeout')); }
      }, timeoutMs).unref();
    });
  }
  send(msg) { this.ws.send(JSON.stringify(msg)); }
  close() { try { this.ws?.close(); } catch { /* already closed */ } }
}

async function prepare() {
  const count = parseInt(arg('count', '66'), 10);
  fs.mkdirSync(path.join(RUN, 'workspaces'), { recursive: true });
  const sessions = [];
  for (let i = 0; i < count; i++) {
    const cwd = path.join(RUN, 'workspaces', `ws-${String(i).padStart(3, '0')}`);
    fs.mkdirSync(cwd, { recursive: true });
    const res = await apiCall('POST', '/api/v1/sessions', { runtime: 'pi', cwd, model: 'zai/glm-5.3-flash' });
    if (res.status !== 201) throw new Error(`create ${i} failed ${res.status}: ${res.body.slice(0, 300)}`);
    const j = JSON.parse(res.body);
    sessions.push({ sessionId: j.sessionId, sessionPath: j.sessionPath, cwd });
    if ((i + 1) % 10 === 0) console.error(`prepare: ${i + 1}/${count}`);
  }
  fs.writeFileSync(path.join(RUN, 'sessions.json'), JSON.stringify(sessions, null, 1));
  console.error(`prepare: wrote ${sessions.length} cold targets`);
}

async function children() {
  fs.mkdirSync(path.join(RUN, 'workspaces'), { recursive: true });
  const marker = arg('marker', `A5H1-${Date.now().toString(36).toUpperCase()}`);
  // Child 0 — the owner's realistic pattern: goal-armed, fresh worktree-like cwd.
  const cwd0 = path.join(RUN, 'workspaces', 'child-goal');
  fs.mkdirSync(path.join(cwd0, 'src'), { recursive: true });
  fs.writeFileSync(path.join(cwd0, 'README.md'), `# goal child worktree (${marker})\n`);
  const goalObjective = arg('goal-objective',
    `Write the numbers 1 through 40 into count.txt in this directory, ten numbers per bash call, across four separate bash calls, then say DONE.`);
  const res0 = await apiCall('POST', '/api/v1/sessions', {
    runtime: 'pi', cwd: cwd0, model: 'zai/glm-5.3-flash', thinkingLevel: 'low',
    goal: { objective: goalObjective, maxTurns: 12 },
  });
  if (res0.status !== 201) throw new Error(`goal child create failed ${res0.status}: ${res0.body.slice(0, 300)}`);
  const c0 = JSON.parse(res0.body);
  console.error(`children: goal-armed child 0 created ${c0.sessionId}`);

  // Child 1 — plain, tool-using work (H1 M5: six sequential sleep-25 calls).
  const cwd1 = path.join(RUN, 'workspaces', 'child-plain');
  fs.mkdirSync(cwd1, { recursive: true });
  const res1 = await apiCall('POST', '/api/v1/sessions', {
    runtime: 'pi', cwd: cwd1, model: 'zai/glm-5.3-flash', thinkingLevel: 'low',
  });
  if (res1.status !== 201) throw new Error(`plain child create failed ${res1.status}: ${res1.body.slice(0, 300)}`);
  const c1 = JSON.parse(res1.body);
  console.error(`children: plain child 1 created ${c1.sessionId}`);

  const list = [
    { ...c0, kind: 'goal' },
    { ...c1, kind: 'plain', prompt: `Run exactly six sequential bash commands, each \`sleep 25\`. After the sixth, reply with exactly one line: ${marker}-DONE. Do not skip any sleep.` },
  ];
  fs.writeFileSync(path.join(RUN, 'children.json'), JSON.stringify(list, null, 1));
  console.error(`children: wrote children.json marker=${marker}`);
}

async function burst() {
  const label = arg('label', 'burst');
  const sessionsFile = arg('sessions', path.join(RUN, 'sessions.json'));
  const all = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
  const count = parseInt(arg('count', '66'), 10);
  const intervalMs = parseInt(arg('interval-ms', '2000'), 10);
  const waitTurns = parseInt(arg('wait-turns', '2'), 10);
  const waitTurnsTimeoutMs = parseInt(arg('wait-turns-timeout-ms', '300000'), 10);
  const browserHook = arg('browser-hook');
  const browserHookAtSwitch = parseInt(arg('browser-hook-at-switch', '8'), 10);
  const childrenFile = path.join(RUN, 'children.json');
  const children = fs.existsSync(childrenFile) ? JSON.parse(fs.readFileSync(childrenFile, 'utf8')) : [];

  const burstStartMs = Date.now();
  // Fire the children's turns first (the goal child's loop owns its turns; the
  // plain child is prompted, not awaited).
  const childPromises = [];
  for (const c of children) {
    if (c.kind === 'goal') continue;
    childPromises.push(
      apiCall('POST', `/api/v1/sessions/${c.sessionId}/prompt`, { message: c.prompt })
        .then((r) => ({ sessionId: c.sessionId, status: r.status, body: r.body.slice(0, 200) }))
        .catch((e) => ({ sessionId: c.sessionId, error: String(e) })),
    );
  }

  // Hold the burst until the A2 telemetry itself shows the wanted concurrent
  // active turns (M5's method — the readings are the load-claim source).
  const metricsFile = path.join(RUN, 'server', 'metrics', 'health-metrics.jsonl');
  let turnsSeen = false;
  {
    const deadline = Date.now() + waitTurnsTimeoutMs;
    while (Date.now() < deadline) {
      try {
        const lines = fs.readFileSync(metricsFile, 'utf-8').trim().split('\n');
        const last = JSON.parse(lines[lines.length - 1]);
        if ((last.activeTurns ?? 0) >= waitTurns && Date.now() - last.atMs < 45_000) { turnsSeen = true; break; }
      } catch { /* metrics not there yet */ }
      await new Promise((r) => setTimeout(r, 5000));
    }
    console.error(`burst: wait-turns ${waitTurns} ${turnsSeen ? 'satisfied' : 'TIMED OUT'} (children start ${new Date(burstStartMs).toISOString()})`);
  }
  const turnsSatisfiedAtMs = Date.now();

  const client = await new BrowserClient().connect();
  const switches = [];
  let browserHookResult = null;
  const runLoop = async () => {
    const t0 = Date.now();
    for (let i = 0; i < count; i++) {
      if (browserHook && i === browserHookAtSwitch && browserHookResult === null) {
        // Mid-burst: the Playwright oracle watches child 0 while switches continue.
        console.error(`burst: launching browser hook at switch ${i}`);
        browserHookResult = await new Promise((resolve) => {
          const p = spawnProc('python3', [browserHook, `--run-dir=${RUN}`, `--viewport=both`], {
            cwd: RUN, env: { ...process.env, A5_BURST_ACTIVE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
          });
          let o = '', e = '';
          p.stdout.on('data', (d) => { o += d; process.stderr.write(`[browser] ${d}`); });
          p.stderr.on('data', (d) => { e += d; process.stderr.write(`[browser!] ${d}`); });
          p.once('exit', (code) => resolve({ code, out: o.slice(-4000), err: e.slice(-4000) }));
        });
        console.error(`burst: browser hook finished code=${browserHookResult.code}`);
      }
      const target = all[i % all.length];
      const t1 = performance.now();
      client.send({ type: 'switch_session', sessionPath: target.sessionPath });
      const ack = await client.waitFor(
        (m) => (m.type === 'session_switched' && m.sessionPath === target.sessionPath) || m.type === 'error',
        120_000,
      );
      const wallMs = performance.now() - t1;
      const messages = ack.type === 'session_switched' ? ack.messages?.length ?? 0 : null;
      switches.push({
        i, sessionPath: target.sessionPath, ok: ack.type === 'session_switched',
        wallMs: Math.round(wallMs * 10) / 10, replayedMessages: messages,
        error: ack.type === 'error' ? String(ack.error ?? ack.message ?? 'error').slice(0, 200) : null,
      });
      if (!switches[switches.length - 1].ok) console.error(`burst: switch ${i} NOT OK: ${JSON.stringify(ack).slice(0, 200)}`);
      const remain = intervalMs - (performance.now() - t1);
      if (remain > 0 && i < count - 1) await new Promise((r) => setTimeout(r, remain));
    }
    return Date.now() - t0;
  };

  const wallTotalMs = await runLoop();
  client.close();
  const burstEndMs = Date.now();
  const childResults = await Promise.all(childPromises);
  // Goal child: bounded status poll.
  const goalResults = [];
  for (const c of children.filter((c) => c.kind === 'goal')) {
    let finalStatus = null;
    for (let t = 0; t < 24; t++) {
      const r = await apiCall('GET', `/api/v1/sessions/${c.sessionId}/goal`).catch(() => null);
      if (r && r.status === 200) {
        try {
          const g = JSON.parse(r.body);
          finalStatus = g.status ?? g.goal?.status ?? null;
          if (finalStatus && finalStatus !== 'running') break;
        } catch { /* keep polling */ }
      }
      await new Promise((res) => setTimeout(res, 5000));
    }
    goalResults.push({ sessionId: c.sessionId, finalStatus });
  }

  const okSwitches = switches.filter((s) => s.ok);
  const walls = okSwitches.map((s) => s.wallMs).sort((a, b) => a - b);
  const q = (arr, p) => arr[Math.min(arr.length - 1, Math.max(0, Math.ceil(p * arr.length) - 1))];

  // A2 stats inside the burst window (from MY server's metrics).
  const readings = readMetrics(path.join(RUN, 'server'));
  const stats = windowStats(readings, turnsSatisfiedAtMs - 2000, burstEndMs + 2000);
  const latch = replayLatch(readings.filter((r) => r.atMs >= turnsSatisfiedAtMs - 2000 && r.atMs <= burstEndMs + 2000));

  const outPath = path.join(RUN, `burst-${label}.json`);
  fs.writeFileSync(outPath, JSON.stringify({
    label, count, intervalMs, wallTotalMs, burstStartAt: new Date(burstStartMs).toISOString(),
    turnsSatisfiedAtMs, turnsSatisfiedAt: new Date(turnsSatisfiedAtMs).toISOString(),
    burstEndAt: new Date(burstEndMs).toISOString(),
    switches, childResults, goalResults, browserHook: browserHookResult ? { code: browserHookResult.code } : null,
    summary: {
      ok: okSwitches.length, failed: switches.length - okSwitches.length,
      wallP50: q(walls, 0.5), wallP99: q(walls, 0.99), wallMax: walls[walls.length - 1] ?? null,
    },
    a2: {
      readingCount: stats.readingCount,
      lagP50: stats.lagP50, lagP99: stats.lagP99, lagMax: stats.lagMax,
      peakActiveTurns: stats.peakActiveTurns,
      activeTurnsSamples: stats.activeTurnsSamples,
      latchDuringBurst: latch.latched, latchedAt: latch.latchedAt,
    },
  }, null, 1));
  console.error(`burst: ${okSwitches.length}/${switches.length} ok; wall p50 ${q(walls, 0.5)} p99 ${q(walls, 0.99)} max ${walls[walls.length - 1]} ms; A2 lag p99 ${stats.lagP99.p50 ?? '?'}/${stats.lagP99.max ?? '?'} (p50of/max) peakTurns=${stats.peakActiveTurns} latch=${latch.latched} → ${outPath}`);
}

async function collect() {
  const label = arg('label', 'all');
  const readings = readMetrics(path.join(RUN, 'server'));
  const burstFiles = fs.readdirSync(RUN).filter((f) => f.startsWith('burst-') && f.endsWith('.json'));
  let window = null;
  if (burstFiles.length) {
    const b = JSON.parse(fs.readFileSync(path.join(RUN, burstFiles[burstFiles.length - 1]), 'utf8'));
    window = windowStats(readings, Date.parse(b.turnsSatisfiedAt) - 2000, Date.parse(b.burstEndAt) + 2000);
  }
  const latch = replayLatch(readings);
  const serverLog = path.join(RUN, 'server.log');
  let rehydrations = 0, admissionRefusals = 0;
  if (fs.existsSync(serverLog)) {
    for (const line of fs.readFileSync(serverLog, 'utf8').split('\n')) {
      if (line.includes('Session rehydrated')) rehydrations++;
      if (line.includes('ADMISSION_CAPACITY_EXHAUSTED')) admissionRefusals++;
    }
  }
  const diag = await apiCall('GET', '/api/v1/diagnostics?component=LoopAttribution&limit=200').catch(() => null);
  const outPath = path.join(RUN, `collect-${label}.json`);
  fs.writeFileSync(outPath, JSON.stringify({
    generatedAt: now(),
    readingsCount: readings.length,
    burstWindow: window ? {
      readingCount: window.readingCount,
      lagP50: window.lagP50, lagP99: window.lagP99, lagMax: window.lagMax,
      peakActiveTurns: window.peakActiveTurns,
      activeTurnsSamples: window.activeTurnsSamples,
    } : null,
    latchWholeRun: latch.latched, latchedAt: latch.latchedAt,
    rehydrations, admissionRefusals,
    diagnostics: diag ? (() => { try { return JSON.parse(diag.body); } catch { return { raw: diag.body.slice(0, 400) }; } })() : null,
  }, null, 1));
  console.error(`collect: readings=${readings.length} latch=${latch.latched} rehydrations=${rehydrations} refusals=${admissionRefusals} → ${outPath}`);
}

const commands = { prepare, children, burst, collect };
const fn = commands[COMMAND];
if (!fn) { console.error(`unknown command ${COMMAND}`); process.exit(2); }
fn().catch((err) => { console.error('FATAL', err); process.exit(1); });
