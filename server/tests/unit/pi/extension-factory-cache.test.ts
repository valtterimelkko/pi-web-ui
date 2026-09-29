import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Extension } from '@earendil-works/pi-coding-agent';
import {
  DEFAULT_SHARE_SAFE_EXTENSIONS,
  ExtensionFactoryCache,
  createExtensionFactoryResourceLoader,
  discoverGlobalExtensionPaths,
  getExtensionLoaderTelemetry,
  refreshExtensionFactories,
  resetExtensionLoaderTelemetry,
  runExtensionLoadCriticalSection,
  type ExtensionFactoryCacheDeps,
} from '../../../src/pi/extension-factory-cache.js';
import { ExtensionImporterError, importFactoryViaJiti } from '../../../src/pi/sdk-extension-importer.js';

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
    const cache = new ExtensionFactoryCache({ ...deps, importFactory, allowlist: ['alpha'], ...extra });
    return { cache, importFactory, dirs, files };
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

  it('exposes no seed/accessor surface: factories are handed to the loader, not seeded into the SDK', () => {
    const { cache } = cacheHarness();
    const bare = cache as unknown as Record<string, unknown>;
    expect(bare['seed']).toBeUndefined();
    expect(bare['setAccessors']).toBeUndefined();
  });

  it('peekFactory returns the cached factory without triggering a scan', async () => {
    const { cache } = cacheHarness();
    await cache.load(AGENT);
    expect(cache.peekFactory(`${AGENT}/extensions/alpha/index.ts`)).toMatchObject({ kind: 'factory' });
    expect(cache.peekFactory(`${AGENT}/extensions/unknown/index.ts`)).toBeUndefined();
  });

  it('defaults importFactory to the public jiti importer when none is provided', async () => {
    const root = mkdtempSync(join(tmpdir(), 'b12b-cache-default-'));
    try {
      const agentDir = join(root, 'agent');
      mkdirSync(join(agentDir, 'extensions', 'ok'), { recursive: true });
      writeFileSync(join(agentDir, 'extensions', 'ok', 'index.ts'), 'export default function (pi) { pi.registerCommand(\'ok\', { handler: async () => 1 }); }');
      const cache = new ExtensionFactoryCache({ allowlist: ['ok'] });
      const factories = await cache.load(agentDir);
      expect(factories).toHaveLength(1);
      expect(typeof factories[0]?.factory).toBe('function');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('swallows a failing import (the extension stays uncached; the loader reports it per session)', async () => {
    const { cache } = cacheHarness({ importFactory: async () => undefined });
    const entries = await cache.load(AGENT);
    expect(entries).toEqual([]);
    expect(cache.stats.cached).toBe(0);
  });

  it('bounds the directory scan so a large extension tree cannot stall the loop', async () => {
    const many = Object.fromEntries(Array.from({ length: 900 }, (_, i) => [`${AGENT}/extensions/big/f${i}.ts`, { mtimeMs: i }]));
    const { deps } = fakeFs({
      dirs: { [`${AGENT}/extensions`]: ['big'], [`${AGENT}/extensions/big`]: Object.keys(many).map((p) => p.split('/').pop()!) },
      files: many,
    });
    const cache = new ExtensionFactoryCache({ ...deps, importFactory: async () => ({}), maxScanEntries: 50 });
    await cache.load(AGENT);
    const seen = cache.lastScanEntryCount;
    expect(seen).toBeLessThanOrEqual(50);
  });
});

describe('ExtensionFactoryCache — share-safe allowlist (major 1)', () => {
  it('imports only extensions on the allowlist; the rest load per session through the SDK', async () => {
    const { deps } = fakeFs({
      dirs: {
        [`${AGENT}/extensions`]: ['safe-one', 'stateful-one'],
        [`${AGENT}/extensions/safe-one`]: ['index.ts'],
        [`${AGENT}/extensions/stateful-one`]: ['index.ts', 'state.ts'],
      },
      files: {
        [`${AGENT}/extensions/safe-one/index.ts`]: { mtimeMs: 1 },
        [`${AGENT}/extensions/stateful-one/index.ts`]: { mtimeMs: 1 },
        [`${AGENT}/extensions/stateful-one/state.ts`]: { mtimeMs: 1 },
      },
    });
    const importFactory = vi.fn(async (path: string) => ({ path }));
    const cache = new ExtensionFactoryCache({ ...deps, importFactory, allowlist: ['safe-one'] });

    const result = await cache.load(AGENT);
    expect(result).toHaveLength(1);
    expect(result[0]?.path).toBe(`${AGENT}/extensions/safe-one/index.ts`);
    expect(importFactory).toHaveBeenCalledTimes(1);
    expect(importFactory).toHaveBeenCalledWith(`${AGENT}/extensions/safe-one/index.ts`);
    expect(cache.stats).toMatchObject({ discovered: 2, allowlisted: 1, skipped: 1, cached: 1 });
  });

  it('defaults to the audited share-safe allowlist', async () => {
    expect(DEFAULT_SHARE_SAFE_EXTENSIONS).toContain('auto-compact-75');
    expect(DEFAULT_SHARE_SAFE_EXTENSIONS).toContain('todo');
    // Refactored to per-session scope (B1.3) — now cached.
    for (const added of ['memory', 'goal-engine', 'parallel-orchestrator', 'web-tools', 'enhanced-plan-mode']) {
      expect(DEFAULT_SHARE_SAFE_EXTENSIONS).toContain(added);
    }
    // Still carry per-session module state — must stay uncached until B1.3 finishes them.
    for (const denied of ['subagent']) {
      expect(DEFAULT_SHARE_SAFE_EXTENSIONS).not.toContain(denied);
    }
  });

  it('does not cache an extension whose id is not allowlisted, even when discovered', async () => {
    const { deps } = fakeFs({
      dirs: { [`${AGENT}/extensions`]: ['stateful'], [`${AGENT}/extensions/stateful`]: ['index.ts'] },
      files: { [`${AGENT}/extensions/stateful/index.ts`]: { mtimeMs: 1 } },
    });
    const importFactory = vi.fn(async () => ({}));
    const cache = new ExtensionFactoryCache({ ...deps, importFactory, allowlist: [] });
    const entries = await cache.load(AGENT);
    expect(entries).toEqual([]);
    expect(importFactory).not.toHaveBeenCalled();
  });
});

describe('ExtensionFactoryCache — whole-tree freshness and budget (minors 3 and 4)', () => {
  it('re-imports a loose entry when a sibling outside its directory changes', async () => {
    const { deps, files } = fakeFs({
      dirs: { [`${AGENT}/extensions`]: ['loose.ts', 'helper'], [`${AGENT}/extensions/helper`]: ['util.ts'] },
      files: {
        [`${AGENT}/extensions/loose.ts`]: { mtimeMs: 1 },
        [`${AGENT}/extensions/helper/util.ts`]: { mtimeMs: 1 },
      },
    });
    const importFactory = vi.fn(async (p: string) => ({ p }));
    const cache = new ExtensionFactoryCache({ ...deps, importFactory, allowlist: ['loose', 'helper'] });
    await cache.load(AGENT);
    expect(importFactory).toHaveBeenCalledTimes(1);
    files.get(`${AGENT}/extensions/helper/util.ts`)!.mtimeMs = 5000;
    await cache.load(AGENT);
    expect(importFactory).toHaveBeenCalledTimes(2);
  });

  it('re-imports a manifest-declared entry when its helper changes', async () => {
    const { deps, files } = fakeFs({
      dirs: { [`${AGENT}/extensions`]: ['pkg'], [`${AGENT}/extensions/pkg`]: ['package.json', 'main.ts', 'helper.ts'] },
      files: {
        [`${AGENT}/extensions/pkg/package.json`]: { mtimeMs: 1, content: JSON.stringify({ pi: { extensions: ['main.ts'] } }) },
        [`${AGENT}/extensions/pkg/main.ts`]: { mtimeMs: 1 },
        [`${AGENT}/extensions/pkg/helper.ts`]: { mtimeMs: 1 },
      },
    });
    const importFactory = vi.fn(async (p: string) => ({ p }));
    const cache = new ExtensionFactoryCache({ ...deps, importFactory, allowlist: ['pkg'] });
    await cache.load(AGENT);
    files.get(`${AGENT}/extensions/pkg/helper.ts`)!.mtimeMs = 9000;
    await cache.load(AGENT);
    expect(importFactory).toHaveBeenCalledTimes(2);
  });

  it('falls back to no caching when the traversal budget is exceeded', async () => {
    const many = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`${AGENT}/extensions/big/f${i}.ts`, { mtimeMs: i }]));
    const { deps } = fakeFs({
      dirs: { [`${AGENT}/extensions`]: ['big'], [`${AGENT}/extensions/big`]: Object.keys(many).map((p) => p.split('/').pop()!) },
      files: many,
    });
    const importFactory = vi.fn(async () => ({}));
    const cache = new ExtensionFactoryCache({ ...deps, importFactory, allowlist: ['big'], maxScanEntries: 100 });
    const entries = await cache.load(AGENT);
    expect(entries).toEqual([]);
    expect(importFactory).not.toHaveBeenCalled();
    expect(cache.stats.overBudget).toBe(true);
  });

  it('bounds directories visited, not only files', async () => {
    const dirs: Record<string, string[]> = { [`${AGENT}/extensions`]: [] };
    for (let i = 0; i < 200; i += 1) {
      dirs[`${AGENT}/extensions`].push(`d${i}`);
      dirs[`${AGENT}/extensions/d${i}`] = [];
    }
    const { deps } = fakeFs({ dirs, files: {} });
    const cache = new ExtensionFactoryCache({ ...deps, importFactory: async () => ({}), maxScanDirs: 20 });
    const entries = await cache.load(AGENT);
    expect(entries).toEqual([]);
    expect(cache.stats.overBudget).toBe(true);
  });
});

