import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DefaultResourceLoader } from '@earendil-works/pi-coding-agent';
import { PiService } from '../../../src/pi/pi-service.js';
import { resetExtensionFactoryCache, getExtensionFactoryCache } from '../../../src/pi/extension-factory-cache.js';

/**
 * B1.2b correction 03 — PiService-level regression tests for factory-snapshot
 * OWNERSHIP (round-2 review major + cleanup minor).
 *
 * Unlike pi-service.test.ts, the SDK is only partially mocked: ModelRuntime,
 * SessionManager and createAgentSession are mocked, but DefaultResourceLoader,
 * SettingsManager and DefaultPackageManager are the REAL implementations, and
 * the extension factory cache uses the real jiti importer against a fixture
 * agent dir. `createAgentSession` captures the real per-session loader so the
 * tests can drive `reloadSession()` end to end.
 */

const h = vi.hoisted(() => ({
  configHolder: { piAgentDir: '/tmp/b12b-snapshot-default-agent' },
  modelRuntime: {
    setRuntimeApiKey: vi.fn().mockResolvedValue(undefined),
    getError: vi.fn().mockReturnValue(undefined),
    getModels: vi.fn().mockReturnValue([]),
    getAvailable: vi.fn().mockResolvedValue([]),
    registerProvider: vi.fn(),
    registerNativeProvider: vi.fn(),
    refresh: vi.fn().mockResolvedValue({ aborted: false, errors: new Map() }),
  },
  createAgentSessionImpl: vi.fn(),
}));

vi.mock('@earendil-works/pi-coding-agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@earendil-works/pi-coding-agent')>();
  let sessionCounter = 0;
  h.createAgentSessionImpl.mockImplementation(async (opts: { resourceLoader: DefaultResourceLoader }) => {
    const loader = opts.resourceLoader;
    const sessionId = `snapshot-session-${++sessionCounter}`;
    const session = {
      sessionId,
      subscribe: vi.fn(),
      setModel: vi.fn(),
      dispose: vi.fn(),
      waitForIdle: vi.fn(async () => undefined),
      sessionManager: {},
      // Mirrors AgentSession.reload(): re-runs the session's own resource loader.
      reload: vi.fn(async () => {
        await loader.reload();
      }),
      bindExtensions: vi.fn(async () => undefined),
    };
    return { session };
  });
  return {
    ...actual,
    ModelRuntime: { create: vi.fn().mockResolvedValue(h.modelRuntime) },
    createAgentSession: h.createAgentSessionImpl,
    SessionManager: {
      create: vi.fn().mockReturnValue({}),
      open: vi.fn().mockReturnValue({}),
      inMemory: vi.fn().mockReturnValue({}),
      continueRecent: vi.fn().mockResolvedValue({}),
      list: vi.fn().mockResolvedValue([]),
      listAll: vi.fn().mockResolvedValue([]),
    },
  };
});

vi.mock('fs/promises', () => ({
  access: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
  readFile: vi.fn().mockResolvedValue('{"type":"session","id":"snapshot-session-1"}\n'),
}));

vi.mock('../../../src/pi/session-cwd.js', () => ({
  readSessionIdentity: vi.fn(async () => 'snapshot-session-1'),
}));

vi.mock('../../../src/config.js', () => ({
  config: {
    jwtSecret: 'test-secret',
    jwtExpiresIn: '15m',
    jwtRefreshExpiresIn: '7d',
    get piAgentDir() {
      return h.configHolder.piAgentDir;
    },
    sessionDir: '/tmp/b12b-snapshot-sessions',
    piOpenrouterModelsEnabled: false,
  },
}));

const ISO_SOURCE_V1 = `export default function (pi) { pi.registerCommand('iso-echo', { description: 'iso', handler: async () => 'iso' }); }`;
const ISO_SOURCE_V2 = `export default function (pi) { pi.registerCommand('iso-echo-v2', { description: 'iso', handler: async () => 'iso' }); }`;

