import { describe, it, expect } from 'vitest';

// RED: module does not exist yet.
import {
  createPiDelivery,
  createClaudeDelivery,
  createAntigravityDelivery,
  createDefaultDeliveries,
  createNullDelivery,
} from '../../../src/talker/delivery.js';

describe('Pi delivery (existing path until H2 lands)', () => {
  it('steers a busy worker via the existing path and discloses that H2 is not wired', async () => {
    const calls: string[] = [];
    const delivery = createPiDelivery({
      isBusy: () => true,
      steer: async (_id, text) => { calls.push(`steer:${text}`); },
      prompt: async () => { calls.push('prompt'); },
    });
    const result = await delivery.deliver({ workerSessionId: 'pi-1', text: 'hold phase 3' });
    expect(result).toEqual({
      outcome: 'delivered',
      mechanism: 'steer',
      disclosure: expect.stringContaining('existing steer path'),
    });
    expect(calls).toEqual(['steer:hold phase 3']);
  });

  it('prompts an idle worker through the existing prompt path', async () => {
    const calls: string[] = [];
    const delivery = createPiDelivery({
      isBusy: () => false,
      steer: async () => { calls.push('steer'); },
      prompt: async (_id, text) => { calls.push(`prompt:${text}`); },
    });
    const result = await delivery.deliver({ workerSessionId: 'pi-1', text: 'hold phase 3' });
    expect(result.outcome).toBe('delivered');
    expect(result).toMatchObject({ mechanism: 'prompt' });
    expect(calls).toEqual(['prompt:hold phase 3']);
  });

  it('refuses honestly when the underlying path throws (never claims success)', async () => {
    const delivery = createPiDelivery({
      isBusy: () => true,
      steer: async () => { throw new Error('session gone'); },
      prompt: async () => { throw new Error('unreachable'); },
    });
    const result = await delivery.deliver({ workerSessionId: 'pi-1', text: 'x' });
    expect(result.outcome).toBe('refused');
    expect((result as { reason: string }).reason).toContain('session gone');
  });
});

describe('Claude delivery (SDK backend only)', () => {
  const sdkDeps = (overrides: Partial<Parameters<typeof createClaudeDelivery>[0]> = {}) => ({
    getBackendMode: () => 'sdk' as const,
    isRunning: () => true,
    steer: () => true,
    followUp: () => true,
    sendPrompt: async () => {},
    ...overrides,
  });

  it('refuses honestly on a non-SDK backend — never silently degrades', async () => {
    const delivery = createClaudeDelivery(sdkDeps({ getBackendMode: () => 'other' }));
    const result = await delivery.deliver({ workerSessionId: 'c-1', text: 'x' });
    expect(result.outcome).toBe('refused');
    expect((result as { reason: string }).reason).toMatch(/SDK backend/);
  });

  it('refuses honestly when the backend cannot be proven', async () => {
    const delivery = createClaudeDelivery(sdkDeps({ getBackendMode: () => 'unknown' }));
    const result = await delivery.deliver({ workerSessionId: 'c-1', text: 'x' });
    expect(result.outcome).toBe('refused');
  });

  it('steers a running SDK session', async () => {
    const delivery = createClaudeDelivery(sdkDeps());
    const result = await delivery.deliver({ workerSessionId: 'c-1', text: 'x' });
    expect(result).toMatchObject({ outcome: 'delivered', mechanism: 'steer' });
  });

  it('falls back to follow-up (queued) when steer is not accepted mid-run', async () => {
    const delivery = createClaudeDelivery(sdkDeps({ steer: () => false }));
    const result = await delivery.deliver({ workerSessionId: 'c-1', text: 'x' });
    expect(result).toMatchObject({ outcome: 'queued', mechanism: 'follow_up' });
  });

  it('prompts an idle SDK session', async () => {
    const delivery = createClaudeDelivery(sdkDeps({ isRunning: () => false }));
    const result = await delivery.deliver({ workerSessionId: 'c-1', text: 'x' });
    expect(result).toMatchObject({ outcome: 'delivered', mechanism: 'prompt' });
  });
});

