import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DefaultResourceLoader,
  ExtensionRunner,
  type Extension,
  type ExtensionAPI,
  type ExtensionRuntime,
} from '@earendil-works/pi-coding-agent';
import { ExtensionFactoryCache, runExtensionLoadCriticalSection } from '../../../src/pi/extension-factory-cache.js';

/**
 * B1.2 requirement 1/2 live-mechanism proof.
 *
 * `AgentSession._buildRuntime` does exactly this:
 *   const extensionsResult = this._resourceLoader.getExtensions();
 *   this._extensionRunner = new ExtensionRunner(extensionsResult.extensions, extensionsResult.runtime, …);
 *   runner.bindCore(actions, …);   // installs the session's actions on the runtime
 * So two `DefaultResourceLoader` instances (the per-session loader) sharing one
 * runtime is the failure mode the rejected per-cwd-loader cache would have
 * created. This test drives the same objects with a capture extension, and
 * includes the rejected design as an explicit negative control.
 */

const instancesKey = '__b12IsolationInstances';
const statefulKey = '__b12StatefulSets';
type Captured = { api: ExtensionAPI; extension: Extension };

function capture(): Captured[] {
  const list = ((globalThis as Record<string, unknown>)[instancesKey] ??= []) as Captured[];
  return list;
}

const EXTENSION_SOURCE = `
export default function (pi) {
  const list = (globalThis.${instancesKey} ??= []);
  list.push({ api: pi });
  pi.registerCommand('b12-echo', { description: 'test command', handler: async () => {} });
}
`;

function writeExtension(agentDir: string, name: string): void {
  const dir = join(agentDir, 'extensions', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.ts'), EXTENSION_SOURCE);
}

function noopActions(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return new Proxy(overrides, {
    get: (target, prop) => (prop in target ? (target as Record<string | symbol, unknown>)[prop] : () => undefined),
  });
}

function bindRunner(runtime: ExtensionRuntime, extensions: Extension[], cwd: string, actions: Record<string, unknown>): ExtensionRunner {
  const runner = new ExtensionRunner(extensions, runtime, cwd, {} as never, {} as never);
  runner.bindCore(
    actions as never,
    noopActions() as never,
    { registerProvider: () => undefined, registerNativeProvider: () => undefined } as never,
  );
  return runner;
}

let root: string;
let agentDir: string;
let cwdA: string;
let cwdB: string;
let cache: ExtensionFactoryCache;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'b12-iso-'));
  agentDir = join(root, 'agent');
  cwdA = join(root, 'work-a');
  cwdB = join(root, 'work-b');
  mkdirSync(cwdA, { recursive: true });
  mkdirSync(cwdB, { recursive: true });
  writeExtension(agentDir, 'iso');
  (globalThis as Record<string, unknown>)[instancesKey] = [];
  const sdk = (await import('@earendil-works/pi-coding-agent')) as unknown as {
    importExtensionFactory?: (path: string) => Promise<unknown>;
    seedExtensionFactory?: (path: string, factory: unknown, cwd: string) => boolean;
  };
  // The fixture extension stands in for an audited share-safe global extension.
  cache = new ExtensionFactoryCache({
    importFactory: sdk.importExtensionFactory,
    seedFactory: sdk.seedExtensionFactory,
    allowlist: ['iso'],
  });
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[instancesKey];
  delete (globalThis as Record<string, unknown>)[statefulKey];
  rmSync(root, { recursive: true, force: true });
});

async function loadWithCache(cwd: string): Promise<{ extensions: Extension[]; runtime: ExtensionRuntime }> {
  await cache.seed(cwd, agentDir);
  const loader = new DefaultResourceLoader({ cwd, agentDir });
  await loader.reload();
  const result = loader.getExtensions();
  return { extensions: result.extensions, runtime: result.runtime };
}

