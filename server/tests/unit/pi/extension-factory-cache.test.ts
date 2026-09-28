import { describe, it, expect, vi } from 'vitest';
import {
  ExtensionFactoryCache,
  discoverGlobalExtensionPaths,
  type ExtensionFactoryCacheDeps,
} from '../../../src/pi/extension-factory-cache.js';

/**
 * In-memory filesystem seam: paths are absolute synthetic strings.
 * Files are `{ mtimeMs, size, content }`; directories are explicit sets.
 */
function fakeFs(spec: {
  dirs: Record<string, string[]>;
  files: Record<string, { mtimeMs: number; size?: number; content?: string }>;
}) {
  const dirs = new Map(Object.entries(spec.dirs));
  const files = new Map(Object.entries(spec.files));
  const deps: ExtensionFactoryCacheDeps = {
    readdir: async (dir) => {
      const entries = dirs.get(dir);
      if (!entries) return [];
      return entries.map((name) => {
        const full = `${dir}/${name}`;
        return {
          name,
          isFile: files.has(full),
          isDirectory: dirs.has(full),
          isSymbolicLink: false,
        };
      });
    },
    stat: async (path) => {
      const file = files.get(path);
      if (file) return { mtimeMs: file.mtimeMs, size: file.size ?? 10 };
      if (dirs.has(path)) return { mtimeMs: 0, size: 0 };
      return undefined;
    },
    readFile: async (path) => {
      const file = files.get(path);
      if (!file) throw new Error(`ENOENT ${path}`);
      return file.content ?? '';
    },
  };
  return { deps, dirs, files };
}

const AGENT = '/agent';

describe('discoverGlobalExtensionPaths', () => {
  it('takes loose .ts/.js files, directories with an index, and package.json pi manifests', async () => {
    const { deps } = fakeFs({
      dirs: {
        [`${AGENT}/extensions`]: ['alpha', 'beta', 'gamma', 'delta', 'empty', 'loose.ts'],
        [`${AGENT}/extensions/alpha`]: ['index.ts'],
        [`${AGENT}/extensions/beta`]: ['index.js'],
        [`${AGENT}/extensions/gamma`]: ['package.json', 'main.ts', 'extra.ts'],
        [`${AGENT}/extensions/delta`]: ['README.md'],
        [`${AGENT}/extensions/empty`]: [],
      },
      files: {
        [`${AGENT}/extensions/loose.ts`]: { mtimeMs: 1 },
        [`${AGENT}/extensions/alpha/index.ts`]: { mtimeMs: 1 },
        [`${AGENT}/extensions/beta/index.js`]: { mtimeMs: 1 },
        [`${AGENT}/extensions/gamma/package.json`]: { mtimeMs: 1, content: JSON.stringify({ name: 'gamma', pi: { extensions: ['main.ts'] } }) },
        [`${AGENT}/extensions/gamma/main.ts`]: { mtimeMs: 1 },
        [`${AGENT}/extensions/gamma/extra.ts`]: { mtimeMs: 1 },
        [`${AGENT}/extensions/delta/README.md`]: { mtimeMs: 1 },
      },
    });
    const paths = await discoverGlobalExtensionPaths(AGENT, deps);
    expect(paths).toEqual([
      `${AGENT}/extensions/alpha/index.ts`,
      `${AGENT}/extensions/beta/index.js`,
      `${AGENT}/extensions/gamma/main.ts`,
      `${AGENT}/extensions/loose.ts`,
    ]);
  });

  it('returns [] when the extensions directory does not exist', async () => {
    const { deps } = fakeFs({ dirs: {}, files: {} });
    expect(await discoverGlobalExtensionPaths(AGENT, deps)).toEqual([]);
  });
});