describe('Antigravity delivery (follow-up only)', () => {
  it('queues behind the current turn as a first-class outcome', async () => {
    const delivery = createAntigravityDelivery({ followUp: async () => true });
    const result = await delivery.deliver({ workerSessionId: 'a-1', text: 'x' });
    expect(result).toMatchObject({ outcome: 'queued', mechanism: 'follow_up' });
    expect((result as { disclosure: string }).disclosure).toMatch(/after this turn/i);
  });

  it('refuses honestly when no turn is running (the talker never starts turns)', async () => {
    const delivery = createAntigravityDelivery({ followUp: async () => false });
    const result = await delivery.deliver({ workerSessionId: 'a-1', text: 'x' });
    expect(result.outcome).toBe('refused');
    expect((result as { reason: string }).reason).toMatch(/follow-up only/i);
  });
});

describe('Null delivery (harness runner/tests)', () => {
  it('records the verbatim text it would have delivered', async () => {
    const delivery = createNullDelivery();
    await delivery.deliver({ workerSessionId: 'w', text: 'verbatim instruction' });
    const result = await delivery.deliver({ workerSessionId: 'w', text: 'second' });
    expect(result).toMatchObject({ outcome: 'delivered', mechanism: 'prompt' });
    expect(delivery.deliveredTexts()).toEqual(['verbatim instruction', 'second']);
  });
});

describe('Pi delivery — the worker is loaded on demand (restart robustness)', () => {
  /**
   * Operator incident, 2026-09-16: a production restart landed mid voice
   * session. Pi loads sessions lazily and keys them by PATH, so after the
   * restart the worker was not in memory; the relay resolved the wire id to a
   * path only against the LOADED set, could not, prompted by id, and the
   * MultiSessionManager threw "Session … does not exist". The talker spoke
   * REFUSED_ACK and the operator's instruction was lost.
   *
   * A relay must therefore be able to LOAD the worker itself.
   */
  it('loads an unloaded worker before the busy check and the prompt, then releases the load', async () => {
    const calls: string[] = [];
    const delivery = createPiDelivery({
      isBusy: (path) => { calls.push(`isBusy:${path}`); return false; },
      steer: async () => { calls.push('steer'); },
      prompt: async (path, text) => { calls.push(`prompt:${path}:${text}`); },
      ensureReady: async (ref) => {
        calls.push(`ensureReady:${ref}`);
        return { path: '/sessions/w.jsonl', loadedHere: true };
      },
      release: (path) => { calls.push(`release:${path}`); },
    });

    const result = await delivery.deliver({ workerSessionId: 'w-id', text: 'do the thing' });

    expect(result).toMatchObject({ outcome: 'delivered', mechanism: 'prompt' });
    expect(calls).toEqual([
      'ensureReady:w-id',
      'isBusy:/sessions/w.jsonl',
      'prompt:/sessions/w.jsonl:do the thing',
      'release:/sessions/w.jsonl',
    ]);
  });

  it('leaves a worker that was already loaded alone (no load, no release)', async () => {
    const calls: string[] = [];
    const delivery = createPiDelivery({
      isBusy: () => false,
      steer: async () => {},
      prompt: async (path) => { calls.push(`prompt:${path}`); },
      ensureReady: async () => { calls.push('ensureReady'); return { path: '/sessions/w.jsonl', loadedHere: false }; },
      release: () => { calls.push('release'); },
    });

    await delivery.deliver({ workerSessionId: 'w-id', text: 'x' });
    expect(calls).toEqual(['ensureReady', 'prompt:/sessions/w.jsonl']);
  });

  it('steers a busy worker through the loaded path without releasing it', async () => {
    const calls: string[] = [];
    const delivery = createPiDelivery({
      isBusy: () => true,
      steer: async (path, text) => { calls.push(`steer:${path}:${text}`); },
      prompt: async () => { calls.push('prompt'); },
      ensureReady: async () => { calls.push('ensureReady'); return { path: '/sessions/w.jsonl', loadedHere: false }; },
      release: () => { calls.push('release'); },
    });

    const result = await delivery.deliver({ workerSessionId: 'w-id', text: 'hold on' });
    expect(result).toMatchObject({ outcome: 'delivered', mechanism: 'steer' });
    expect(calls).toEqual(['ensureReady', 'steer:/sessions/w.jsonl:hold on']);
  });

  it('refuses honestly, naming the load failure, when the worker cannot be loaded', async () => {
    const delivery = createPiDelivery({
      isBusy: () => false,
      steer: async () => {},
      prompt: async () => { throw new Error('unreachable'); },
      ensureReady: async () => { throw new Error('session id not in the registry'); },
    });

    const result = await delivery.deliver({ workerSessionId: 'w-id', text: 'x' });
    expect(result.outcome).toBe('refused');
    expect((result as { reason: string }).reason).toContain('session id not in the registry');
  });

  it('releases the load even when the prompt fails (no leaked subscription)', async () => {
    const calls: string[] = [];
    const delivery = createPiDelivery({
      isBusy: () => false,
      steer: async () => {},
      prompt: async () => { calls.push('prompt'); throw new Error('turn blew up'); },
      ensureReady: async () => ({ path: '/sessions/w.jsonl', loadedHere: true }),
      release: (path) => { calls.push(`release:${path}`); },
    });

    const result = await delivery.deliver({ workerSessionId: 'w-id', text: 'x' });
    expect(result.outcome).toBe('refused');
    expect(calls).toEqual(['prompt', 'release:/sessions/w.jsonl']);
  });
});

