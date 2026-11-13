import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  applyChildOomScoreAdj,
  childOomScoreFilePath,
  CHILD_OOM_SCORE_ADJ,
  resetChildOomScoreAdjWarnings,
} from '../../src/oom-score-adj.js';

/**
 * Lane oom: every child-runtime process the server spawns must lose the
 * control plane's inherited OOMScoreAdjust=-500. The helper writes 0 to
 * /proc/<pid>/oom_score_adj right after spawn; failures are logged once per
 * call site and never fail the spawn.
 */
describe('applyChildOomScoreAdj', () => {
  beforeEach(() => resetChildOomScoreAdjWarnings());
  afterEach(() => resetChildOomScoreAdjWarnings());

  it('writes 0 to /proc/<pid>/oom_score_adj and returns true', () => {
    const writes: Array<{ path: string; value: string }> = [];
    const ok = applyChildOomScoreAdj({ pid: 4321 }, 'site-a', {
      writeScore: (path, value) => { writes.push({ path, value }); },
    });
    expect(ok).toBe(true);
    expect(writes).toEqual([{ path: '/proc/4321/oom_score_adj', value: '0' }]);
  });

  it('exposes the kernel path shape and the shared score constant', () => {
    expect(childOomScoreFilePath(99)).toBe('/proc/99/oom_score_adj');
    expect(CHILD_OOM_SCORE_ADJ).toBe('0');
  });

  it('honours an injected score-file path (test/disposable units)', () => {
    const writes: string[] = [];
    applyChildOomScoreAdj({ pid: 7 }, 'site-a', {
      scoreFilePath: (pid) => `/tmp/fake-proc/${pid}/oom_score_adj`,
      writeScore: (path) => { writes.push(path); },
    });
    expect(writes).toEqual(['/tmp/fake-proc/7/oom_score_adj']);
  });

  it('is a no-op for a missing child or missing pid — never throws, never writes', () => {
    let calls = 0;
    const deps = { writeScore: () => { calls++; } };
    expect(applyChildOomScoreAdj(null, 'site-a', deps)).toBe(false);
    expect(applyChildOomScoreAdj(undefined, 'site-a', deps)).toBe(false);
    expect(applyChildOomScoreAdj({}, 'site-a', deps)).toBe(false);
    expect(applyChildOomScoreAdj({ pid: 0 }, 'site-a', deps)).toBe(false);
    expect(applyChildOomScoreAdj({ pid: -5 }, 'site-a', deps)).toBe(false);
    expect(calls).toBe(0);
  });

  it('fails open: a failed write returns false, warns once, and is not rethrown', () => {
    const warnings: string[] = [];
    const deps = {
      writeScore: () => { throw new Error('ESRCH: no such process'); },
      warn: (m: string) => { warnings.push(m); },
    };
    expect(applyChildOomScoreAdj({ pid: 1 }, 'site-a', deps)).toBe(false);
    expect(applyChildOomScoreAdj({ pid: 1 }, 'site-a', deps)).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('site-a');
  });

  it('logs once per site label — a different site warns again', () => {
    const warnings: string[] = [];
    const deps = {
      writeScore: () => { throw new Error('EACCES'); },
      warn: (m: string) => { warnings.push(m); },
    };
    applyChildOomScoreAdj({ pid: 1 }, 'site-a', deps);
    applyChildOomScoreAdj({ pid: 1 }, 'site-b', deps);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('site-a');
    expect(warnings[1]).toContain('site-b');
  });

  it('resetChildOomScoreAdjWarnings clears the once-per-site latch', () => {
    const warnings: string[] = [];
    const deps = {
      writeScore: () => { throw new Error('EACCES'); },
      warn: (m: string) => { warnings.push(m); },
    };
    applyChildOomScoreAdj({ pid: 1 }, 'site-a', deps);
    resetChildOomScoreAdjWarnings();
    applyChildOomScoreAdj({ pid: 1 }, 'site-a', deps);
    expect(warnings).toHaveLength(2);
  });

  it('real write: a spawned sleep reads oom_score_adj 0', async () => {
    const child = spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      const ok = applyChildOomScoreAdj(child, 'vitest-real');
      expect(ok).toBe(true);
      expect(readFileSync(`/proc/${child.pid}/oom_score_adj`, 'utf8').trim()).toBe('0');
    } finally {
      child.kill('SIGKILL');
    }
  });
});