describe('runExtensionLoadCriticalSection (major 2)', () => {
  it('runs tasks strictly one at a time in submission order', async () => {
    const order: string[] = [];
    const task = (name: string, delay: number) => async () => {
      order.push(`start:${name}`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      order.push(`end:${name}`);
      return name;
    };
    const [a, b] = await Promise.all([
      runExtensionLoadCriticalSection(task('a', 30)),
      runExtensionLoadCriticalSection(task('b', 5)),
    ]);
    expect(a).toBe('a');
    expect(b).toBe('b');
    expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b']);
  });

  it('keeps the chain alive after a rejection', async () => {
    const failing = runExtensionLoadCriticalSection(async () => {
      throw new Error('boom');
    });
    await expect(failing).rejects.toThrow('boom');
    await expect(runExtensionLoadCriticalSection(async () => 'ok')).resolves.toBe('ok');
  });
});

describe('ExtensionFactoryCache — round-2 review guards', () => {
  it('bounds filesystem operations during discovery, not only the overBudget flag', async () => {
    // 100 sibling extension directories; the budget must be enforced while the
    // top-level directory is being enumerated, before every entry is stat'd
    // (round-2 review: discovery used to run unbounded first).
    const dirs: Record<string, string[]> = { [`${AGENT}/extensions`]: [] };
    for (let i = 0; i < 100; i += 1) {
      dirs[`${AGENT}/extensions`].push(`d${i}`);
      dirs[`${AGENT}/extensions/d${i}`] = ['index.ts'];
    }
    const files: Record<string, { mtimeMs: number; size?: number }> = {};
    for (let i = 0; i < 100; i += 1) files[`${AGENT}/extensions/d${i}/index.ts`] = { mtimeMs: i };
    const base = fakeFs({ dirs, files });
    let stats = 0;
    let readdirs = 0;
    const cache = new ExtensionFactoryCache({
      readdir: async (dir) => { readdirs += 1; return base.deps.readdir(dir); },
      stat: async (path) => { stats += 1; return base.deps.stat(path); },
      readFile: base.deps.readFile,
      importFactory: async () => ({}),
      maxScanDirs: 2,
      maxScanEntries: 2,
    });
    const entries = await cache.load(AGENT);
    expect(entries).toEqual([]);
    expect(cache.stats.overBudget).toBe(true);
    // readdir(extensions) + a bounded number of stats for at most the budgeted
    // entries (each directory entry may probe package.json/index.ts).
    expect(stats + readdirs).toBeLessThanOrEqual(12);
    expect(stats).toBeLessThan(20);
  });

  it('leaves a symlinked extension uncached and reports it', async () => {
    const { deps } = fakeFs({
      dirs: {
        [`${AGENT}/extensions`]: ['linked', 'plain'],
        [`${AGENT}/extensions/plain`]: ['index.ts'],
      },
      files: {
        [`${AGENT}/extensions/plain/index.ts`]: { mtimeMs: 1 },
        [`${AGENT}/extensions/linked/index.ts`]: { mtimeMs: 1 },
        [`${AGENT}/extensions/linked/helper.ts`]: { mtimeMs: 1 },
      },
    });
    // Mark 'linked' as a symlinked directory entry.
    const linkedReaddir = async (dir: string) => {
      const entries = await deps.readdir!(dir);
      if (dir === `${AGENT}/extensions`) {
        return entries.map((entry) => entry.name === 'linked'
          ? { ...entry, isDirectory: false, isSymbolicLink: true }
          : entry);
      }
      return entries;
    };
    const importFactory = vi.fn(async (p: string) => ({ p }));
    const cache = new ExtensionFactoryCache({
      readdir: linkedReaddir,
      stat: deps.stat,
      readFile: deps.readFile,
      importFactory,
      allowlist: ['linked', 'plain'],
    });
    const entries = await cache.load(AGENT);
    expect(entries.map((entry) => entry.path)).toEqual([`${AGENT}/extensions/plain/index.ts`]);
    expect(importFactory).toHaveBeenCalledTimes(1);
    expect(cache.stats.unfingerprintable).toBe(1);

    // Mutate the helper UNDER the symlink and load again: the symlinked
    // extension must still never be imported (there is no fingerprint to go
    // stale, because it is excluded rather than followed).
    const baseStat = deps.stat;
    const helper = `${AGENT}/extensions/linked/helper.ts`;
    const bumped = new Map<string, { mtimeMs: number; size: number }>();
    bumped.set(helper, { mtimeMs: 99_999, size: 10 });
    const cacheAfter = new ExtensionFactoryCache({
      readdir: linkedReaddir,
      stat: async (path: string) => bumped.get(path) ?? baseStat?.(path),
      readFile: deps.readFile,
      importFactory,
      allowlist: ['linked', 'plain'],
    });
    const second = await cacheAfter.load(AGENT);
    expect(second.map((entry) => entry.path)).toEqual([`${AGENT}/extensions/plain/index.ts`]);
    // The linked extension is never imported, before or after the mutation.
    expect(importFactory.mock.calls.map((call) => call[0])).toEqual([
      `${AGENT}/extensions/plain/index.ts`,
      `${AGENT}/extensions/plain/index.ts`,
    ]);
    expect(cacheAfter.stats.unfingerprintable).toBe(1);
  });
});

describe('ExtensionFactoryCache — discovery is inside the shared hard budget (round-3 review)', () => {
  it('stops a 500-entry pi.extensions manifest at the entry budget', async () => {
    const declared = Array.from({ length: 500 }, (_, i) => `e${i}.ts`);
    const files: Record<string, { mtimeMs: number; size?: number; content?: string }> = {
      [`${AGENT}/extensions/pkg/package.json`]: { mtimeMs: 1, content: JSON.stringify({ pi: { extensions: declared } }) },
    };
    for (let i = 0; i < 500; i += 1) files[`${AGENT}/extensions/pkg/e${i}.ts`] = { mtimeMs: i };
    const base = fakeFs({
      dirs: { [`${AGENT}/extensions`]: ['pkg'], [`${AGENT}/extensions/pkg`]: ['package.json', ...declared] },
      files,
    });
    let stats = 0;
    const cache = new ExtensionFactoryCache({
      readdir: base.deps.readdir,
      stat: async (path: string) => { stats += 1; return base.deps.stat!(path); },
      readFile: base.deps.readFile,
      importFactory: async (p: string) => ({ p }),
      allowlist: ['pkg'],
      maxScanEntries: 2,
    });
    const entries = await cache.load(AGENT);
    expect(entries).toEqual([]);
    expect(cache.stats.overBudget).toBe(true);
    // Manifest candidates are debited against the same budget: the scan stops
    // after the budget, not after stat'ing all 500 declared files.
    expect(stats).toBeLessThanOrEqual(6);
    expect(cache.lastScanEntryCount).toBeLessThanOrEqual(3);
  });

  it('does not fully list a 1,000-entry extensions root', async () => {
    const base = fakeFs({
      dirs: {
        [`${AGENT}/extensions`]: Array.from({ length: 1000 }, (_, i) => `d${i}`),
      },
      files: {},
    });
    let yielded = 0;
    let readdirCalls = 0;
    const cache = new ExtensionFactoryCache({
      // Streaming seam: the scanner must stop pulling once the budget is spent.
      opendir: async (dir: string) => {
        const list = await base.deps.readdir!(dir);
        return (async function* () {
          for (const entry of list) {
            yielded += 1;
            yield entry;
          }
        })();
      },
      readdir: async (dir: string) => { readdirCalls += 1; return base.deps.readdir!(dir); },
      stat: base.deps.stat,
      readFile: base.deps.readFile,
      importFactory: async () => ({}),
      maxScanDirs: 1,
      maxScanEntries: 2,
    });
    const entries = await cache.load(AGENT);
    expect(entries).toEqual([]);
    expect(cache.stats.overBudget).toBe(true);
    // budget + 1: the entry that trips the limit is the only one past it.
    expect(yielded).toBeLessThanOrEqual(3);
    expect(readdirCalls).toBe(0);
  });
});

// ── B1.2b: factory delivery through the public API ──────────────────────────

/**
 * Real-fixture harness for `createExtensionFactoryResourceLoader`: a global
 * share-safe extension, an uncached global extension (module state), and a
 * project-local extension — the parity surface the frozen criteria demand.
 */
const ISO_SOURCE = `
export default function (pi) {
  pi.registerCommand('iso-echo', { description: 'iso', handler: async () => 'iso' });
  pi.registerTool({ name: 'iso_tool', description: 'iso tool', parameters: { type: 'object', properties: {} }, execute: async () => ({ output: 'iso' }) });
  pi.registerFlag('isoFlag', { description: 'iso flag', type: 'boolean' });
}
`;
const UNCACHED_SOURCE = `
export default function (pi) {
  pi.registerCommand('uncached-echo', { description: 'uncached', handler: async () => 'uncached' });
}
`;

interface LoaderHarness {
  root: string;
  agentDir: string;
  cwdA: string;
  cwdB: string;
  cache: ExtensionFactoryCache;
}

async function loaderHarness(): Promise<LoaderHarness> {
  const root = mkdtempSync(join(tmpdir(), 'b12b-loader-'));
  const agentDir = join(root, 'agent');
  const cwdA = join(root, 'work-a');
  const cwdB = join(root, 'work-b');
  mkdirSync(join(agentDir, 'extensions', 'iso'), { recursive: true });
  mkdirSync(join(agentDir, 'extensions', 'uncached'), { recursive: true });
  mkdirSync(cwdA, { recursive: true });
  mkdirSync(cwdB, { recursive: true });
  writeFileSync(join(agentDir, 'extensions', 'iso', 'index.ts'), ISO_SOURCE);
  writeFileSync(join(agentDir, 'extensions', 'uncached', 'index.ts'), UNCACHED_SOURCE);
  const cache = new ExtensionFactoryCache({ allowlist: ['iso'] });
  return { root, agentDir, cwdA, cwdB, cache };
}

function loaderHarnessTeardown(harness: LoaderHarness): void {
  rmSync(harness.root, { recursive: true, force: true });
}

/** The old uncached path: plain loader, normal discovery. */
async function loadPlain(cwd: string, agentDir: string): Promise<ReturnType<import('@earendil-works/pi-coding-agent').DefaultResourceLoader['getExtensions']>> {
  const { DefaultResourceLoader } = await import('@earendil-works/pi-coding-agent');
  const loader = new DefaultResourceLoader({ cwd, agentDir });
  await loader.reload();
  return loader.getExtensions();
}

/** Full comparable projection: order, identity, registrations. */
function project(result: { extensions: Extension[] }): Array<Record<string, unknown>> {
  return result.extensions.map((extension) => ({
    path: extension.path,
    resolvedPath: extension.resolvedPath,
    source: extension.sourceInfo?.source,
    scope: extension.sourceInfo?.scope,
    commands: [...extension.commands.keys()].sort(),
    tools: [...extension.tools.keys()].sort(),
    flags: [...extension.flags.keys()].sort(),
  }));
}

describe('createExtensionFactoryResourceLoader (B1.2b)', () => {
  beforeEach(() => resetExtensionLoaderTelemetry());

  it('delivers parity: same set, order, commands, tools and flags as the uncached path, two cwds, project-local included', async () => {
    const harness = await loaderHarness();
    try {
      mkdirSync(join(harness.cwdA, '.pi', 'extensions', 'local-one'), { recursive: true });
      writeFileSync(join(harness.cwdA, '.pi', 'extensions', 'local-one', 'index.ts'), UNCACHED_SOURCE);

      for (const cwd of [harness.cwdA, harness.cwdB]) {
        const loader = await createExtensionFactoryResourceLoader(cwd, harness.agentDir, { cache: harness.cache });
        const viaFactory = loader.getExtensions();
        const plain = await loadPlain(cwd, harness.agentDir);
        expect(project(viaFactory)).toEqual(project(plain));
      }
    } finally {
      loaderHarnessTeardown(harness);
    }
  });

  it('cached extensions keep their real path and the same sourceInfo the uncached path produces', async () => {
    const harness = await loaderHarness();
    try {
      const loader = await createExtensionFactoryResourceLoader(harness.cwdA, harness.agentDir, { cache: harness.cache });
      const iso = loader.getExtensions().extensions.find((extension) => extension.path.includes('/iso/'));
      expect(iso).toBeDefined();
      expect(iso!.path.startsWith('<inline')).toBe(false);
      expect(iso!.resolvedPath).toBe(iso!.path);
      const plain = await loadPlain(harness.cwdA, harness.agentDir);
      const plainIso = plain.extensions.find((extension) => extension.path.includes('/iso/'));
      expect(iso!.sourceInfo).toEqual(plainIso!.sourceInfo);
    } finally {
      loaderHarnessTeardown(harness);
    }
  });

  it('re-imports a changed cached extension on the next loader build (fingerprint freshness)', async () => {
    const harness = await loaderHarness();
    try {
      const first = await createExtensionFactoryResourceLoader(harness.cwdA, harness.agentDir, { cache: harness.cache });
      expect(first.getExtensions().extensions).toHaveLength(2);
      expect(harness.cache.stats.imports).toBe(1);

      writeFileSync(join(harness.agentDir, 'extensions', 'iso', 'index.ts'), ISO_SOURCE.replace('iso-echo', 'iso-echo-v2'));
      const second = await createExtensionFactoryResourceLoader(harness.cwdB, harness.agentDir, { cache: harness.cache });
      expect(harness.cache.stats.imports).toBe(2);
      expect(harness.cache.stats.reimports).toBe(1);
      expect(second.getExtensions().extensions).toHaveLength(2);
      void first;
    } finally {
      loaderHarnessTeardown(harness);
    }
  });

  it('picks up cached extension code changes on /reload via the factory indirection', async () => {
    const harness = await loaderHarness();
    try {
      const loader = await createExtensionFactoryResourceLoader(harness.cwdA, harness.agentDir, { cache: harness.cache });
      expect([...loader.getExtensions().extensions[0]!.commands.keys()]).toContain('iso-echo');

      writeFileSync(join(harness.agentDir, 'extensions', 'iso', 'index.ts'), ISO_SOURCE.replace('iso-echo', 'iso-echo-v2'));
      await refreshExtensionFactories(harness.agentDir, { cache: harness.cache });
      await loader.reload();
      const commands = loader.getExtensions().extensions.flatMap((extension) => [...extension.commands.keys()]);
      expect(commands).toContain('iso-echo-v2');
      expect(commands).not.toContain('iso-echo');
    } finally {
      loaderHarnessTeardown(harness);
    }
  });

  // ── graceful fallback: every failure class degrades to the plain uncached path ──

  const failureClasses: Array<[string, (harness: LoaderHarness) => Parameters<typeof createExtensionFactoryResourceLoader>[2]]> = [
    [
      'SDK version outside the validated range (real importer chain)',
      (harness) => ({
        cache: new ExtensionFactoryCache({
          allowlist: ['iso'],
          importFactory: (path) =>
            importFactoryViaJiti(path, {
              aliasMap: () => {
                throw new ExtensionImporterError('SDK 0.99.0 is outside the validated range (0.87.1)');
              },
            }),
        }),
      }),
    ],
    [
      'jiti import fails (crash on import)',
      (harness) => ({
        cache: new ExtensionFactoryCache({
          allowlist: ['iso'],
          importFactory: async () => {
            throw new ExtensionImporterError('jiti unavailable (simulated)');
          },
        }),
      }),
    ],
    [
      'override hits frozen or changed result objects',
      (harness) => ({ cache: harness.cache, forceOverrideFailure: true }),
    ],
    [
      'parity self-check mismatch',
      (harness) => ({ cache: harness.cache, tamperParityCheck: true }),
    ],
  ];

  for (const [label, depsFor] of failureClasses) {
    it(`falls back to the plain uncached SDK path with the full, correct extension set — ${label}`, async () => {
      const harness = await loaderHarness();
      try {
        mkdirSync(join(harness.cwdA, '.pi', 'extensions', 'local-one'), { recursive: true });
        writeFileSync(join(harness.cwdA, '.pi', 'extensions', 'local-one', 'index.ts'), UNCACHED_SOURCE);

        const before = getExtensionLoaderTelemetry().fallbacks;
        const loader = await createExtensionFactoryResourceLoader(harness.cwdA, harness.agentDir, depsFor(harness));
        const projection = project(loader.getExtensions());
        const plain = await loadPlain(harness.cwdA, harness.agentDir);
        expect(projection).toEqual(project(plain));
        const telemetry = getExtensionLoaderTelemetry();
        expect(telemetry.fallbacks).toBe(before + 1);
        expect(telemetry.lastFallbackReason).toBeTruthy();
      } finally {
        loaderHarnessTeardown(harness);
      }
    });
  }
});