describe('Pi delivery wiring — relay load-on-demand against a real manager shape', () => {
  const fakeManager = (overrides: Record<string, unknown> = {}) => {
    const calls: string[] = [];
    const manager = {
      loaded: new Set<string>(),
      hasSession: (path: string) => manager.loaded.has(path),
      resolveSessionRef: (ref: string) => (manager.loaded.has(ref) ? ref : undefined),
      getSessionStatus: () => undefined,
      subscribeClient: async (_clientId: string, path: string, cwd?: string) => {
        calls.push(`subscribe:${path}${cwd ? `:${cwd}` : ''}`);
        manager.loaded.add(path);
        return { sessionPath: path, status: 'idle' };
      },
      unsubscribeClient: (_clientId: string, path: string) => { calls.push(`unsubscribe:${path}`); },
      steer: async () => { calls.push('steer'); },
      prompt: async (path: string, text: string) => { calls.push(`prompt:${path}:${text}`); },
      ...overrides,
    };
    return { manager, calls };
  };

  it('resolves an id to its on-disk session, loads it, delivers, then hands the load back', async () => {
    const { manager, calls } = fakeManager();
    const deliveries = await createDefaultDeliveries({
      multiSessionManager: manager as never,
      resolveWorkerSession: async (id) =>
        id === 'w-id' ? { path: '/sessions/w.jsonl', cwd: '/root/project' } : undefined,
    });

    const result = await deliveries.pi.deliver({ workerSessionId: 'w-id', text: 'do the thing' });

    expect(result).toMatchObject({ outcome: 'delivered', mechanism: 'prompt' });
    expect(calls).toEqual([
      'subscribe:/sessions/w.jsonl:/root/project',
      'prompt:/sessions/w.jsonl:do the thing',
      'unsubscribe:/sessions/w.jsonl',
    ]);
  });

  it('does not reload a worker that is already in memory', async () => {
    const { manager, calls } = fakeManager({ resolveSessionRef: (ref: string) => ref });
    manager.loaded.add('/sessions/w.jsonl');
    const deliveries = await createDefaultDeliveries({ multiSessionManager: manager as never });

    await deliveries.pi.deliver({ workerSessionId: '/sessions/w.jsonl', text: 'second relay' });

    expect(calls).toEqual(['prompt:/sessions/w.jsonl:second relay']);
  });

  it('refuses loudly, naming the session, when the reference resolves nowhere', async () => {
    // A reference the registry cannot resolve is still attempted as given, and
    // the load then fails exactly like the manager would: the relay never
    // invents a session, and the operator hears why.
    const { manager, calls } = fakeManager({
      subscribeClient: async (_clientId: string, path: string) => {
        calls.push(`subscribe:${path}`);
        throw new Error(`Session ${path} does not exist`);
      },
    });
    const deliveries = await createDefaultDeliveries({
      multiSessionManager: manager as never,
      resolveWorkerSession: async () => undefined,
    });

    const result = await deliveries.pi.deliver({ workerSessionId: 'ghost-id', text: 'x' });

    expect(calls).toEqual(['subscribe:ghost-id']);
    expect(result.outcome).toBe('refused');
    expect((result as { reason: string }).reason).toContain('ghost-id');
  });
});
