#!/usr/bin/env npx tsx
/**
 * E2a-1 — H1's view-only switch burst, driven against a running heap-soak
 * disposable server (the soak's ~60-minute burst arm).
 *
 * Method = H1's burst-driver.mjs (orch-ops/h1/harness), same burst size and
 * cadence: ONE authenticated browser WS client (/api/auth/login → cookie JWT
 * → /ws with Origin http://localhost:3000) sends `switch_session` messages
 * sequentially over a corpus of sessions — default 58 switches (H1's
 * production-episode burst size, `count`) at the production cadence (3.8 s,
 * `interval-ms`), waiting for each `session_switched` ack — while admission
 * probes (one POST /api/v1/sessions every 10 s) record refusals. Latches are
 * replayed from the server's own A2 metrics with B2's rule (300 ms sustained
 * over two readings, recovery < 150 ms) via the tested pure replay.
 *
 * Corpus placement: cwds are created under `<run>/burst-corpus-ws/` —
 * deliberately OUTSIDE the run's `children/` root, which is the only root the
 * harness's untracked-orphan sweep selects from (correction 04); the sweep
 * must not delete the corpus mid-burst. All corpus sessions are deleted at
 * the end and the deletion count is recorded.
 *
 *   npx tsx scripts/e2a-soak/h1-burst.ts --run-state <run>/run-state.json \
 *     [--count 58] [--interval-ms 3800] [--corpus 60] [--out <run>/h1-burst.json]
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import WebSocket from 'ws';
import { InternalApiClient } from '../../server/src/live-validation/internal-api-client.js';
import {
  replayAdmissionGate,
  spikeMinuteBuckets,
  heapRangeBytes,
  peakAndMeanActiveTurns,
  type TelemetryRow,
} from '../../server/src/live-validation/heap-soak/telemetry-replay.js';

const SPIKE_THRESHOLD_MS = 300;

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
function numArg(name: string, fallback: number): number {
  const raw = arg(name);
  if (raw === undefined) return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new Error(`--${name} must be a number`);
  return v;
}

interface RunStateFile {
  runId: string;
  runDir: string;
  server: { unitName: string; socketPath: string; tokenPath: string; httpPort: number; inspectorPort: number; mainPid: number };
}

interface CorpusEntry { sessionId: string; sessionPath: string; cwd: string }

function login(port: number, password = 'dev-password'): Promise<string> {
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

class BurstClient {
  private inbox: Record<string, unknown>[] = [];
  private waiters: { match: (m: Record<string, unknown>) => boolean; resolve: (m: Record<string, unknown>) => void; timer: NodeJS.Timeout }[] = [];
  private ws: WebSocket | null = null;
  messagesReceived = 0;

  async connect(port: number): Promise<void> {
    const token = await login(port);
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { Origin: 'http://localhost:3000', Cookie: `accessToken=${token}` },
      maxPayload: 256 * 1024 * 1024,
    });
    this.ws.on('message', (raw) => {
      this.messagesReceived += 1;
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(String(raw)) as Record<string, unknown>; } catch { return; }
      const idx = this.waiters.findIndex((w) => w.match(msg));
      if (idx >= 0) {
        const w = this.waiters.splice(idx, 1)[0];
        clearTimeout(w.timer);
        w.resolve(msg);
      } else {
        this.inbox.push(msg);
      }
    });
    await new Promise<void>((resolve, reject) => {
      this.ws?.once('open', () => resolve());
      this.ws?.once('error', reject);
    });
    await this.waitFor((m) => m.type === 'authenticated', 15_000);
  }

  waitFor(match: (m: Record<string, unknown>) => boolean, timeoutMs: number): Promise<Record<string, unknown>> {
    const idx = this.inbox.findIndex(match);
    if (idx >= 0) return Promise.resolve(this.inbox.splice(idx, 1)[0]);
    return new Promise((resolve, reject) => {
      const w = { match, resolve, timer: setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error('ws wait timeout'));
      }, timeoutMs) };
      this.waiters.push(w);
    });
  }

  send(msg: unknown): void { this.ws?.send(JSON.stringify(msg)); }
  close(): void { try { this.ws?.close(); } catch { /* already closed */ } }
}

function findMetricsFile(runDir: string): string | undefined {
  const validationDir = path.join(runDir, 'validation');
  if (!existsSync(validationDir)) return undefined;
  const candidates: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 3) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name.startsWith('health-metrics') && entry.name.endsWith('.jsonl')) candidates.push(full);
    }
  };
  walk(validationDir, 0);
  candidates.sort((a, b) => a.split('.').length - b.split('.').length || a.localeCompare(b));
  return candidates[candidates.length - 1];
}

