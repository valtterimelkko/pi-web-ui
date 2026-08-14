import { describe, expect, it, vi } from 'vitest';
import { createOneSession } from '../../../src/internal-api/routes/batch-helpers.js';

function makeDeps() {
  let initialised = false;
  const commandCodeService = {
    init: vi.fn(async () => { initialised = true; }),
    isEnabled: vi.fn(() => true),
    isAvailable: vi.fn(() => initialised),
    createSession: vi.fn(async (input: { cwd: string; model: string }) => ({
      sessionId: 'commandcode-batch-session',
      modelSelector: input.model,
      executionInstanceId: 'commandcode-default' as const,
      effort: undefined,
      effortSource: 'none' as const,
      defaultEffort: undefined,
      cwd: input.cwd,
    })),
  };
  return {
    commandCodeService,
    deps: {
      commandCodeService,
      claudeService: {} as never,
      opencodeService: {} as never,
      antigravityService: {} as never,
      multiSessionManager: {} as never,
      sessionRegistry: {} as never,
      piService: {} as never,
      internalClientId: 'test-client',
      cleanupRejectedSession: vi.fn(async () => undefined),
    },
  };
}

describe('Command Code batch session creation', () => {
  it('initialises discovery before evaluating availability', async () => {
    const { deps, commandCodeService } = makeDeps();

    const result = await createOneSession({
      deps,
      entry: {
        runtime: 'commandcode',
        cwd: '/tmp',
        model: 'meta/muse-spark-1.2-contributor',
      },
    });

    expect(commandCodeService.init).toHaveBeenCalledOnce();
    expect(commandCodeService.createSession).toHaveBeenCalledOnce();
    expect(result.runtime).toBe('commandcode');
  });
});
