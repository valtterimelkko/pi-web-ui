import { describe, it, expect, vi } from 'vitest';
import { sendRuntimeAvailabilityStatus } from '../../../src/websocket/connection.js';
import { COMMAND_CODE_FULL_MODEL_CATALOGUE } from '../../../src/command-code/command-code-model-catalog.js';

describe('sendRuntimeAvailabilityStatus', () => {
  it('sends Claude Direct and OpenCode Direct availability when both runtimes are usable', async () => {
    const claudeService = {
      isAvailable: vi.fn().mockResolvedValue(true),
      validateAuth: vi.fn().mockResolvedValue({ ok: true, email: 'user@example.com' }),
    };
    const opencodeService = {
      isAvailable: vi.fn().mockResolvedValue(true),
      validateSetup: vi.fn().mockResolvedValue({ ok: true }),
    };
    const sentMessages: Array<{ clientId: string; message: unknown }> = [];

    await sendRuntimeAvailabilityStatus(
      'client-1',
      claudeService,
      opencodeService,
      (clientId, message) => sentMessages.push({ clientId, message }),
    );

    expect(sentMessages).toEqual(expect.arrayContaining([
      {
        clientId: 'client-1',
        message: { type: 'claude_available', available: true, error: null },
      },
      {
        clientId: 'client-1',
        message: { type: 'opencode_available', available: true, error: null },
      },
    ]));
  });

  it('reports runtime-specific setup and auth failures without suppressing either integration status', async () => {
    const claudeService = {
      isAvailable: vi.fn().mockResolvedValue(true),
      validateAuth: vi.fn().mockResolvedValue({ ok: false, error: 'Claude Code not logged in' }),
    };
    const opencodeService = {
      isAvailable: vi.fn().mockResolvedValue(true),
      validateSetup: vi.fn().mockResolvedValue({ ok: false, error: 'OpenCode server health check failed' }),
    };
    const sentMessages: Array<{ clientId: string; message: unknown }> = [];

    await sendRuntimeAvailabilityStatus(
      'client-1',
      claudeService,
      opencodeService,
      (clientId, message) => sentMessages.push({ clientId, message }),
    );

    expect(sentMessages).toEqual(expect.arrayContaining([
      {
        clientId: 'client-1',
        message: { type: 'claude_available', available: false, error: 'Claude Code not logged in' },
      },
      {
        clientId: 'client-1',
        message: { type: 'opencode_available', available: false, error: 'OpenCode server health check failed' },
      },
    ]));
  });

  it('publishes the complete ordered browser catalogue with runtime freshness metadata even when execution is unavailable', async () => {
    const claudeService = {
      isAvailable: vi.fn().mockResolvedValue(false),
      validateAuth: vi.fn(),
    };
    const opencodeService = {
      isAvailable: vi.fn().mockResolvedValue(false),
      validateSetup: vi.fn(),
    };
    const models = COMMAND_CODE_FULL_MODEL_CATALOGUE.map((id) => ({
      id,
      displayName: id,
      provider: 'command-code',
      reasoning: true,
      runnable: id === 'qwen/qwen3.8-max' || id === 'meta/muse-spark-1.2-contributor',
      status: id === 'qwen/qwen3.8-max' || id === 'meta/muse-spark-1.2-contributor' ? 'runnable' as const : 'evidence-only' as const,
      browserRunnable: false,
      supportsEffort: id === 'qwen/qwen3.8-max',
      effortLevels: id === 'qwen/qwen3.8-max' ? ['low', 'medium', 'xhigh'] as const : [] as const,
      ...(id === 'qwen/qwen3.8-max' ? { defaultEffort: 'medium' as const } : {}),
      effortCapabilityHash: 'a'.repeat(64),
    }));
    const commandCodeService = {
      init: vi.fn().mockResolvedValue(undefined),
      isEnabled: vi.fn().mockReturnValue(true),
      isBrowserEnabled: vi.fn().mockReturnValue(true),
      isBrowserAvailable: vi.fn().mockReturnValue(false),
      getModels: vi.fn().mockReturnValue(models),
      getHealth: vi.fn().mockReturnValue({ status: 'version_mismatch', checkedAt: '2026-08-08T03:00:00.000Z' }),
    };
    const sentMessages: Array<{ clientId: string; message: unknown }> = [];

    await sendRuntimeAvailabilityStatus(
      'client-1',
      claudeService,
      opencodeService,
      (clientId, message) => sentMessages.push({ clientId, message }),
      undefined,
      commandCodeService,
    );

    const availability = sentMessages.find(({ message }) => (message as { type?: string }).type === 'commandcode_available')?.message as Record<string, unknown>;
    expect(availability).toMatchObject({
      type: 'commandcode_available',
      available: false,
      enabled: true,
      availabilityStatus: 'version_mismatch',
      checkedAt: '2026-08-08T03:00:00.000Z',
      source: 'live-discovery',
    });
    expect((availability.models as Array<{ id: string }>).map((model) => model.id)).toEqual([...COMMAND_CODE_FULL_MODEL_CATALOGUE]);
    expect((availability.models as Array<{ status?: string; runnable?: boolean }>).filter((model) => model.runnable).map((model) => model.status)).toEqual(['runnable', 'runnable']);
  });

  it('does not expose the shadow catalogue on the browser availability channel', async () => {
    const claudeService = {
      isAvailable: vi.fn().mockResolvedValue(false),
      validateAuth: vi.fn(),
    };
    const opencodeService = {
      isAvailable: vi.fn().mockResolvedValue(false),
      validateSetup: vi.fn(),
    };
    const commandCodeService = {
      init: vi.fn().mockResolvedValue(undefined),
      isEnabled: vi.fn().mockReturnValue(true),
      isBrowserEnabled: vi.fn().mockReturnValue(false),
      isBrowserAvailable: vi.fn().mockReturnValue(false),
      getModels: vi.fn().mockReturnValue([{ id: 'qwen/qwen3.8-max' }]),
      getHealth: vi.fn().mockReturnValue({ status: 'available', checkedAt: '2026-08-08T03:00:00.000Z' }),
    };
    const sentMessages: Array<{ clientId: string; message: unknown }> = [];

    await sendRuntimeAvailabilityStatus(
      'client-1',
      claudeService,
      opencodeService,
      (clientId, message) => sentMessages.push({ clientId, message }),
      undefined,
      commandCodeService,
    );

    const availability = sentMessages.find(({ message }) => (message as { type?: string }).type === 'commandcode_available')?.message as Record<string, unknown>;
    expect(availability).toMatchObject({ type: 'commandcode_available', available: false, enabled: false, models: [] });
    expect(commandCodeService.getModels).not.toHaveBeenCalled();
  });

  it('still sends OpenCode availability if the Claude availability check throws', async () => {
    const claudeService = {
      isAvailable: vi.fn().mockRejectedValue(new Error('which claude failed')),
      validateAuth: vi.fn(),
    };
    const opencodeService = {
      isAvailable: vi.fn().mockResolvedValue(true),
      validateSetup: vi.fn().mockResolvedValue({ ok: true }),
    };
    const sentMessages: Array<{ clientId: string; message: unknown }> = [];

    await sendRuntimeAvailabilityStatus(
      'client-1',
      claudeService,
      opencodeService,
      (clientId, message) => sentMessages.push({ clientId, message }),
    );

    expect(sentMessages).toEqual(expect.arrayContaining([
      {
        clientId: 'client-1',
        message: { type: 'claude_available', available: false, error: 'Claude availability check failed' },
      },
      {
        clientId: 'client-1',
        message: { type: 'opencode_available', available: true, error: null },
      },
    ]));
  });
});