describe('PiService factory-snapshot ownership (correction 03)', () => {
  let root: string;
  let agentDir: string;
  let cwd: string;
  let service: PiService;
  let capturedLoader: DefaultResourceLoader | undefined;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'b12b-ownership-'));
    agentDir = join(root, 'agent');
    cwd = join(root, 'work');
    mkdirSync(join(agentDir, 'extensions', 'iso'), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(agentDir, 'extensions', 'iso', 'index.ts'), ISO_SOURCE_V1);
    h.configHolder.piAgentDir = agentDir;
    resetExtensionFactoryCache();
    // Allowlist the fixture extension id for the process cache under test.
    await getExtensionFactoryCache({ allowlist: ['iso'] });
    h.createAgentSessionImpl.mockImplementation(async (opts: { resourceLoader: DefaultResourceLoader }) => {
      capturedLoader = opts.resourceLoader;
      return {
        session: {
          sessionId: `snapshot-session-${h.createAgentSessionImpl.mock.calls.length}`,
          subscribe: vi.fn(),
          setModel: vi.fn(),
          dispose: vi.fn(),
          waitForIdle: vi.fn(async () => undefined),
          sessionManager: {},
          reload: vi.fn(async () => {
            await capturedLoader?.reload();
          }),
          bindExtensions: vi.fn(async () => undefined),
        },
      };
    });
    service = new PiService();
  });

  afterEach(async () => {
    await service.cleanup().catch(() => undefined);
    resetExtensionFactoryCache();
    rmSync(root, { recursive: true, force: true });
    capturedLoader = undefined;
  });

  const snapshots = (service: PiService): Map<string, unknown> =>
    (service as unknown as { sessionFactorySnapshots: Map<string, unknown> }).sessionFactorySnapshots;

  it('keeps the snapshot when a sibling owner still maps the session, and the sibling /reload picks up new code', async () => {
    const session = await service.createSession({ clientId: 'client-A', inMemory: true, cwd });
    const sessionId = session.sessionId;
    expect(snapshots(service).has(sessionId)).toBe(true);

    // Owner B maps the same session id (the sibling-owner shape removeClient
    // must preserve).
    (service as unknown as { clientSessionMap: Map<string, string> }).clientSessionMap.set('client-B', sessionId);

    service.removeClient('client-A');
    expect(session.dispose).not.toHaveBeenCalled();
    // Round-2 major: the snapshot must survive the non-last-owner release.
    expect(snapshots(service).has(sessionId)).toBe(true);

    // B's /reload picks up the changed extension code.
    writeFileSync(join(agentDir, 'extensions', 'iso', 'index.ts'), ISO_SOURCE_V2);
    await service.reloadSession(sessionId);
    const commands = capturedLoader!.getExtensions().extensions.flatMap((extension) => [...extension.commands.keys()]);
    expect(commands).toContain('iso-echo-v2');
  });

  it("a failed re-import on the sibling's reload surfaces as a load error with the EXACT plain-loader message", async () => {
    const session = await service.createSession({ clientId: 'client-A', inMemory: true, cwd });
    const sessionId = session.sessionId;
    (service as unknown as { clientSessionMap: Map<string, string> }).clientSessionMap.set('client-B', sessionId);
    service.removeClient('client-A');

    writeFileSync(
      join(agentDir, 'extensions', 'iso', 'index.ts'),
      'throw new ReferenceError("b12b-r2-parity-failure");\nexport default function () {};',
    );
    await service.reloadSession(sessionId);

    const result = capturedLoader!.getExtensions();
    const isoLoaded = result.extensions.find((extension) => extension.path.includes('/iso/'));
    expect(isoLoaded).toBeUndefined();
    const isoError = result.errors.find((error) => error.path.includes('/iso/'));
    expect(isoError).toBeDefined();
    // Exact SDK parity (round-2 minor): the surfaced text equals the plain
    // loader's for the same broken extension — no importer wrapping text.
    expect(isoError!.error).toBe('Failed to load extension: b12b-r2-parity-failure');
    const { DefaultResourceLoader } = await import('@earendil-works/pi-coding-agent');
    const plain = new DefaultResourceLoader({ cwd, agentDir });
    await plain.reload();
    const plainError = plain.getExtensions().errors.find((error) => error.path.includes('/iso/'));
    expect(plainError!.error).toBe(isoError!.error);
  });

  it('deletes the snapshot when session creation fails during bindExtensions', async () => {
    h.createAgentSessionImpl.mockImplementationOnce(async (opts: { resourceLoader: DefaultResourceLoader }) => {
      capturedLoader = opts.resourceLoader;
      return {
        session: {
          sessionId: 'snapshot-session-bind-fail',
          subscribe: vi.fn(),
          setModel: vi.fn(),
          dispose: vi.fn(),
          waitForIdle: vi.fn(async () => undefined),
          sessionManager: {},
          reload: vi.fn(async () => undefined),
          bindExtensions: vi.fn(async () => {
            throw new Error('bind failed');
          }),
        },
      };
    });
    await expect(service.createSession({ clientId: 'client-bind', inMemory: true, cwd })).rejects.toThrow('bind failed');
    expect(snapshots(service).size).toBe(0);
  });

  it('clears every remaining snapshot in cleanup()', async () => {
    await service.createSession({ clientId: 'client-D', inMemory: true, cwd });
    expect(snapshots(service).size).toBe(1);
    await service.cleanup();
    expect(snapshots(service).size).toBe(0);
  });
});
