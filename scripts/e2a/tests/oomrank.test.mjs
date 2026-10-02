// E2a-3 harness tests — OOM victim-ranking logic (arm 2a) and memory.events parsing (arm 2b).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankCandidates, pickVictim, parseOomScoreFile, parseMemoryEvents, interpretOomProof } from '../lib/oomrank.mjs';

test('parseOomScoreFile trims and integer-parses', () => {
  assert.equal(parseOomScoreFile(' 42\n'), 42);
  assert.equal(parseOomScoreFile('0'), 0);
  assert.throws(() => parseOomScoreFile(''), Error);
  assert.throws(() => parseOomScoreFile('x'), Error);
});

test('rankCandidates sorts by oomScore desc, tie-broken by oomScoreAdj desc', () => {
  const ranked = rankCandidates([
    { name: 'server', pid: 1, oomScore: 20, oomScoreAdj: -500 },
    { name: 'tool', pid: 2, oomScore: 200, oomScoreAdj: 0 },
    { name: 'docker', pid: 3, oomScore: 200, oomScoreAdj: 0 },
    { name: 'anchor-sup', pid: 4, oomScore: 0, oomScoreAdj: -1000 },
    { name: 'alloc', pid: 5, oomScore: 500, oomScoreAdj: 0 },
  ]);
  assert.deepEqual(ranked.map((r) => r.name), ['alloc', 'tool', 'docker', 'server', 'anchor-sup']);
  assert.equal(pickVictim(ranked).name, 'alloc');
});

test('rankCandidates does not mutate its input', () => {
  const input = [{ name: 'b', pid: 2, oomScore: 2, oomScoreAdj: 0 }, { name: 'a', pid: 1, oomScore: 9, oomScoreAdj: 0 }];
  const snapshot = JSON.stringify(input);
  rankCandidates(input);
  assert.equal(JSON.stringify(input), snapshot);
});

test('parseMemoryEvents reads the cgroup v2 events file', () => {
  const ev = parseMemoryEvents('high 0\nmax 2\noom 1\noom_kill 3\n');
  assert.deepEqual(ev, { high: 0, max: 2, oom: 1, oom_kill: 3 });
});

test('interpretOomProof: kernel kills the 0-score allocator, -500 survives, unit stays active', () => {
  const v = interpretOomProof({
    lowAdjProcessAlive: true,
    zeroAdjProcessExitCode: 137,
    unitOomKills: 1,
    unitActiveAfter: true,
  });
  assert.equal(v.pass, true);
  assert.deepEqual(v.failures, []);
});

test('interpretOomProof: wrong victim or dead unit fails with named reasons', () => {
  const v1 = interpretOomProof({ lowAdjProcessAlive: false, zeroAdjProcessExitCode: 0, unitOomKills: 0, unitActiveAfter: true });
  assert.equal(v1.pass, false);
  assert.ok(v1.failures.some((f) => /-500/.test(f)));
  const v2 = interpretOomProof({ lowAdjProcessAlive: true, zeroAdjProcessExitCode: 137, unitOomKills: 1, unitActiveAfter: false });
  assert.equal(v2.pass, false);
  assert.ok(v2.failures.some((f) => /unit not active/i.test(f)));
  const v3 = interpretOomProof({ lowAdjProcessAlive: true, zeroAdjProcessExitCode: 137, unitOomKills: 0, unitActiveAfter: true });
  assert.equal(v3.pass, false);
  assert.ok(v3.failures.some((f) => /oom_kill/i.test(f)));
});
