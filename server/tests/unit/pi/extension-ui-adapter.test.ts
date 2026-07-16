import { describe, expect, it, vi } from 'vitest';

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
    },
    sessionPool: {
      createClientSession: vi.fn(),
      switchClientSession: vi.fn(),
      removeClient: vi.fn(),
    },
    getSessionManager: vi.fn(),
  };
}

describe('createCommandContextActions reload', () => {
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