function readMetricsRows(file: string): TelemetryRow[] {
  const rows: TelemetryRow[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const d = JSON.parse(line) as Record<string, unknown>;
      if (typeof d.atMs === 'number' && typeof d.lagP99Ms === 'number' && typeof d.heapUsedBytes === 'number') {
        rows.push({ atMs: d.atMs, lagP99Ms: d.lagP99Ms, heapUsedBytes: d.heapUsedBytes, activeTurns: typeof d.activeTurns === 'number' ? d.activeTurns : 0 });
      }
    } catch { /* skip */ }
  }
  rows.sort((a, b) => a.atMs - b.atMs);
  return rows;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

async function run(): Promise<void> {
  const runStatePath = arg('run-state');
  if (!runStatePath) { console.error('--run-state <run>/run-state.json is required'); process.exit(64); }
  const state = JSON.parse(readFileSync(runStatePath, 'utf8')) as RunStateFile;
  const count = numArg('count', 58);
  const intervalMs = numArg('interval-ms', 3800);
  const corpusSize = numArg('corpus', 60);
  const outPath = arg('out') ?? path.join(state.runDir, 'h1-burst.json');

  const client = new InternalApiClient({ socketPath: state.server.socketPath, tokenPath: state.server.tokenPath });
  const corpusRoot = path.join(state.runDir, 'burst-corpus-ws');

  // 1. Corpus (created BEFORE the burst window, as H1 ran create-sessions first).
  const corpus: CorpusEntry[] = [];
  const { mkdirSync } = await import('node:fs');
  mkdirSync(corpusRoot, { recursive: true });
  for (let i = 0; i < corpusSize; i += 1) {
    const cwd = path.join(corpusRoot, `ws-${String(i).padStart(3, '0')}`);
    mkdirSync(cwd, { recursive: true });
    const created = await client.createSession({
      runtime: 'pi',
      cwd,
      model: 'zai/glm-5.3-flash',
      source: `heap-soak-burst:${state.runId}`,
    });
    corpus.push({ sessionId: created.sessionId, sessionPath: created.sessionPath, cwd });
    if ((i + 1) % 10 === 0) console.error(`burst: corpus ${i + 1}/${corpusSize}`);
  }
  if (corpus.some((c) => !c.sessionPath)) {
    console.error('burst: FATAL — a corpus session lacks sessionPath; switching needs it');
    process.exit(1);
  }

  // 2. Browser WS client (H1's method).
  const ws = new BurstClient();
  await ws.connect(state.server.httpPort);

  // 3. Admission probes every 10 s (a non-201 create is a refusal). Probe
  // sessions are never prompted (no model call) and deleted immediately.
  const probes: { at: string; status?: number; error?: string; bodySnippet?: string }[] = [];
  let probeCreated: string[] = [];
  const probeTimer = setInterval(() => {
    void (async () => {
      const cwd = path.join(corpusRoot, `probe-${Date.now()}`);
      mkdirSync(cwd, { recursive: true });
      try {
        const created = await client.createSession({ runtime: 'pi', cwd, model: 'zai/glm-5.3-flash', source: `heap-soak-burst-probe:${state.runId}` });
        probeCreated.push(created.sessionId);
        probes.push({ at: new Date().toISOString(), status: 201 });
      } catch (error) {
        probes.push({ at: new Date().toISOString(), error: error instanceof Error ? error.message.slice(0, 300) : String(error) });
      }
    })();
  }, 10_000);

  // 4. The burst: `count` sequential switches at the production cadence.
  const burstStartMs = Date.now();
  const switches: { i: number; sessionPath: string; ok: boolean; wallMs: number; replayedMessages: number | null; error?: string }[] = [];
  for (let i = 0; i < count; i += 1) {
    const target = corpus[i % corpus.length];
    const t1 = performance.now();
    try {
      ws.send({ type: 'switch_session', sessionPath: target.sessionPath });
      const ack = await ws.waitFor((m) => (m.type === 'session_switched' && m.sessionPath === target.sessionPath) || m.type === 'error', 120_000);
      const wallMs = Math.round((performance.now() - t1) * 10) / 10;
      const ok = ack.type === 'session_switched';
      const messages = ok && Array.isArray(ack.messages) ? (ack.messages as unknown[]).length : null;
      switches.push({ i, sessionPath: target.sessionPath, ok, wallMs, replayedMessages: messages, error: ok ? undefined : JSON.stringify(ack).slice(0, 200) });
    } catch (error) {
      switches.push({ i, sessionPath: target.sessionPath, ok: false, wallMs: Math.round((performance.now() - t1) * 10) / 10, replayedMessages: null, error: error instanceof Error ? error.message : String(error) });
    }
    const remain = intervalMs - (performance.now() - t1);
    if (remain > 0 && i < count - 1) await new Promise((resolve) => setTimeout(resolve, remain));
  }
  const burstEndMs = Date.now();
  clearInterval(probeTimer);

  // Probe sessions created DURING the burst are real sessions — delete them.
  for (const id of probeCreated) { try { await client.deleteSession(id); } catch { /* counted in cleanup below */ } }

  ws.close();

  // 5. Server's own A2 rows inside the burst window → lag/turns/latch/spikes.
  const metricsFile = findMetricsFile(state.runDir);
  const windowRows = metricsFile ? readMetricsRows(metricsFile).filter((r) => r.atMs >= burstStartMs - 5_000 && r.atMs <= burstEndMs + 5_000) : [];
  const latches = replayAdmissionGate(windowRows, { tripMs: SPIKE_THRESHOLD_MS, recoverMs: 150 });
  const spikes = spikeMinuteBuckets(windowRows, SPIKE_THRESHOLD_MS);
  const heap = heapRangeBytes(windowRows);
  const turns = peakAndMeanActiveTurns(windowRows);

  // 6. Cleanup: delete every corpus session; count the outcome.
  let deleted = 0;
  const deleteErrors: { sessionId: string; error: string }[] = [];
  for (const entry of corpus) {
    try { await client.deleteSession(entry.sessionId); deleted += 1; }
    catch (error) { deleteErrors.push({ sessionId: entry.sessionId, error: error instanceof Error ? error.message.slice(0, 200) : String(error) }); }
  }

  const okWalls = switches.filter((s) => s.ok).map((s) => s.wallMs).sort((a, b) => a - b);
  const result = {
    schema: 'e2a-1-h1-burst/v1',
    runId: state.runId,
    method: `H1 burst-driver method: one authenticated browser WS client, ${count} sequential view-only switch_session messages at ${intervalMs} ms production cadence (H1's production-episode burst size and cadence)`,
    buildCommit: state.server.unitName,
    params: { count, intervalMs, corpusSize },
    window: { startIso: new Date(burstStartMs).toISOString(), endIso: new Date(burstEndMs).toISOString(), wallMs: burstEndMs - burstStartMs },
    switches: {
      total: switches.length,
      ok: switches.filter((s) => s.ok).length,
      failed: switches.filter((s) => !s.ok).length,
      wallP50Ms: percentile(okWalls, 50),
      wallP99Ms: percentile(okWalls, 99),
      wallMaxMs: okWalls.length > 0 ? okWalls[okWalls.length - 1] : null,
      errors: switches.filter((s) => !s.ok).slice(0, 10),
    },
    probes: { count: probes.length, refusals: probes.filter((p) => p.status !== 201).length, detail: probes.filter((p) => p.status !== 201).slice(0, 10) },
    serverTelemetry: {
      metricsFile,
      rowsInWindow: windowRows.length,
      lagP50Ms: percentile(windowRows.map((r) => r.lagP99Ms).sort((a, b) => a - b), 50),
      lagP99Ms: percentile(windowRows.map((r) => r.lagP99Ms).sort((a, b) => a - b), 99),
      lagMaxMs: windowRows.length > 0 ? Math.max(...windowRows.map((r) => r.lagP99Ms)) : null,
      activeTurns: turns,
      heap: heap,
      admissionGate: { latches, rule: '300 ms sustained over two readings, recovery < 150 ms (B2)' },
      spikeMinutesInWindow: { count: spikes.count, minutes: spikes.minutes, maxSpikeMs: spikes.maxSpikeMs },
    },
    cleanup: { corpusSessions: corpus.length, deleted, deleteErrors: deleteErrors.slice(0, 10) },
    perSwitch: switches,
  };
  writeFileSync(outPath, `${JSON.stringify(result, null, 1)}\n`);
  console.log(JSON.stringify({
    switches: result.switches,
    probes: result.probes,
    lag: { p50: result.serverTelemetry.lagP50Ms, p99: result.serverTelemetry.lagP99Ms, max: result.serverTelemetry.lagMaxMs },
    activeTurns: turns,
    latches: latches.length,
    spikeMinutes: spikes.count,
    cleanup: result.cleanup,
    out: outPath,
  }, null, 1));
}

run().catch((error) => {
  console.error('[h1-burst] Fatal:', error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