describe('ExtensionFactoryCache', () => {
  function cacheHarness(extra: Partial<ExtensionFactoryCacheDeps> = {}) {
    const { deps, dirs, files } = fakeFs({
      dirs: {
        [`${AGENT}/extensions`]: ['alpha'],
        [`${AGENT}/extensions/alpha`]: ['index.ts', 'helper.ts'],
      },
      files: {
        [`${AGENT}/extensions/alpha/index.ts`]: { mtimeMs: 100, content: '' },
        [`${AGENT}/extensions/alpha/helper.ts`]: { mtimeMs: 100, content: '' },
      },
    });
    const importFactory = vi.fn(async (path: string) => ({ kind: 'factory', path }));
    const seedFactory = vi.fn(() => true);
    const cache = new ExtensionFactoryCache({ ...deps, importFactory, seedFactory, ...extra });
    return { cache, importFactory, seedFactory, dirs, files };
  }

  it('imports each extension once and reuses the factory while the fingerprint is unchanged', async () => {
    const { cache, importFactory } = cacheHarness();
    await cache.load(AGENT);
    await cache.load(AGENT);
    await cache.load(AGENT);
    expect(importFactory).toHaveBeenCalledTimes(1);
    expect(cache.stats).toMatchObject({ discovered: 1, cached: 1, imports: 1, reimports: 0 });
  });

  it('re-imports when the entry file changes', async () => {
    const { cache, importFactory, files } = cacheHarness();
    await cache.load(AGENT);
    files.get(`${AGENT}/extensions/alpha/index.ts`)!.mtimeMs = 200;
    await cache.load(AGENT);
    expect(importFactory).toHaveBeenCalledTimes(2);
    expect(cache.stats.reimports).toBe(1);
  });

  it('re-imports when any file in the extension directory changes', async () => {
    const { cache, importFactory, files } = cacheHarness();
    await cache.load(AGENT);
    files.get(`${AGENT}/extensions/alpha/helper.ts`)!.mtimeMs = 999;
    await cache.load(AGENT);
    expect(importFactory).toHaveBeenCalledTimes(2);
  });

  it('prunes the cached factory when the extension is removed', async () => {
    const { cache, dirs } = cacheHarness();
    await cache.load(AGENT);
    dirs.set(`${AGENT}/extensions`, []);
    dirs.set(`${AGENT}/extensions/alpha`, ['index.ts', 'helper.ts']);
    const entries = await cache.load(AGENT);
    expect(entries).toEqual([]);
    expect(cache.stats.cached).toBe(0);
  });

  it('keys one factory per path and does not grow with repeated loads', async () => {
    const { cache } = cacheHarness();
    for (let i = 0; i < 25; i += 1) await cache.load(AGENT);
    expect(cache.stats.cached).toBe(1);
    expect(cache.stats.discovered).toBe(1);
  });

  it('seeds every discovered factory for the session cwd', async () => {
    const { cache, seedFactory } = cacheHarness();
    const result = await cache.seed('/work/a', AGENT);
    expect(result).toEqual({ available: true, seeded: 1 });
    expect(seedFactory).toHaveBeenCalledWith(`${AGENT}/extensions/alpha/index.ts`, expect.anything(), '/work/a');
  });

  it('reports unavailable and seeds nothing when the SDK accessors are absent', async () => {
    const { cache, seedFactory } = cacheHarness();
    cache.setAccessors(undefined);
    const result = await cache.seed('/work/a', AGENT);
    expect(result).toEqual({ available: false, seeded: 0 });
    expect(seedFactory).not.toHaveBeenCalled();
  });

  it('does not seed a path whose import returned no factory', async () => {
    const { cache, seedFactory } = cacheHarness({ importFactory: async () => undefined });
    const result = await cache.seed('/work/a', AGENT);
    expect(result.seeded).toBe(0);
    expect(seedFactory).not.toHaveBeenCalled();
  });

  it('bounds the directory scan so a large extension tree cannot stall the loop', async () => {
    const many = Object.fromEntries(Array.from({ length: 900 }, (_, i) => [`${AGENT}/extensions/big/f${i}.ts`, { mtimeMs: i }]));
    const { deps } = fakeFs({
      dirs: { [`${AGENT}/extensions`]: ['big'], [`${AGENT}/extensions/big`]: Object.keys(many).map((p) => p.split('/').pop()!) },
      files: many,
    });
    const cache = new ExtensionFactoryCache({ ...deps, importFactory: async () => ({}), seedFactory: () => true, maxScanEntries: 50 });
    await cache.load(AGENT);
    const seen = cache.lastScanEntryCount;
    expect(seen).toBeLessThanOrEqual(50);
  });
});
