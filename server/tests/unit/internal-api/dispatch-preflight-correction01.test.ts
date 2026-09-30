/**
 * C4 correction 01 — runtime PATH, regular-file tools, deterministic order.
 * Appended to the module suite; each test names the correction item it closes.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import net from 'net';
import os from 'os';
import path from 'path';
import { execSync } from 'node:child_process';
import {
  runDispatchPreflight,
  runtimeChildPathEnv,
  type PreflightFs,
} from '../../../src/internal-api/dispatch-preflight.js';

describe('C4 correction 01 — runtime PATH (item 1)', () => {
  it('antigravity children see /root/.local/bin prepended (mirror of antigravity-service.ts:76)', () => {
    expect(runtimeChildPathEnv('antigravity', '/usr/bin:/bin')).toBe('/root/.local/bin:/usr/bin:/bin');
  });

  it('pi, claude, opencode and commandcode children see the server PATH unchanged', () => {
    for (const runtime of ['pi', 'claude', 'opencode', 'commandcode'] as const) {
      expect(runtimeChildPathEnv(runtime, '/usr/bin:/bin')).toBe('/usr/bin:/bin');
    }
  });

  it('falls back to the live process PATH when no override is passed', () => {
    expect(runtimeChildPathEnv('pi')).toBe(process.env.PATH ?? '');
    expect(runtimeChildPathEnv('antigravity')).toBe(`/root/.local/bin:${process.env.PATH ?? ''}`);
  });

  it('a tool present only via the antigravity prepend resolves for antigravity and fails for pi', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'c4-corr1-'));
    try {
      // The host fact the prepend exists for: the agy CLI lives in
      // /root/.local/bin. Simulate it through the injectable fs so this test
      // runs on hosts (and CI runners) without the agy CLI; the PATH
      // composition under test (runtimeChildPathEnv) stays real.
      const prepended = '/root/.local/bin/agy';
      const realFs = await import('node:fs/promises');
      const hostWithAgy: PreflightFs = {
        stat: async (p) => {
          if (p === prepended) return { isDirectory: () => false, isFile: () => true };
          return realFs.stat(p);
        },
        access: async (p, mode) => {
          if (p === prepended && mode === realFs.constants.X_OK) return;
          return realFs.access(p, mode);
        },
      };
      // Server PATH that resolves nothing (nonexistent dir), so the only way
      // 'agy' resolves is through the antigravity prepend.
      const serverPath = path.join(dir, 'resolves-nothing');
      const ok = await runDispatchPreflight({ tools: ['agy'], pathEnv: runtimeChildPathEnv('antigravity', serverPath), fs: hostWithAgy });
      expect(ok.ok).toBe(true);
      const refused = await runDispatchPreflight({ tools: ['agy'], pathEnv: runtimeChildPathEnv('pi', serverPath), fs: hostWithAgy });
      expect(refused.ok).toBe(false);
      expect(refused.failures[0]).toEqual({ kind: 'tool', item: 'agy', problem: 'not found on PATH' });
    } finally {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
    }
  });
});

describe('C4 correction 01 — regular files only (item 2)', () => {
  let dir: string;
  let binDir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'c4-corr2-'));
    binDir = path.join(dir, 'bin');
    await fs.mkdir(binDir);
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  it('a FIFO on PATH (even executable) is not a usable tool', async () => {
    const fifo = path.join(binDir, 'fifo-tool');
    execSync(`mkfifo '${fifo}'`);
    await fs.chmod(fifo, 0o755);
    const report = await runDispatchPreflight({ tools: ['fifo-tool'], pathEnv: binDir });
    expect(report.ok).toBe(false);
    expect(report.failures[0]).toEqual({ kind: 'tool', item: 'fifo-tool', problem: 'not found on PATH' });
  });

  it('a unix socket on PATH is not a usable tool', async () => {
    const sockPath = path.join(binDir, 'sock-tool');
    const server = net.createServer(() => undefined);
    await new Promise<void>((resolve) => server.listen(sockPath, () => resolve()));
    try {
      await fs.chmod(sockPath, 0o755);
      const report = await runDispatchPreflight({ tools: ['sock-tool'], pathEnv: binDir });
      expect(report.ok).toBe(false);
      expect(report.failures[0]?.item).toBe('sock-tool');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('PreflightFs implementations must expose isFile (contract of the injected fs)', async () => {
    // The injected fs is required to answer isFile(); a probe that cannot
    // confirm a regular file must not pass the tool check.
    const realFs = await import('node:fs/promises');
    const tool = path.join(binDir, 'real-tool');
    await fs.writeFile(tool, '#!/bin/sh\n', { mode: 0o755 });
    const fsWithoutIsFile: PreflightFs = {
      stat: async (p) => {
        const st = await realFs.stat(p);
        return { isDirectory: () => st.isDirectory() };
      },
      access: realFs.access,
    };
    const report = await runDispatchPreflight({ tools: ['real-tool'], pathEnv: binDir, fs: fsWithoutIsFile });
    expect(report.ok).toBe(false);
    const ok = await runDispatchPreflight({ tools: ['real-tool'], pathEnv: binDir });
    expect(ok.ok).toBe(true);
  });
});

describe('C4 correction 01 — deterministic report order (item 3)', () => {
  it('failures come back in input order even when the first probe is the slowest', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'c4-corr3-'));
    try {
      const slow = path.join(dir, '0-slow-missing');
      const fast = path.join(dir, '1-fast-missing');
      const realFs = await import('node:fs/promises');
      const delayingFs: PreflightFs = {
        stat: (p) => new Promise((resolve, reject) => {
          setTimeout(() => realFs.stat(p).then(resolve, reject), 25);
        }),
        access: async (p, mode) => {
          if (p === slow) await new Promise((r) => setTimeout(r, 25));
          return realFs.access(p, mode);
        },
      };
      const report = await runDispatchPreflight({ paths: [slow, fast], fs: delayingFs });
      expect(report.ok).toBe(false);
      expect(report.failures.map((f) => f.item)).toEqual([slow, fast]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
    }
  });

  it('tool failures also keep input order under delay', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'c4-corr3-'));
    try {
      const bin = path.join(dir, 'bin');
      await fs.mkdir(bin);
      const report = await runDispatchPreflight({ tools: ['zzz-first', 'aaa-second'], pathEnv: bin });
      expect(report.failures.map((f) => f.item)).toEqual(['zzz-first', 'aaa-second']);
    } finally {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
    }
  });
});