describe('B1.2 per-session extension runtime isolation (factory-cached load)', () => {
  it('gives each cached load its own Extension objects and runtime', async () => {
    const first = await loadWithCache(cwdA);
    const second = await loadWithCache(cwdA);
    const third = await loadWithCache(cwdB);

    expect(first.extensions).toHaveLength(1);
    expect(first.extensions[0]).not.toBe(second.extensions[0]);
    expect(second.extensions[0]).not.toBe(third.extensions[0]);
    expect(first.runtime).not.toBe(second.runtime);
    expect(second.runtime).not.toBe(third.runtime);
    // The factory was imported once for the whole process.
    expect(cache.stats.imports).toBe(1);
  });

  it('routes an extension action from session A only into A, and disposing A leaves B working', async () => {
    const sessionA = await loadWithCache(cwdA);
    const sessionB = await loadWithCache(cwdB);
    const captured = capture();
    expect(captured).toHaveLength(2);
    const [piA, piB] = captured.map((entry) => entry.api);

    const callsA: unknown[] = [];
    const callsB: unknown[] = [];
    const runnerA = bindRunner(sessionA.runtime, sessionA.extensions, cwdA, { sendMessage: (m: unknown) => callsA.push(m) });
    bindRunner(sessionB.runtime, sessionB.extensions, cwdB, { sendMessage: (m: unknown) => callsB.push(m) });

    piA.sendMessage({ text: 'from-a' });
    piB.sendMessage({ text: 'from-b' });
    expect(callsA).toEqual([{ text: 'from-a' }]);
    expect(callsB).toEqual([{ text: 'from-b' }]);

    // Dispose A (`session_shutdown` + invalidate is what AgentSession.dispose does).
    sessionA.extensions[0].handlers.get('session_shutdown')?.forEach((handler) => handler({ type: 'session_shutdown' }));
    sessionA.runtime.invalidate('session A disposed');
    runnerA.getRegisteredCommands();

    piB.sendMessage({ text: 'after-a-disposed' });
    expect(callsB).toEqual([{ text: 'from-b' }, { text: 'after-a-disposed' }]);
    expect(callsA).toEqual([{ text: 'from-a' }]);
  });

  it('fails on the rejected design (one loaded loader shared by two sessions)', async () => {
    const shared = await loadWithCache(cwdA);
    const captured = capture();
    expect(captured).toHaveLength(1);

    const callsA: unknown[] = [];
    const callsB: unknown[] = [];
    // Two sessions in the same cwd sharing one loader's extensions + runtime:
    // exactly what a per-cwd loader cache would produce.
    const runnerA = bindRunner(shared.runtime, shared.extensions, cwdA, { sendMessage: (m: unknown) => callsA.push(m) });
    bindRunner(shared.runtime, shared.extensions, cwdA, { sendMessage: (m: unknown) => callsB.push(m) });
    void runnerA;

    // B's bindCore overwrote the shared runtime's actions, so A's extension now
    // sends into B.
    captured[0].api.sendMessage({ text: 'from-a' });
    expect(callsA).toEqual([]);
    expect(callsB).toEqual([{ text: 'from-a' }]);
  });

  it('keeps pi.exec in the session cwd (two sessions, two cwds)', async () => {
    const sessionA = await loadWithCache(cwdA);
    const sessionB = await loadWithCache(cwdB);
    void sessionA;
    void sessionB;
    const [piA, piB] = capture().map((entry) => entry.api);

    const resultA = await piA.exec('pwd');
    const resultB = await piB.exec('pwd');
    const stdoutOf = (result: unknown): string =>
      typeof result === 'string' ? result : ((result as { stdout?: string }).stdout ?? '');
    // macOS /tmp symlink aside, both must be the session's own directory, not a
    // shared constant cwd (the reason the constant-cwd design was rejected).
    expect(stdoutOf(resultA)).toContain('work-a');
    expect(stdoutOf(resultB)).toContain('work-b');
  });

  it('still loads a project-local extension per cwd and does not leak it to a sibling cwd', async () => {
    const localCwd = join(root, 'work-local');
    mkdirSync(join(localCwd, '.pi', 'extensions', 'mine'), { recursive: true });
    writeFileSync(join(localCwd, '.pi', 'extensions', 'mine', 'index.ts'), EXTENSION_SOURCE);

    const withLocal = await loadWithCache(localCwd);
    const sibling = await loadWithCache(cwdB);
    const namesFor = (extensions: Extension[]): string[] => extensions.map((extension) => extension.path);

    expect(namesFor(withLocal.extensions).some((path) => path.includes('work-local'))).toBe(true);
    expect(namesFor(sibling.extensions).some((path) => path.includes('work-local'))).toBe(false);
    // The global cached extension is present in both.
    expect(withLocal.extensions).toHaveLength(2);
    expect(sibling.extensions).toHaveLength(1);
  });

  it('re-imports a changed extension on the next load (updates are not frozen)', async () => {
    await loadWithCache(cwdA);
    expect(cache.stats.imports).toBe(1);

    const entry = join(agentDir, 'extensions', 'iso', 'index.ts');
    writeFileSync(entry, EXTENSION_SOURCE.replace('b12-echo', 'b12-echo-v2'));
    await loadWithCache(cwdB);

    expect(cache.stats.imports).toBe(2);
    expect(cache.stats.reimports).toBe(1);
    expect(capture()).toHaveLength(2);
  });
});

