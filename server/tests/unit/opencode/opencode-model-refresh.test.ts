import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {
  buildModelSnapshot,
  diffModelSnapshots,
  readSnapshot,
  writeSnapshot,
  type ModelSnapshot,
} from '../../../src/opencode/opencode-model-refresh.js';

describe('buildModelSnapshot', () => {
  it('groups models by provider and sorts ids', () => {
    const snap = buildModelSnapshot(
      [
        { provider: 'kilo', id: 'zeta' },
        { provider: 'kilo', id: 'alpha' },
        { provider: 'opencode', id: 'free-1' },
      ],
      new Date('2026-01-01T00:00:00.000Z'),
    );
    expect(snap.generatedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(snap.providers.kilo).toEqual(['alpha', 'zeta']);
    expect(snap.providers.opencode).toEqual(['free-1']);
  });

  it('deduplicates repeated model ids within a provider', () => {
    const snap = buildModelSnapshot([
      { provider: 'kilo', id: 'a' },
      { provider: 'kilo', id: 'a' },
    ]);
    expect(snap.providers.kilo).toEqual(['a']);
  });

  it('ignores entries with empty provider or id', () => {
    const snap = buildModelSnapshot([
      { provider: '', id: 'a' },
      { provider: 'kilo', id: '' },
      { provider: 'kilo', id: 'b' },
    ]);
    expect(Object.keys(snap.providers)).toEqual(['kilo']);
    expect(snap.providers.kilo).toEqual(['b']);
  });
});

describe('diffModelSnapshots', () => {
  const base: ModelSnapshot = {
    generatedAt: '2026-01-01T00:00:00.000Z',
    providers: { kilo: ['a', 'b'], opencode: ['free-1'] },
  };

  it('treats everything as added when there is no previous snapshot', () => {
    const diff = diffModelSnapshots(null, base);
    expect(diff.changed).toBe(true);
    expect(diff.addedProviders).toEqual(['kilo', 'opencode']);
    expect(diff.addedModels).toEqual(['kilo/a', 'kilo/b', 'opencode/free-1']);
    expect(diff.removedModels).toEqual([]);
  });

  it('reports no change for identical snapshots', () => {
    const diff = diffModelSnapshots(base, { ...base, generatedAt: 'later' });
    expect(diff.changed).toBe(false);
    expect(diff.addedModels).toEqual([]);
    expect(diff.removedModels).toEqual([]);
  });

  it('detects added and removed models', () => {
    const next: ModelSnapshot = {
      generatedAt: 'x',
      providers: { kilo: ['a', 'c'], opencode: ['free-1'] },
    };
    const diff = diffModelSnapshots(base, next);
    expect(diff.changed).toBe(true);
    expect(diff.addedModels).toEqual(['kilo/c']);
    expect(diff.removedModels).toEqual(['kilo/b']);
    expect(diff.addedProviders).toEqual([]);
  });

  it('detects added and removed providers', () => {
    const next: ModelSnapshot = {
      generatedAt: 'x',
      providers: { kilo: ['a', 'b'], nvidia: ['n1'] },
    };
    const diff = diffModelSnapshots(base, next);
    expect(diff.addedProviders).toEqual(['nvidia']);
    expect(diff.removedProviders).toEqual(['opencode']);
    expect(diff.addedModels).toEqual(['nvidia/n1']);
    expect(diff.removedModels).toEqual(['opencode/free-1']);
  });
});

describe('readSnapshot / writeSnapshot', () => {
  let tmpDir: string;
  let snapPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-snap-'));
    snapPath = path.join(tmpDir, 'nested', 'snapshot.json');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('returns null when the file is missing', async () => {
    expect(await readSnapshot(snapPath)).toBeNull();
  });

  it('returns null when the file is not valid JSON', async () => {
    await fs.mkdir(path.dirname(snapPath), { recursive: true });
    await fs.writeFile(snapPath, 'not json', 'utf-8');
    expect(await readSnapshot(snapPath)).toBeNull();
  });

  it('round-trips a snapshot and creates parent dirs', async () => {
    const snap: ModelSnapshot = {
      generatedAt: '2026-01-01T00:00:00.000Z',
      providers: { kilo: ['a', 'b'] },
    };
    await writeSnapshot(snapPath, snap);
    expect(await readSnapshot(snapPath)).toEqual(snap);
  });
});
