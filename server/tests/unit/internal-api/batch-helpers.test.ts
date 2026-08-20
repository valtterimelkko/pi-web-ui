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

function makePiDeps(options: { setModelRejects?: string; resolved?: { provider: string; id: string } } = {}) {
  const sessionPath = '/tmp/pi-sessions/session-a.jsonl';
  const multiSessionManager = {
    createAndSubscribe: vi.fn(async () => ({ sessionId: 'pi-session-a', sessionPath })),
    getAgentSession: vi.fn(() => ({ model: options.resolved ?? { provider: 'openai-codex', id: 'gpt-5.6-sol' }, setThinkingLevel: vi.fn() })),
    unsubscribeClient: vi.fn(),
    disposeLoadedSession: vi.fn(),
  };
  const sessionRegistry = { upsert: vi.fn(async () => undefined), delete: vi.fn(async () => undefined) };
  const piService = {
    setModel: vi.fn(async () => {
      if (options.setModelRejects) throw new Error(options.setModelRejects);
    }),
  };
  return {
    multiSessionManager,
    sessionRegistry,
    piService,
    deps: {
      commandCodeService: undefined,
      claudeService: {} as never,
      opencodeService: { isEnabled: () => false } as never,
      antigravityService: {} as never,
      multiSessionManager: multiSessionManager as never,
      sessionRegistry: sessionRegistry as never,
      piService: piService as never,
      internalClientId: 'test-client',
      cleanupRejectedSession: vi.fn(async () => undefined),
    },
  };
}

describe('Pi batch session creation (defect 9: truthful model application)', () => {
  it('fails loudly and cleans up when an explicit model selector is not applied', async () => {
    // The Part 3 shape: bare selector 'gpt-5.6-sol' — setModel rejects the
    // format, the old code swallowed the rejection, and the create response
    // echoed the requested model while the session stayed on its default.
    const { deps, multiSessionManager, sessionRegistry, piService } = makePiDeps({
      setModelRejects: 'Invalid model ID format: gpt-5.6-sol. Expected "provider/model-name"',
      resolved: { provider: 'openai-codex', id: 'gpt-5.6-luna' },
    });

    await expect(createOneSession({
      deps,
      entry: { runtime: 'pi', cwd: '/tmp', model: 'gpt-5.6-sol' },
    })).rejects.toMatchObject({ code: 'MODEL_NOT_APPLIED' });

    expect(piService.setModel).toHaveBeenCalledOnce();
    expect(multiSessionManager.unsubscribeClient).toHaveBeenCalled();
    expect(multiSessionManager.disposeLoadedSession).toHaveBeenCalled();
    expect(sessionRegistry.delete).toHaveBeenCalledWith('pi-session-a');
  });

  it('returns the RESOLVED model as model and echoes the request as modelSelector', async () => {
    const { deps } = makePiDeps({ resolved: { provider: 'openai-codex', id: 'gpt-5.6-sol' } });

    const result = await createOneSession({
      deps,
      entry: { runtime: 'pi', cwd: '/tmp', model: 'openai-codex/gpt-5.6-sol', thinkingLevel: 'medium' },
    });

    expect(result.runtime).toBe('pi');
    expect(result.model).toBe('openai-codex/gpt-5.6-sol');
    expect(result.modelSelector).toBe('openai-codex/gpt-5.6-sol');
  });

  it('reports the resolved default when no model was requested', async () => {
    const { deps } = makePiDeps({ resolved: { provider: 'openai-codex', id: 'gpt-5.6-luna' } });

    const result = await createOneSession({
      deps,
      entry: { runtime: 'pi', cwd: '/tmp' },
    });

    expect(result.model).toBe('openai-codex/gpt-5.6-luna');
    expect(result.modelSelector).toBeUndefined();
  });
});
