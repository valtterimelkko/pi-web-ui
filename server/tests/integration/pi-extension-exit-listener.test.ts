/**
 * Host-side exit-listener guard (B1 heap retainer 2, A1 soak §3).
 *
 * The A1 soak found that `~/.pi/agent/extensions/subagent/index.ts` registered
 * `process.once("exit", …)` at module scope, and because Pi evaluates extension
 * modules once per session, every session added a listener that retained its
 * session context (202 retained `AgentSession`s in the 1 GiB snapshot,
 * reachable through `process._events.exit`).
 *
 * The fix for that specific retainer lives in the extension store
 * (`pi-enhancement/subagent/index.ts`: one process-global hook holding only
 * WeakRefs; RED→GREEN in `pi-enhancement/tests/subagent-exit-listener.test.mjs`).
 * This file is the HOST-side half: it pins what the host itself can and cannot
 * guarantee, using the real SDK extension loader (`loadExtensions`, which uses
 * a fresh jiti with `moduleCache: false`, so each call re-evaluates the module
 * exactly as a new session does) and a deliberately badly-behaved fixture
 * extension.
 *
 * What the host guarantees: its own Pi session lifecycle (create → dispose)
 * adds no process exit listener and leaves no session in `PiService` or
 * `MultiSessionManager` maps.
 *
 * What the host cannot guarantee, and why the fix must live in the extension:
 * a module-scope `process.once` inside an extension is evaluated by the SDK's
 * per-session module loader. The host has no handle on that closure, so no
 * host-side change can keep `process.listenerCount("exit")` flat while an
 * extension keeps registering one. The test below records that SDK-owned
 * behaviour rather than pretending the host can enforce it; if the SDK ever
 * starts caching extension modules per process, this test fails and the host
 * guarantee in the first test can be widened to cover extension listeners too.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PiService } from '../../src/pi/pi-service.js';
import { MultiSessionManager } from '../../src/pi/multi-session-manager.js';

const loaderPath = fileURLToPath(
  new URL(
    '../../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js',
    import.meta.url,
  ),
);
const eventBusPath = fileURLToPath(
  new URL('../../../node_modules/@earendil-works/pi-coding-agent/dist/core/event-bus.js', import.meta.url),
);
const FIXTURE_EXTENSION = fileURLToPath(new URL('../fixtures/exit-listener-extension.ts', import.meta.url));

interface FakeAgentSession {
  sessionId: string;
  sessionFile?: string;
  sessionPath?: string;
  dispose: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  setModel: ReturnType<typeof vi.fn>;
  getContextUsage: ReturnType<typeof vi.fn>;
}

let sessionCounter = 0;
const services: PiService[] = [];
const managers: MultiSessionManager[] = [];

function internals(service: PiService): {
  sessions: Map<string, unknown>;
  clientSessionMap: Map<string, string>;
  eventHandlers: Map<string, unknown>;
  clientWebUIContexts: Map<string, unknown>;
} {
  return service as never;
}

function installFakeCreateSession(service: PiService): void {
  vi.spyOn(service, 'createSession').mockImplementation(async (options) => {
    sessionCounter += 1;
    const sessionId = `cycle-sid-${sessionCounter}`;
    const session: FakeAgentSession = {
      sessionId,
      sessionFile: `/tmp/pi-sessions/${sessionId}.jsonl`,
      sessionPath: `/tmp/pi-sessions/${sessionId}.jsonl`,
      dispose: vi.fn(),
      abort: vi.fn(),
      subscribe: vi.fn(),
      setModel: vi.fn(),
      getContextUsage: vi.fn(() => undefined),
    };
    internals(service).clientSessionMap.set(options.clientId, sessionId);
    if (options.webUIContext) internals(service).clientWebUIContexts.set(options.clientId, options.webUIContext);
    internals(service).sessions.set(sessionId, session);
    return session as never;
  });
}

afterEach(() => {
  for (const manager of managers.splice(0)) manager.dispose();
  for (const service of services.splice(0)) service.cleanup();
  vi.restoreAllMocks();
});

describe('host-side exit-listener guard (B1 retainer 2)', () => {
  it('repeated create→dispose cycles leave no Pi session referenced and add no host exit listener', async () => {
    const baseline = process.listenerCount('exit');
    const service = new PiService();
    services.push(service);
    installFakeCreateSession(service);
    const manager = new MultiSessionManager(service, vi.fn(), {
      enableMemoryMonitoring: false,
      cleanupIntervalMs: 3_600_000,
    } as never);
    managers.push(manager);

    for (let i = 0; i < 5; i += 1) {
      const status = await manager.createAndSubscribe(`cycle-client-${i}`, '/work');
      // B5: disposeLoadedSession is now awaited (bounded shutdown emission first).
      await expect(manager.disposeLoadedSession(status.sessionPath)).resolves.toBe(true);
    }

    expect(internals(service).sessions.size).toBe(0);
    expect(internals(service).eventHandlers.size).toBe(0);
    expect(internals(service).clientSessionMap.size).toBe(0);
    expect(internals(service).clientWebUIContexts.size).toBe(0);
    expect((manager as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(0);
    expect(process.listenerCount('exit')).toBe(baseline);
  });

  it('records the SDK-owned limit: each extension evaluation of a module-scope listener adds one', async (ctx) => {
    if (!existsSync(loaderPath) || !existsSync(FIXTURE_EXTENSION)) {
      ctx.skip('SDK extension loader or fixture not available in this layout');
      return;
    }
    const loader = (await import(loaderPath)) as {
      createExtensionRuntime: () => unknown;
      loadExtensions: (
        paths: string[],
        cwd: string,
        eventBus: unknown,
        runtime: unknown,
      ) => Promise<{ errors: unknown[]; extensions: unknown[] }>;
    };
    const { createEventBus } = (await import(eventBusPath)) as { createEventBus: () => unknown };

    const beforeListeners = process.listeners('exit');
    // Three session-scoped module evaluations, exactly as three sessions would.
    for (let i = 0; i < 3; i += 1) {
      const loaded = await loader.loadExtensions(
        [FIXTURE_EXTENSION],
        process.cwd(),
        createEventBus(),
        loader.createExtensionRuntime(),
      );
      expect(loaded.errors).toEqual([]);
      expect(loaded.extensions).toHaveLength(1);
    }
    const added = process.listeners('exit').filter((listener) => !beforeListeners.includes(listener));
    // This is the gap, not a pass: the host has no handle on an extension's
    // module-scope closure, so the flat-count assertion above can only cover the
    // host's own lifecycle. Clean the fixture's listeners up and assert exactly
    // the extension-attributable growth so any change in SDK behaviour is loud.
    for (const listener of added) process.removeListener('exit', listener);
    expect(added).toHaveLength(3);
  });
});
