import { describe, it, expect, vi } from 'vitest';
import { sendRuntimeAvailabilityStatus } from '../../../src/websocket/connection.js';
import { ADVERTISED_IDS } from '../command-code/command-code-fixture.js';

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

  it('publishes the complete catalogue with a plain availability payload even when execution is unavailable', async () => {
    const claudeService = {
      isAvailable: vi.fn().mockResolvedValue(false),
      validateAuth: vi.fn(),
    };
    const opencodeService = {
      isAvailable: vi.fn().mockResolvedValue(false),
      validateSetup: vi.fn(),
    };
    const models = ADVERTISED_IDS.map((id) => ({
      id,
      displayName: id,
      provider: 'command-code',
      reasoning: true,
      effortLevels: id === 'qwen/qwen3.8-max' ? ['low', 'medium', 'xhigh'] as const : [] as const,
      ...(id === 'qwen/qwen3.8-max' ? { defaultEffort: 'medium' as const } : {}),
    }));
    const commandCodeService = {
      init: vi.fn().mockResolvedValue(undefined),
      isEnabled: vi.fn().mockReturnValue(true),
      isAvailable: vi.fn().mockReturnValue(false),
      getModels: vi.fn().mockReturnValue(models),
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
      error: 'Command Code runtime is unavailable',
    });
    expect(availability.availabilityStatus).toBeUndefined();
    expect(availability.checkedAt).toBeUndefined();
    expect(availability.source).toBeUndefined();
    expect((availability.models as Array<{ id: string }>).map((model) => model.id)).toEqual([...ADVERTISED_IDS]);
  });

  it('does not publish Command Code models while the runtime is disabled', async () => {
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
      isEnabled: vi.fn().mockReturnValue(false),
      isAvailable: vi.fn().mockReturnValue(false),
      getModels: vi.fn().mockReturnValue([{ id: 'qwen/qwen3.8-max', displayName: 'q', provider: 'command-code', reasoning: true, effortLevels: [] }]),
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
