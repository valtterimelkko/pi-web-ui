#!/usr/bin/env node
/**
 * Live validation: does a client playback-health record actually reach the
 * server's diagnostics ring through the real, running server?
 *
 * Proves the P13 gap fill end to end against a disposable validation server:
 *   1. password login (cookie auth, the same route the UI uses)
 *   2. POST a `playback_health` lane-end report and a `playback_overflow` fault
 *   3. read them back through the DOCUMENTED Internal API query
 *
 * Usage: node scripts/live-validate-playback-health.mjs --base <http://localhost:PORT> \
 *          --socket <sock> --token-path <token> --password <plain>
 */
import { readFileSync } from 'node:fs';
import http from 'node:http';

function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const BASE = flag('base');
const SOCKET = flag('socket');
const TOKEN_PATH = flag('token-path');
const PASSWORD = flag('password');
const ORIGIN = flag('origin', 'http://localhost:5173');

if (!BASE || !SOCKET || !TOKEN_PATH || !PASSWORD) {
  console.error('usage: --base --socket --token-path --password [--origin]');
  process.exit(2);
}

const TOKEN = readFileSync(TOKEN_PATH, 'utf8').trim();
const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function login() {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error('login returned no cookie');
  return cookie;
}

async function postHealth(cookie, body) {
  const res = await fetch(`${BASE}/api/client-diagnostics`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN, Cookie: cookie },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

/** Internal API over the Unix socket (the operator's documented read path). */
function internalGet(path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: SOCKET, path, method: 'GET', headers: { Authorization: `Bearer ${TOKEN}` } },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => resolve({ status: res.statusCode, raw }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const LANE_END = {
  kind: 'playback_health',
  reason: 'lane_end',
  stats: { chunksScheduled: 48, chunksDropped: 1, pendingChunks: 51, pendingMs: 4500, queuedMs: 120, ducked: false },
  runtime: 'pi',
  workerSessionId: 'live-validation-worker',
  recentEvents: [{ kind: 'speech', operation: 'playback_health', state: 'lane_end' }],
};

const OVERFLOW = {
  kind: 'playback_health',
  reason: 'playback_overflow',
  detail: 'playback backlog exceeded its bound; the oldest unplayed chunk was dropped',
  stats: { chunksScheduled: 99, chunksDropped: 3, pendingChunks: 0, pendingMs: 0, queuedMs: 0, ducked: false },
  runtime: 'pi',
  workerSessionId: 'live-validation-worker',
};

const main = async () => {
  const cookie = await login();
  record('password login returns a cookie', Boolean(cookie));

  const laneEnd = await postHealth(cookie, LANE_END);
  record('lane-end playback_health accepted (204)', laneEnd.status === 204, `status=${laneEnd.status}`);

  const overflow = await postHealth(cookie, OVERFLOW);
  record('fault playback_health accepted (204)', overflow.status === 204, `status=${overflow.status}`);

  const bad = await postHealth(cookie, { kind: 'playback_health', reason: 'lane_end' });
  record('playback_health without stats rejected (400)', bad.status === 400, `status=${bad.status}`);

  const smuggle = await postHealth(cookie, { ...LANE_END, transcript: 'private words' });
  record('unknown field rejected, not stored (400)', smuggle.status === 400, `status=${smuggle.status}`);

  const read = await internalGet('/api/v1/diagnostics?component=ClientVoice&limit=50');
  record('Internal API diagnostics query returns 200', read.status === 200, `status=${read.status}`);
  const body = JSON.parse(read.raw);
  const logs = body.recentLogs ?? body.logs ?? body.records ?? [];
  const health = logs.filter((r) => r.operation === 'playback_health');
  record('both playback-health records landed in the ring', health.length === 2, `found=${health.length}`);

  const laneEndRec = health.find((r) => r.reason === 'lane_end');
  record(
    'lane-end record carries the stranded figure and warn level',
    Boolean(laneEndRec) && laneEndRec.level === 'warn' && laneEndRec.stats?.pendingMs === 4500,
    laneEndRec ? `level=${laneEndRec.level} pendingMs=${laneEndRec.stats?.pendingMs}` : 'missing',
  );
  record(
    'lane-end record carries the worker-session correlation',
    laneEndRec?.workerSessionId === 'live-validation-worker',
    `workerSessionId=${laneEndRec?.workerSessionId}`,
  );

  const overflowRec = health.find((r) => r.reason === 'playback_overflow');
  record(
    'fault record carries its reason and stats',
    Boolean(overflowRec) && overflowRec.stats?.chunksDropped === 3,
    overflowRec ? `chunksDropped=${overflowRec.stats?.chunksDropped}` : 'missing',
  );

  const json = JSON.stringify(logs);
  record('no smuggled transcript content in the ring', !json.includes('private words'));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
};

main().catch((error) => {
  console.error(`ERROR ${error.message}`);
  process.exit(2);
});
