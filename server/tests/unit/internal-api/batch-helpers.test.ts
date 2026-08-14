import { describe, expect, it, vi } from 'vitest';
import { createOneSession } from '../../../src/internal-api/routes/batch-helpers.js';

function makeDeps() {
  let initialised = false;
  const commandCodeService = {
    init: vi.fn(async () => { initialised = true; }),
    isShadowAvailable: vi.fn(() => initialised),
    isShadowEnabled: vi.fn(() => true),
    isAvailable: vi.fn(() => initialised),
    createSession: vi.fn(async (input: { cwd: string; model: string }) => ({
      sessionId: 'commandcode-batch-session',
      modelSelector: input.model,
      executionInstanceId: 'commandcode-default' as const,
      effort: undefined,
      effortSource: 'none' as const,
      defaultEffort: undefined,
      effortCapabilityHash: 'a'.repeat(64),
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
  it('initialises discovery before evaluating the shadow gate', async () => {
    const { deps, commandCodeService } = makeDeps();

    const result = await createOneSession({
      deps,
      entry: {
        runtime: 'commandcode',
        cwd: '/tmp',
        model: 'meta/muse-spark-1.2-contributor',
        invocationRole: 'implementation-child',
        commandCodeAttestation: {
          role: 'implementation-child',
          model: 'meta/muse-spark-1.2-contributor',
          cwd: '/tmp',
          effort: undefined,
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          nonce: 'nonce',
          parentSessionId: 'parent',
          signature: 'signature',
        },
      },
    });

    expect(commandCodeService.init).toHaveBeenCalledOnce();
    expect(commandCodeService.createSession).toHaveBeenCalledOnce();
    expect(result.runtime).toBe('commandcode');
  });
});