/**
 * Major 1 (independent review): caching an evaluated module also shares its
 * MODULE-SCOPE state. This fixture has a module-level Set mutated on
 * `session_start` — the shape the review found in the global `subagent`
 * extension. It must be uncached (not on the allowlist), and the test proves
 * both the safe outcome and the hazard when it IS cached.
 */
const STATEFUL_SOURCE = `
const activeSessions = new Set();
export default function (pi) {
  pi.on('session_start', async (event) => { activeSessions.add(event.sessionId ?? 'unknown'); });
  (globalThis.${statefulKey} ??= []).push(activeSessions);
}
`;

function writeStatefulExtension(agentDir: string, name: string): void {
  const dir = join(agentDir, 'extensions', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.ts'), STATEFUL_SOURCE);
}

function statefulSets(): Array<Set<string>> {
  return ((globalThis as Record<string, unknown>)[statefulKey] ??= []) as Array<Set<string>>;
}

async function makeStatefulCache(allowlist: readonly string[]): Promise<ExtensionFactoryCache> {
  const sdk = (await import('@earendil-works/pi-coding-agent')) as unknown as {
    importExtensionFactory?: (path: string) => Promise<unknown>;
    seedExtensionFactory?: (path: string, factory: unknown, cwd: string) => boolean;
  };
  return new ExtensionFactoryCache({
    importFactory: sdk.importExtensionFactory,
    seedFactory: sdk.seedExtensionFactory,
    allowlist,
  });
}

async function loadStateful(cache: ExtensionFactoryCache, cwd: string): Promise<Extension[]> {
  await cache.seed(cwd, agentDir);
  const loader = new DefaultResourceLoader({ cwd, agentDir });
  await loader.reload();
  return loader.getExtensions().extensions;
}

function fireSessionStart(extensions: Extension[], sessionId: string): void {
  for (const extension of extensions) {
    for (const handler of extension.handlers.get('session_start') ?? []) {
      handler({ type: 'session_start', sessionId }, undefined);
    }
  }
}

describe('B1.2 module-state isolation for stateful extensions (review major 1)', () => {
  it('keeps session A\'s module state untouched when session B starts (stateful extension uncached)', async () => {
    writeStatefulExtension(agentDir, 'stateful');
    const cache = await makeStatefulCache([]);
    const extA = await loadStateful(cache, cwdA);
    fireSessionStart(extA, 'A');
    const extB = await loadStateful(cache, cwdB);
    fireSessionStart(extB, 'B');

    const sets = statefulSets();
    expect(sets).toHaveLength(2);
    expect([...sets[0]]).toEqual(['A']);
    expect([...sets[1]]).toEqual(['B']);
    expect(sets[0]).not.toBe(sets[1]);
  });

  it('demonstrates the hazard when the stateful extension IS cached', async () => {
    writeStatefulExtension(agentDir, 'stateful');
    const cache = await makeStatefulCache(['stateful']);
    const extA = await loadStateful(cache, cwdA);
    fireSessionStart(extA, 'A');
    const extB = await loadStateful(cache, cwdB);
    fireSessionStart(extB, 'B');

    const sets = statefulSets();
    // One shared module instance: B's start mutated A's set.
    expect(sets[0]).toBe(sets[1]);
    expect([...sets[0]]).toEqual(['A', 'B']);
  });
});

/**
 * Major 2 (independent review): the SDK's extension module cache is ONE
 * process-global cwd slot, so seed → loader.reload() must be atomic. Without
 * it, concurrent opens in different cwds interleave and clear each other.
 */
describe('B1.2 seed→reload critical section (review major 2)', () => {
  async function loadTracked(cwd: string, events: string[], useSection: boolean): Promise<Extension[]> {
    const body = async (): Promise<Extension[]> => {
      events.push(`enter:${cwd}`);
      await cache.seed(cwd, agentDir);
      // Stand-in for the loader's own async resolution window, during which a
      // competing seed would change the global slot.
      await new Promise((resolve) => setTimeout(resolve, 20));
      const loader = new DefaultResourceLoader({ cwd, agentDir });
      await loader.reload();
      events.push(`exit:${cwd}`);
      return loader.getExtensions().extensions;
    };
    return useSection ? runExtensionLoadCriticalSection(body) : body();
  }

  it('serialises concurrent different-cwd loads and keeps the cache effective', async () => {
    const events: string[] = [];
    const [a, b] = await Promise.all([
      loadTracked(cwdA, events, true),
      loadTracked(cwdB, events, true),
    ]);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(events).toEqual([`enter:${cwdA}`, `exit:${cwdA}`, `enter:${cwdB}`, `exit:${cwdB}`]);
    expect(cache.stats.imports).toBe(1);
  });

  it('interleaves without the critical section (the review hazard, as a control)', async () => {
    const events: string[] = [];
    await Promise.all([
      loadTracked(cwdA, events, false),
      loadTracked(cwdB, events, false),
    ]);
    // Both entered before either exited: the global slot changed mid-interval.
    expect(events.slice(0, 2)).toEqual([`enter:${cwdA}`, `enter:${cwdB}`]);
  });
});

/**
 * Round-2 review finding 1: `session.reload()` clears the SDK's process-global
 * extension cache, so it must run in the same critical section as seed→load.
 */
describe('B1.2 reload paths share the seed→load critical section', () => {
  it('runs PiService.reloadSession inside the critical section', async () => {
    const { PiService } = await import('../../../src/pi/pi-service.js');
    const service = new PiService();
    const order: string[] = [];
    const sessions = (service as unknown as { sessions: Map<string, unknown> }).sessions;
    sessions.set('s1', {
      reload: async () => {
        order.push('reload:start');
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push('reload:end');
      },
    });

    const open = runExtensionLoadCriticalSection(async () => {
      order.push('open:start');
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push('open:end');
    });
    const reload = service.reloadSession('s1');
    await Promise.all([open, reload]);

    expect(order).toEqual(['open:start', 'open:end', 'reload:start', 'reload:end']);
  });

  it('keeps the cache effective when a reload races a session open', async () => {
    const events: string[] = [];
    const open = runExtensionLoadCriticalSection(async () => {
      events.push('open:enter');
      await cache.seed(cwdB, agentDir);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const loader = new DefaultResourceLoader({ cwd: cwdB, agentDir });
      await loader.reload();
      events.push('open:exit');
      return loader.getExtensions().extensions;
    });
    // A reload of an already-loaded loader (what session.reload() does): it calls
    // clearExtensionCache() internally, so it must not interleave with the open.
    const reload = runExtensionLoadCriticalSection(async () => {
      events.push('reload:enter');
      const loader = new DefaultResourceLoader({ cwd: cwdA, agentDir });
      await loader.reload();
      await loader.reload();
      events.push('reload:exit');
      return loader.getExtensions().extensions;
    });

    const [opened, reloaded] = await Promise.all([open, reload]);
    expect(opened).toHaveLength(1);
    expect(reloaded).toHaveLength(1);
    // Whole intervals, not interleaved halves.
    expect(events).toEqual(['open:enter', 'open:exit', 'reload:enter', 'reload:exit']);
    expect(cache.stats.imports).toBe(1);
  });
});
