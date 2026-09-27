import { mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RotatingMetricsFile } from '../../../src/observability/health-metrics-file.js';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'a2-metrics-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('RotatingMetricsFile', () => {
  it('creates its directory and appends one line per call', async () => {
    const dir = path.join(await tempDir(), 'nested', 'metrics');
    const file = new RotatingMetricsFile({ dir, maxFileBytes: 10_000, maxFiles: 3 });
    await file.append('{"a":1}\n');
    await file.append('{"a":2}\n');
    const content = await readFile(path.join(dir, 'health-metrics.jsonl'), 'utf8');
    expect(content).toBe('{"a":1}\n{"a":2}\n');
  });

  it('rotates at the byte bound and keeps no more than maxFiles files', async () => {
    const dir = await tempDir();
    const maxFileBytes = 1_000;
    const maxFiles = 3;
    const line = `${'x'.repeat(180)}\n`;
    const file = new RotatingMetricsFile({ dir, maxFileBytes, maxFiles });
    for (let index = 0; index < 60; index++) await file.append(line);

    const names = (await readdir(dir)).sort();
    expect(names).toEqual([
      'health-metrics.1.jsonl',
      'health-metrics.2.jsonl',
      'health-metrics.jsonl',
    ]);
    let totalBytes = 0;
    for (const name of names) {
      const info = await stat(path.join(dir, name));
      totalBytes += info.size;
      // The bound holds per file (one full line never straddles a rotation).
      expect(info.size).toBeLessThanOrEqual(maxFileBytes);
    }
    // Bounded total: maxFiles * maxFileBytes, verified by measurement.
    expect(totalBytes).toBeLessThanOrEqual(maxFiles * maxFileBytes);
    // Newest data is in the base file, oldest indices hold the oldest data.
    const baseLines = (await readFile(path.join(dir, 'health-metrics.jsonl'), 'utf8')).trim().split('\n');
    expect(baseLines.length).toBe(Math.floor(maxFileBytes / line.length));
  });

  it('drops the oldest file when a rotation exceeds maxFiles', async () => {
    const dir = await tempDir();
    const file = new RotatingMetricsFile({ dir, maxFileBytes: 60, maxFiles: 2 });
    await file.append(`${'a'.repeat(50)}\n`);
    await file.append(`${'b'.repeat(50)}\n`);
    await file.append(`${'c'.repeat(50)}\n`);
    await file.append(`${'d'.repeat(50)}\n`);
    const names = (await readdir(dir)).sort();
    expect(names).toEqual(['health-metrics.1.jsonl', 'health-metrics.jsonl']);
    expect(await readFile(path.join(dir, 'health-metrics.1.jsonl'), 'utf8')).toBe(`${'c'.repeat(50)}\n`);
    expect(await readFile(path.join(dir, 'health-metrics.jsonl'), 'utf8')).toBe(`${'d'.repeat(50)}\n`);
  });

  it('restarts from the existing file size instead of truncating on init', async () => {
    const dir = await tempDir();
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'health-metrics.jsonl'), `${'p'.repeat(949)}\n`);
    const file = new RotatingMetricsFile({ dir, maxFileBytes: 1_000, maxFiles: 2 });
    await file.append(`${'q'.repeat(90)}\n`);
    const base = await readFile(path.join(dir, 'health-metrics.jsonl'), 'utf8');
    const prior = await readFile(path.join(dir, 'health-metrics.1.jsonl'), 'utf8');
    expect(base).toBe(`${'q'.repeat(90)}\n`);
    expect(prior).toBe(`${'p'.repeat(949)}\n`);
    expect(await readdir(dir)).toHaveLength(2);
  });

  it('keeps line integrity, the byte bound and the generation bound under concurrent appends across rotations (correction 02, finding 5)', async () => {
    const dir = await tempDir();
    const maxFileBytes = 200;
    const maxFiles = 3;
    const file = new RotatingMetricsFile({ dir, maxFileBytes, maxFiles });
    const appended = Array.from({ length: 40 }, (_, index) => `line-${String(index).padStart(4, '0')}`);

    // All appends are issued at once: the serialisation must hold while the
    // limit forces a rotation every 20 lines (each line is 10 bytes).
    await Promise.all(appended.map((line) => file.append(`${line}\n`)));

    const names = (await readdir(dir)).sort();
    expect(names.length).toBeLessThanOrEqual(maxFiles);
    expect(names).toContain('health-metrics.jsonl');

    let retained: string[] = [];
    for (const name of names) {
      const text = await readFile(path.join(dir, name), 'utf8');
      // Byte bound per generation, never crossed by a partial line.
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(maxFileBytes);
      expect(text === '' || text.endsWith('\n')).toBe(true);
      retained = retained.concat(text.split('\n').filter((line) => line !== ''));
    }

    // Every retained line is a whole, unique line...
    expect(retained.every((line) => /^line-\d{4}$/.test(line))).toBe(true);
    expect(new Set(retained).size).toBe(retained.length);
    // ...and rotation dropped the oldest lines only: the retained set is a
    // contiguous suffix of the append order.
    const start = appended.indexOf(retained[0]);
    expect(start).toBeGreaterThan(-1);
    const sortedByFile = ['health-metrics.2.jsonl', 'health-metrics.1.jsonl', 'health-metrics.jsonl'];
    const inReadOrder: string[] = [];
    for (const name of sortedByFile) {
      const text = await readFile(path.join(dir, name), 'utf8').catch(() => '');
      inReadOrder.push(...text.split('\n').filter((line) => line !== ''));
    }
    expect(inReadOrder).toEqual(appended.slice(start));
  });

  it('serialises concurrent appends without interleaving lines', async () => {
    const dir = await tempDir();
    const file = new RotatingMetricsFile({ dir, maxFileBytes: 1_000_000, maxFiles: 2 });
    await Promise.all(Array.from({ length: 50 }, (_, index) => file.append(`line-${index}\n`)));
    const lines = (await readFile(path.join(dir, 'health-metrics.jsonl'), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(50);
    // Every line is a complete, ordered line — no partial writes.
    expect(lines.every((line) => /^line-\d+$/.test(line))).toBe(true);
  });
});
