import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/logging/logger.js', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { createCommandContextActions } from '../../../src/pi/extension-ui-adapter.js';

function createContext() {
  return {
    clientId: 'client-1',
    sessionId: 'session-1',
    piService: {
      removeClient: vi.fn(),
      cleanup: vi.fn().mockResolvedValue(undefined),
      reloadSession: vi.fn().mockResolvedValue(undefined),
      navigateSessionTree: vi.fn().mockResolvedValue({ cancelled: false }),
    },
    sessionPool: {
      createClientSession: vi.fn(),
      switchClientSession: vi.fn(),
      removeClient: vi.fn(),
    },
    waitForIdle: vi.fn().mockResolvedValue(undefined),
  };
}

describe('createCommandContextActions', () => {
  afterEach(() => vi.useRealTimers());

  it('delegates waitForIdle to the owning AgentSession', async () => {
    vi.useFakeTimers();
    const context = createContext();
    const actions = createCommandContextActions(context);

    const result = actions.waitForIdle();
    await vi.runAllTimersAsync();

    await expect(result).resolves.toBeUndefined();
    expect(context.waitForIdle).toHaveBeenCalledOnce();
  });

  it('advertises safe in-place reload support to loaded extensions', () => {
    const capability = Symbol.for('pi-web-ui:in-place-extension-reload');
    expect((globalThis as Record<symbol, unknown>)[capability]).toBe(true);
  });

  it('delegates tree navigation to the active AgentSession', async () => {
    const context = createContext();
    const actions = createCommandContextActions(context);

    const result = await actions.navigateTree('entry-2', { summarize: false, label: 'target' });

    expect(result).toEqual({ cancelled: false });
    expect(context.piService.navigateSessionTree).toHaveBeenCalledWith(
      'session-1',
      'entry-2',
      { summarize: false, label: 'target' },
    );
  });

  it('reloads the active AgentSession in place', async () => {
    const context = createContext();
    const actions = createCommandContextActions(context);

    await actions.reload();

    expect(context.piService.reloadSession).toHaveBeenCalledOnce();
    expect(context.piService.reloadSession).toHaveBeenCalledWith('session-1');
    expect(context.piService.removeClient).not.toHaveBeenCalled();
    expect(context.sessionPool.removeClient).not.toHaveBeenCalled();
  });

  it('propagates reload failures to the extension command', async () => {
    const context = createContext();
    context.piService.reloadSession.mockRejectedValueOnce(new Error('reload failed'));
    const actions = createCommandContextActions(context);

    await expect(actions.reload()).rejects.toThrow('reload failed');
  });
});
