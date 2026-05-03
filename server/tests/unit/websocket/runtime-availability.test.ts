import { describe, it, expect, vi } from 'vitest';
import { sendRuntimeAvailabilityStatus } from '../../../src/websocket/connection.js';

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
