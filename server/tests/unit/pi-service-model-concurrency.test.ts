import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Controllable SDK mock: ModelRuntime.create is a spy whose behaviour each
 * test scripts via `createImpl`. `createCalls` counts loads.
 */
const ctrl = vi.hoisted(() => ({
  createCalls: 0,
  createImpl: async () => {
    throw new Error('createImpl not configured');
  },
  modelRuntime: null as unknown,
}));

vi.mock('@earendil-works/pi-coding-agent', () => ({
  ModelRuntime: {
    create: vi.fn(async () => {
      ctrl.createCalls++;
      return ctrl.createImpl();
    }),
  },
  SessionManager: { create: vi.fn(), open: vi.fn(), inMemory: vi.fn(), continueRecent: vi.fn().mockResolvedValue({}), list: vi.fn().mockResolvedValue([]), listAll: vi.fn().mockResolvedValue([]) },
  DefaultResourceLoader: vi.fn().mockImplementation(() => ({
    reload: vi.fn().mockResolvedValue(undefined),
    getExtensions: vi.fn().mockReturnValue({ extensions: [], errors: [] }),
  })),
}));

vi.mock('../../src/config.js', () => ({
  config: {
    jwtSecret: 'test-secret',
    jwtExpiresIn: '15m',
    jwtRefreshExpiresIn: '7d',
    piAgentDir: '/tmp/pi-agent',
    sessionDir: '/tmp/sessions',
    piOpenrouterModelsEnabled: false, // skip OpenRouter cache path in initialize
  },
}));

import { PiService } from '../../src/pi/pi-service.js';

function makeRuntime(models: Array<{ id: string; name: string; provider: string }>) {
  return {
    setRuntimeApiKey: vi.fn().mockResolvedValue(undefined),
    getError: vi.fn().mockReturnValue(undefined),
    getModels: vi.fn().mockReturnValue(models),
    getModel: vi.fn((provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id)),
    getAvailable: vi.fn().mockResolvedValue(models),
    hasConfiguredAuth: vi.fn().mockReturnValue(false),
    registerProvider: vi.fn(),
  };
}

/**
 * R1: PiService model-cache (initialize) loading must be concurrency-safe:
 * concurrent first loads coalesce into one loader call, a failed first load is
 * cleared so a later call can retry (not permanently poisoned), and a valid
 * empty catalogue is not conflated with "not loaded".
 */
describe('R1: PiService initialize concurrency + retry', () => {
  beforeEach(() => {
    ctrl.createCalls = 0;
    ctrl.createImpl = async () => makeRuntime([{ id: 'm1', name: 'M1', provider: 'p' }]);
  });

  it('coalesces concurrent first loads into one loader call', async () => {
    let resolveCreate: (v: unknown) => void = () => {};
    ctrl.createImpl = () => new Promise((r) => { resolveCreate = r; });
    const service = new PiService();

    const p1 = service.initialize();
    const p2 = service.initialize();
    const p3 = service.initialize();
    expect(ctrl.createCalls).toBe(1); // only one load in flight
    resolveCreate(makeRuntime([{ id: 'm1', name: 'M1', provider: 'p' }]));
    await Promise.all([p1, p2, p3]);
    expect(ctrl.createCalls).toBe(1);
  });

  it('a failed first load is cleared so a subsequent call retries', async () => {
    let attempt = 0;
    ctrl.createImpl = async () => {
      attempt++;
      if (attempt === 1) throw new Error('transient load failure');
      return makeRuntime([{ id: 'm1', name: 'M1', provider: 'p' }]);
    };
    const service = new PiService();

    await expect(service.initialize()).rejects.toThrow('transient load failure');
    expect(ctrl.createCalls).toBe(1);

    // The cached rejection must be cleared so a retry is possible.
    await service.initialize();
    expect(ctrl.createCalls).toBe(2);
  });

  it('a successful load caches; a second initialize does not reload', async () => {
    const service = new PiService();
    await service.initialize();
    expect(ctrl.createCalls).toBe(1);
    await service.initialize();
    expect(ctrl.createCalls).toBe(1); // cached, no second load
  });

  it('a valid empty catalogue is loaded successfully (not conflated with not-loaded)', async () => {
    ctrl.createImpl = async () => makeRuntime([]); // empty catalogue
    const service = new PiService();
    await service.initialize(); // does not throw despite empty models
    expect(ctrl.createCalls).toBe(1);
    const models = await service.getAvailableModels();
    expect(models).toEqual([]);
  });

  it('allows overlapping model-stable execution leases while model changes wait for all readers', async () => {
    const service = new PiService();
    await service.initialize();
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    let secondEntered = false;
    const first = service.withSessionModelLock('s1', async () => firstGate);
    const second = service.withSessionModelLock('s1', async () => {
      secondEntered = true;
      await secondGate;
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(secondEntered).toBe(true);
    releaseFirst();
    releaseSecond();
    await Promise.all([first, second]);
  });

  it('serializes model changes behind a same-session execution boundary', async () => {
    const service = new PiService();
    await service.initialize();
    let releaseExecution!: () => void;
    const executionGate = new Promise<void>((resolve) => { releaseExecution = resolve; });
    const session = {
      sessionId: 's1',
      sessionFile: '/tmp/s1.jsonl',
      model: { provider: 'p', id: 'm1' },
      setModel: vi.fn(async (model: { provider: string; id: string }) => { session.model = model; }),
    };
    (service as unknown as { sessions: Map<string, typeof session> }).sessions.set('s1', session);

    const execution = service.withSessionModelLock('s1', async () => executionGate);
    await Promise.resolve();
    const modelChange = service.setModel('s1', 'p/m1');
    await Promise.resolve();

    expect(session.setModel).not.toHaveBeenCalled();
    releaseExecution();
    await Promise.all([execution, modelChange]);
    expect(session.setModel).toHaveBeenCalledTimes(1);
  });
});
