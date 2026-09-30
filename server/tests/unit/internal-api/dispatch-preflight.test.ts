/**
 * C4 dispatch preflight (contract 1.53.0): unit tests for the standalone check
 * module. The module performs existence/writability/executability probes only —
 * no reads beyond existence, no child processes, no provider calls.
 *
 * Injected fs and PATH cover the cases the host cannot express (this host's
 * server user is root, so mode bits never make access(W_OK) fail) and keep the
 * tests hermetic.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  formatPreflightProblem,
  preflightSpecSchema,
  runDispatchPreflight,
  type PreflightFailure,
  type PreflightFs,
} from '../../../src/internal-api/dispatch-preflight.js';

describe('C4 dispatch preflight — schema (preflightSpecSchema)', () => {
  it('accepts an empty spec and paths/tools within bounds', () => {
    expect(preflightSpecSchema.safeParse({}).success).toBe(true);
    expect(
      preflightSpecSchema.safeParse({ paths: ['/root', '/etc/hostname'], tools: ['bash', 'node'] }).success,
    ).toBe(true);
  });

  it('rejects unknown keys (strict)', () => {
    expect(preflightSpecSchema.safeParse({ cwd: '/root' }).success).toBe(false);
  });

  it('rejects relative referenced paths', () => {
    const parsed = preflightSpecSchema.safeParse({ paths: ['relative/path'] });
    expect(parsed.success).toBe(false);
  });

  it('rejects path entries that are not strings and over-bounded arrays', () => {
    expect(preflightSpecSchema.safeParse({ paths: [42] }).success).toBe(false);
    expect(preflightSpecSchema.safeParse({ paths: Array.from({ length: 33 }, (_, i) => `/p${i}`) }).success).toBe(false);
    expect(preflightSpecSchema.safeParse({ tools: Array.from({ length: 33 }, (_, i) => `t${i}`) }).success).toBe(false);
  });

  it('rejects tool names that are not bare names (no separators, no traversal)', () => {
    expect(preflightSpecSchema.safeParse({ tools: ['/bin/sh'] }).success).toBe(false);
    expect(preflightSpecSchema.safeParse({ tools: ['../sh'] }).success).toBe(false);
    expect(preflightSpecSchema.safeParse({ tools: ['a/b'] }).success).toBe(false);
    expect(preflightSpecSchema.safeParse({ tools: [''] }).success).toBe(false);
  });
});

describe('C4 dispatch preflight — cwd check', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'c4-preflight-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  it('passing cwd (exists, is a directory, writable) yields ok', async () => {
    const report = await runDispatchPreflight({ cwd: dir });
    expect(report.ok).toBe(true);
    expect(report.failures).toEqual([]);
  });

  it('missing cwd is reported', async () => {
    const missing = path.join(dir, 'does-not-exist');
    const report = await runDispatchPreflight({ cwd: missing });
    expect(report.ok).toBe(false);
    expect(report.failures).toEqual([
      { kind: 'cwd', item: missing, problem: 'does not exist' },
    ] satisfies PreflightFailure[]);
  });

  it('cwd that is a file is reported', async () => {
    const file = path.join(dir, 'plain-file');
    await fs.writeFile(file, 'x');
    const report = await runDispatchPreflight({ cwd: file });
    expect(report.ok).toBe(false);
    expect(report.failures).toEqual([
      { kind: 'cwd', item: file, problem: 'not a directory' },
    ] satisfies PreflightFailure[]);
  });

  it('unwritable cwd is reported (injected fs; root ignores mode bits, so simulate)', async () => {
    const realFs = await import('node:fs/promises');
    const report = await runDispatchPreflight({
      cwd: dir,
      fs: {
        stat: realFs.stat,
        access: async (p: string, mode: number) => {
          if (mode === realFs.constants.W_OK) {
            throw Object.assign(new Error('EACCES: permission denied, access'), { code: 'EACCES' });
          }
          return realFs.access(p, mode);
        },
      },
    });
    expect(report.ok).toBe(false);
    expect(report.failures).toEqual([
      { kind: 'cwd', item: dir, problem: 'not writable by the server user' },
    ] satisfies PreflightFailure[]);
  });

  it('a stat throw other than ENOENT is reported as unreadable, not crashing', async () => {
    const realFs = await import('node:fs/promises');
    const report = await runDispatchPreflight({
      cwd: dir,
      fs: {
        stat: async () => {
          throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        },
        access: realFs.access,
      },
    });
    expect(report.ok).toBe(false);
    expect(report.failures[0]).toEqual({ kind: 'cwd', item: dir, problem: 'not accessible' } satisfies PreflightFailure);
  });
});

describe('C4 dispatch preflight — referenced paths check (existence only)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'c4-preflight-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  it('existing file and directory pass; missing path is listed', async () => {
    const file = path.join(dir, 'note.md');
    await fs.writeFile(file, 'x');
    const sub = path.join(dir, 'sub');
    await fs.mkdir(sub);
    const missing = path.join(dir, 'missing.bin');
    const report = await runDispatchPreflight({ paths: [file, sub, missing] });
    expect(report.ok).toBe(false);
    expect(report.failures).toEqual([
      { kind: 'path', item: missing, problem: 'does not exist' },
    ] satisfies PreflightFailure[]);
  });

  it('every missing path is listed (no first-failure short circuit)', async () => {
    const a = path.join(dir, 'a');
    const b = path.join(dir, 'b');
    const report = await runDispatchPreflight({ paths: [a, b] });
    expect(report.failures.map((f) => f.item).sort()).toEqual([a, b].sort());
  });

  it('a dangling symlink counts as missing (existence follows the target)', async () => {
    const dangling = path.join(dir, 'dangling');
    await fs.symlink(path.join(dir, 'nope-target'), dangling);
    const report = await runDispatchPreflight({ paths: [dangling] });
    expect(report.ok).toBe(false);
    expect(report.failures[0]?.kind).toBe('path');
  });
});

describe('C4 dispatch preflight — tool check (bare name on PATH the runtime will see)', () => {
  let dir: string;
  let binDir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'c4-preflight-'));
    binDir = path.join(dir, 'bin');
    await fs.mkdir(binDir);
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  it('an executable file on the given PATH resolves', async () => {
    const tool = path.join(binDir, 'fake-tool');
    await fs.writeFile(tool, '#!/bin/sh\n', { mode: 0o755 });
    const report = await runDispatchPreflight({ tools: ['fake-tool'], pathEnv: binDir });
    expect(report.ok).toBe(true);
  });

  it('a name not on PATH is reported', async () => {
    const report = await runDispatchPreflight({ tools: ['c4-no-such-tool'], pathEnv: binDir });
    expect(report.ok).toBe(false);
    expect(report.failures).toEqual([
      { kind: 'tool', item: 'c4-no-such-tool', problem: 'not found on PATH' },
    ] satisfies PreflightFailure[]);
  });

  it('a non-executable file on PATH does not count', async () => {
    await fs.writeFile(path.join(binDir, 'lame-tool'), 'x', { mode: 0o644 });
    const report = await runDispatchPreflight({ tools: ['lame-tool'], pathEnv: binDir });
    expect(report.ok).toBe(false);
    expect(report.failures[0]?.kind).toBe('tool');
  });

  it('a directory on PATH named like the tool does not count', async () => {
    await fs.mkdir(path.join(binDir, 'dir-tool'));
    const report = await runDispatchPreflight({ tools: ['dir-tool'], pathEnv: binDir });
    expect(report.ok).toBe(false);
  });

  it('empty PATH directories are skipped without failing the lookup', async () => {
    const tool = path.join(binDir, 'ok-tool');
    await fs.writeFile(tool, '#!/bin/sh\n', { mode: 0o755 });
    const report = await runDispatchPreflight({ tools: ['ok-tool'], pathEnv: `:${binDir}::` });
    expect(report.ok).toBe(true);
  });

  it('first matching directory wins (earliest entry on PATH)', async () => {
    const binA = path.join(dir, 'bin-a');
    const binB = path.join(dir, 'bin-b');
    await fs.mkdir(binA);
    await fs.mkdir(binB);
    await fs.writeFile(path.join(binB, 'dup-tool'), '#!/bin/sh\n', { mode: 0o755 });
    // PATH is binA alone: binB's copy must not be found.
    const report = await runDispatchPreflight({ tools: ['dup-tool'], pathEnv: binA });
    expect(report.ok).toBe(false);
    await fs.writeFile(path.join(binA, 'dup-tool'), '#!/bin/sh\n', { mode: 0o755 });
    const ok = await runDispatchPreflight({ tools: ['dup-tool'], pathEnv: `${binA}:${binB}` });
    expect(ok.ok).toBe(true); // first matching directory (binA) wins
  });

  it('an unreadable PATH entry (EACCES) is skipped like a missing one, and preflight never throws', async () => {
    const realFs = await import('node:fs/promises');
    const locked = path.join(dir, 'locked-bin'); // never touched: the injected fs denies it
    const deniedFs: PreflightFs = {
      stat: async (p: string) => {
        if (p.startsWith(locked)) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        return realFs.stat(p);
      },
      access: async (p: string, mode: number) => {
        if (p.startsWith(locked)) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        return realFs.access(p, mode);
      },
    };
    const tool = path.join(binDir, 'after-locked');
    await fs.writeFile(tool, '#!/bin/sh\n', { mode: 0o755 });

    // The unreadable entry is skipped; the later entry still resolves.
    const report = await runDispatchPreflight({ tools: ['after-locked'], pathEnv: `${locked}:${binDir}`, fs: deniedFs });
    expect(report.ok).toBe(true);

    // A name that exists nowhere is a normal failure — the error never escapes.
    const refused = await runDispatchPreflight({ tools: ['c4-no-such-tool'], pathEnv: `${locked}:${binDir}`, fs: deniedFs });
    expect(refused.ok).toBe(false);
    expect(refused.failures).toEqual([
      { kind: 'tool', item: 'c4-no-such-tool', problem: 'not found on PATH' },
    ] satisfies PreflightFailure[]);

    // A file that exists but whose executable probe errors is skipped too.
    const deniedAccessFs: PreflightFs = {
      stat: realFs.stat,
      access: async (p: string, mode: number) => {
        if (p === path.join(binDir, 'denied-access')) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        return realFs.access(p, mode);
      },
    };
    await fs.writeFile(path.join(binDir, 'denied-access'), '#!/bin/sh\n', { mode: 0o755 });
    const denied = await runDispatchPreflight({ tools: ['denied-access'], pathEnv: binDir, fs: deniedAccessFs });
    expect(denied.ok).toBe(false);
    expect(denied.failures[0]).toEqual({ kind: 'tool', item: 'denied-access', problem: 'not found on PATH' });
  });

  it('an erroring PATH entry (EIO on stat) is skipped without aborting the scan', async () => {
    const realFs = await import('node:fs/promises');
    const broken = path.join(dir, 'broken-bin');
    const brokenFs: PreflightFs = {
      stat: async (p: string) => {
        if (p.startsWith(broken)) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
        return realFs.stat(p);
      },
      access: realFs.access,
    };
    const tool = path.join(binDir, 'after-broken');
    await fs.writeFile(tool, '#!/bin/sh\n', { mode: 0o755 });
    const report = await runDispatchPreflight({ tools: ['after-broken'], pathEnv: `${broken}:${binDir}`, fs: brokenFs });
    expect(report.ok).toBe(true);
  });
});

describe('C4 dispatch preflight — aggregation and formatting', () => {
  it('reports every failing kind together (cwd + path + tool)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'c4-preflight-'));
    try {
      const missingPath = path.join(dir, 'nope');
      const report = await runDispatchPreflight({
        cwd: path.join(dir, 'no-cwd'),
        paths: [missingPath],
        tools: ['c4-none'],
        pathEnv: path.join(dir, 'empty-bin'),
      });
      expect(report.ok).toBe(false);
      const kinds = report.failures.map((f) => f.kind).sort();
      expect(kinds).toEqual(['cwd', 'path', 'tool']);
      const line = formatPreflightProblem(report);
      expect(line).toContain('no-cwd');
      expect(line).toContain('nope');
      expect(line).toContain('c4-none');
    } finally {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
    }
  });

  it('an all-green spec with cwd and items reports ok', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'c4-preflight-'));
    try {
      const file = path.join(dir, 'f');
      await fs.writeFile(file, 'x');
      const bin = path.join(dir, 'bin');
      await fs.mkdir(bin);
      await fs.writeFile(path.join(bin, 'sh-like'), '#!/bin/sh\n', { mode: 0o755 });
      const report = await runDispatchPreflight({ cwd: dir, paths: [file], tools: ['sh-like'], pathEnv: bin });
      expect(report).toEqual({ ok: true, failures: [] });
    } finally {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
    }
  });
});
