/**
 * E2a-5 harness unit tests — the pure logic the arms depend on, tested with
 * node:test (no repo test-config coupling: this lane adds no product code).
 *
 * Run: node --test scripts/e2a-rerun/harness.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  percentile, windowStats, replayLatch, doubledFirstChunkVerdict, hb4VerdictOk, parseArgs,
  writeSeedTargets, classifyResidency, coldOnlyPercentiles, verifyCredentialSweep, cleanupRunOwnedDirs,
  seedPrebootOrderOk,
} from './lib.mjs';

const rd = (atMs, lagP99Ms, extra = {}) => ({ atMs, at: new Date(atMs).toISOString(), lagP99Ms, lagP50Ms: Math.round(lagP99Ms / 2), lagMaxMs: lagP99Ms, activeTurns: 0, lagSampleCount: 100, ...extra });

test('percentile is nearest-rank ceil', () => {
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2);
  assert.equal(percentile([1, 2, 3, 4], 0.99), 4);
  assert.equal(percentile([10], 0.5), 10);
  assert.equal(percentile([], 0.5), null);
});

test('windowStats filters by window and reports lag + activeTurns', () => {
  const readings = [
    rd(1000, 50, { activeTurns: 0 }),
    rd(2000, 200, { activeTurns: 2 }),
    rd(3000, 400, { activeTurns: 2 }),
    rd(4000, 100, { activeTurns: 1 }),
    rd(90_000, 999, { activeTurns: 0 }), // outside the window
  ];
  const s = windowStats(readings, 1500, 5000);
  assert.equal(s.readingCount, 3);
  assert.equal(s.lagP50.n, 3);
  assert.deepEqual(s.lagP50, { p50: 100, p99: 200, max: 200, n: 3 });
  assert.deepEqual(s.lagP99, { p50: 200, p99: 400, max: 400, n: 3 });
  assert.equal(s.peakActiveTurns, 2);
  assert.equal(s.activeTurnsSamples.length, 3);
});

test('replayLatch: 2 consecutive readings at/above 300 latch; recovery below 150', () => {
  const readings = [rd(1000, 100), rd(2000, 310), rd(3000, 320), rd(4000, 140), rd(5000, 100)];
  const r = replayLatch(readings);
  assert.equal(r.latched, false, 'latched must clear after recovery');
  assert.ok(r.trace[2].latched, 'latched at the second ≥300 reading');
  assert.ok(!r.trace[4].latched, 'recovered below 150');
});

test('replayLatch: a single ≥300 reading does not latch', () => {
  const r = replayLatch([rd(1000, 100), rd(2000, 450), rd(3000, 100)]);
  assert.equal(r.latched, false);
  assert.equal(r.trace[1].latched, false);
});

test('replayLatch: stale gap resets the sustained counter', () => {
  const r = replayLatch([rd(1000, 310), rd(200_000, 310)]);
  assert.equal(r.trace[1].consecutive, 1, 'gap > 75 s resets the counter');
});

test('doubledFirstChunkVerdict: clean render passes, doubled prefix fails', () => {
  const clean = doubledFirstChunkVerdict({ renderedText: 'prefix A5HB2-LIVE-1 suffix', transcriptText: 'A5HB2-LIVE-1' });
  assert.equal(clean.ok, true);
  const doubled = doubledFirstChunkVerdict({ renderedText: 'AA5HB2-LIVE-1 more', transcriptText: 'A5HB2-LIVE-1' });
  assert.equal(doubled.ok, false);
  assert.equal(doubled.doubledFound, true);
  const missing = doubledFirstChunkVerdict({ renderedText: 'unrelated', transcriptText: 'A5HB2-LIVE-1' });
  assert.equal(missing.ok, false);
});

test('hb4VerdictOk encodes the two claims', () => {
  assert.equal(hb4VerdictOk('1-page-cache', { verdict: 'admitted' }), true);
  assert.equal(hb4VerdictOk('1-page-cache', { verdict: 'refused(memory_pressure)' }), false);
  assert.equal(hb4VerdictOk('2-anon', { verdict: 'refused(memory_pressure)', reason: 'memory_pressure' }), true);
  assert.equal(hb4VerdictOk('2-anon', { verdict: 'refused(turn_slots)', reason: 'turn_slots' }), false);
  assert.equal(hb4VerdictOk('2-anon', { verdict: 'admitted' }), false);
});

test('parseArgs handles --key=value and bare flags', () => {
  const a = parseArgs(['--run-dir=/tmp/x', '--smoke', '--count=66']);
  assert.deepEqual(a, { 'run-dir': '/tmp/x', smoke: 'true', count: '66' });
});

// ── correction 04 item 1: cold targets ─────────────────────────────────────
test('writeSeedTargets produces offline, non-resident, real-shaped targets', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'a5seed-'));
  const sessionsDir = path.join(tmp, 'pi-sessions');
  const registryPath = path.join(tmp, 'session-registry.json');
  const out = writeSeedTargets({
    sessionsDir, registryPath, workspacesRoot: path.join(tmp, 'ws'),
    count: 5, messages: 3, nowMs: Date.now(),
  });
  // structural non-residency: the seeding core takes no socket/endpoint — it
  // cannot have materialised an agent; assert its output is files + registry
  assert.equal(out.length, 5);
  for (const t of out) {
    assert.ok(t.sessionPath.startsWith(sessionsDir + '/'), 'target is a file path under pi-sessions');
    assert.ok(fs.existsSync(t.sessionPath), 'seed file exists on disk');
    const lines = fs.readFileSync(t.sessionPath, 'utf8').trim().split('\n');
    const header = JSON.parse(lines[0]);
    assert.equal(header.type, 'session');
    assert.ok(t.sessionPath.endsWith(`_${header.id}.jsonl`), 'filename carries the header id (H1 shape)');
    assert.equal(lines.length, 1 + 3, 'header + messages');
  }
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  assert.equal(registry.entries.length, 5);
  for (const e of registry.entries) assert.ok(fs.existsSync(e.path));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('classifyResidency marks every target from server evidence only', () => {
  const targets = [
    { sessionPath: '/run/pi-sessions/a.jsonl' },
    { sessionPath: '/run/pi-sessions/b.jsonl' },
    { sessionPath: '/run/pi-sessions/c.jsonl' },
  ];
  const all = classifyResidency(targets, new Set());
  assert.deepEqual(all.map((t) => t.resident), [false, false, false]);
  const some = classifyResidency(targets, new Set(['/run/pi-sessions/b.jsonl']));
  assert.deepEqual(some.map((t) => t.resident), [false, true, false]);
});

test('coldOnlyPercentiles computes over non-resident switches only', () => {
  const switches = [
    { wallMs: 10, targetResident: false },
    { wallMs: 20, targetResident: true },
    { wallMs: 30, targetResident: false },
    { wallMs: 400, targetResident: false },
  ];
  const cold = coldOnlyPercentiles(switches);
  assert.equal(cold.coldCount, 3);
  assert.equal(cold.p50, 30);
  assert.equal(cold.p99, 400);
  assert.equal(cold.excludedResident, 1);
  const none = coldOnlyPercentiles([{ wallMs: 5, targetResident: true }]);
  assert.equal(none.coldCount, 0);
  assert.equal(none.p50, null);
});

test('seedPrebootOrderOk asserts seed lines precede server ready in the arm log', () => {
  const good = [
    'pre-seed checks: socket absent = yes; e2a-5-h1 inactive = yes',
    'seed: 66 cold target files written OFFLINE pre-boot',
    'seed complete (pre-boot: no socket, no unit — verified above)',
    'starting server unit e2a-5-h1',
    'server ready (build ee660d4f)',
  ].join('\n');
  assert.equal(seedPrebootOrderOk(good).ok, true);
  const lateSeed = [
    'starting server unit e2a-5-h1',
    'server ready (build ee660d4f)',
    'pre-seed checks: socket absent = yes; e2a-5-h1 inactive = yes',
    'seed complete (pre-boot: no socket, no unit — verified above)',
  ].join('\n');
  const bad = seedPrebootOrderOk(lateSeed);
  assert.equal(bad.ok, false);
  const missing = seedPrebootOrderOk('server ready (build ee660d4f)');
  assert.equal(missing.ok, false);
});

// ── correction 04 item 3: hb5 cleanup sweep ─────────────────────────────
test('verifyCredentialSweep finds planted credential files and cleanupRunOwnedDirs removes them', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'a5sweep-'));
  const agentDir = path.join(tmp, 'agent-dir');
  const fakeHome = path.join(tmp, 'fake-home');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(path.join(fakeHome, '.gemini'), { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'auth.json'), '{}');
  fs.writeFileSync(path.join(fakeHome, '.gemini', 'oauth_creds.json'), '{}');
  let remaining = verifyCredentialSweep([tmp]);
  assert.equal(remaining.length, 2, 'both planted copies found before cleanup');
  cleanupRunOwnedDirs([agentDir, fakeHome]);
  remaining = verifyCredentialSweep([tmp]);
  assert.equal(remaining.length, 0, 'sweep clean after cleanup');
  fs.rmSync(tmp, { recursive: true, force: true });
});
