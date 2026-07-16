import { describe, it, expect, vi } from 'vitest';
import { TransferService } from '../../../src/session-transfer/transfer-service.js';
import type { TransferServiceConfig } from '../../../src/session-transfer/transfer-service.js';
import type { RegistryEntry } from '../../../src/session-registry.js';
import { TRANSFER_ERROR_CODES } from '../../../src/session-transfer/types.js';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

function makeRegistryEntry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    id: 'src-1',
    sdkType: 'claude',
    path: '/path/to/session.jsonl',
    cwd: '/home/user/project',
    firstMessage: 'Hello',
    messageCount: 2,
    createdAt: '2025-01-01T00:00:00.000Z',
    lastActivity: '2025-01-02T00:00:00.000Z',
    status: 'idle',
    ...overrides,
  };
}

function makeConfig(overrides: Partial<TransferServiceConfig> = {}): TransferServiceConfig {
  const registry = {
    get: vi.fn().mockResolvedValue(undefined),
    getByPath: vi.fn().mockResolvedValue(undefined),
    upsert: vi.fn().mockResolvedValue(makeRegistryEntry()),
  };

  return {
    registry: registry as unknown as import('../../../src/session-registry.js').SessionRegistryManager,
    claudeService: null,
    opencodeService: null,
    ...overrides,
  };
}

function makeClaudeServiceMock() {
  return {
    isRunning: vi.fn().mockReturnValue(false),
    createSession: vi.fn().mockResolvedValue({ sessionId: 'new-claude-1', claudeSessionId: 'claude-abc' }),
    sendPrompt: vi.fn((_sessionId, _prompt, onEvent, onComplete) => {
      onEvent({ type: 'agent_start' });
      onComplete(undefined);
    }),
    loadSessionHistory: vi.fn().mockResolvedValue([
      { type: 'user', sessionId: 'src-1', content: 'Hello', timestamp: 1700000000000 },
      { type: 'assistant', sessionId: 'src-1', content: 'Hi there!', timestamp: 1700000001000 },
    ]),
  };
}

function makeOpenCodeServiceMock() {
  return {
    isRunning: vi.fn().mockReturnValue(false),
    createSession: vi.fn().mockResolvedValue({ sessionId: 'new-oc-1', opencodeSessionId: 'oc-abc' }),
    sendPrompt: vi.fn((_sessionId, _prompt, onEvent, onComplete) => {
      onEvent({ type: 'agent_start' });
      onComplete(undefined);
    }),
    getReplayEvents: vi.fn().mockResolvedValue([
      { type: 'message_start', message: { id: 'u1', role: 'user', content: 'Hello' }, timestamp: 1700000000000 },
      { type: 'message_end', message: { id: 'u1' } },
      { type: 'message_start', message: { id: 'a1', role: 'assistant' }, timestamp: 1700000001000 },
      { type: 'message_update', message: { id: 'a1' }, assistantMessageEvent: { type: 'text_delta', delta: 'Hi!' } },
      { type: 'message_end', message: { id: 'a1' } },
    ]),
  };
}

describe('TransferService', () => {
  describe('executeTransfer', () => {
    it('rejects invalid request', async () => {
      const service = new TransferService(makeConfig());
      const result = await service.executeTransfer({
        sourceSessionId: '',
        targetSessionId: 'tgt-1',
        scope: 'visible_full',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(TRANSFER_ERROR_CODES.INVALID_REQUEST);
    });

    it('rejects when source not found', async () => {
      const config = makeConfig();
      const service = new TransferService(config);
      const result = await service.executeTransfer({
        sourceSessionId: 'missing',
        targetSessionId: 'tgt-1',
        scope: 'visible_full',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(TRANSFER_ERROR_CODES.SOURCE_NOT_FOUND);
    });

    it('rejects self-transfer', async () => {
      const service = new TransferService(makeConfig());
      const result = await service.executeTransfer({
        sourceSessionId: 'same-1',
        targetSessionId: 'same-1',
        scope: 'visible_full',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(TRANSFER_ERROR_CODES.SELF_TRANSFER);
    });

    it('rejects when target not found', async () => {
      const config = makeConfig();
      (config.registry.get as ReturnType<typeof vi.fn>)
        .mockImplementation(async (id: string) => {
          if (id === 'src-1') return makeRegistryEntry();
          return undefined;
        });

      const claudeMock = makeClaudeServiceMock();
      config.claudeService = claudeMock as unknown as import('../../../src/claude/claude-service.js').ClaudeService;

      const service = new TransferService(config);
      const result = await service.executeTransfer({
        sourceSessionId: 'src-1',
        targetSessionId: 'missing-tgt',
        scope: 'visible_full',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(TRANSFER_ERROR_CODES.TARGET_NOT_FOUND);
    });

    it('rejects when target is busy', async () => {
      const config = makeConfig();
      (config.registry.get as ReturnType<typeof vi.fn>)
        .mockImplementation(async (id: string) => {
          if (id === 'src-1') return makeRegistryEntry();
          if (id === 'busy-tgt') return makeRegistryEntry({ id: 'busy-tgt' });
          return undefined;
        });

      const claudeMock = makeClaudeServiceMock();
      claudeMock.isRunning.mockReturnValue(true);
      config.claudeService = claudeMock as unknown as import('../../../src/claude/claude-service.js').ClaudeService;

      const service = new TransferService(config);
      const result = await service.executeTransfer({
        sourceSessionId: 'src-1',
        targetSessionId: 'busy-tgt',
        scope: 'visible_full',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(TRANSFER_ERROR_CODES.TARGET_BUSY);
    });

    it('transfers Claude → Claude existing target', async () => {
      const config = makeConfig();
      (config.registry.get as ReturnType<typeof vi.fn>)
        .mockImplementation(async (id: string) => {
          if (id === 'src-1') return makeRegistryEntry({ id: 'src-1' });
          if (id === 'tgt-1') return makeRegistryEntry({ id: 'tgt-1' });
          return undefined;
        });

      const claudeMock = makeClaudeServiceMock();
      config.claudeService = claudeMock as unknown as import('../../../src/claude/claude-service.js').ClaudeService;

      const service = new TransferService(config);
      const result = await service.executeTransfer({
        sourceSessionId: 'src-1',
        targetSessionId: 'tgt-1',
        scope: 'visible_full',
      });

      expect(result.success).toBe(true);
      expect(result.targetSessionId).toBe('tgt-1');
      expect(result.createdNewSession).toBe(false);
      expect(claudeMock.sendPrompt).toHaveBeenCalledWith('tgt-1', expect.any(String), expect.any(Function), expect.any(Function));
    });

    it('transfers Claude → new Claude session', async () => {
      const config = makeConfig();
      (config.registry.get as ReturnType<typeof vi.fn>)
        .mockImplementation(async (id: string) => {
          if (id === 'src-1') return makeRegistryEntry({ id: 'src-1' });
          if (id === 'new-claude-1') return makeRegistryEntry({ id: 'new-claude-1' });
          return undefined;
        });

      const claudeMock = makeClaudeServiceMock();
      config.claudeService = claudeMock as unknown as import('../../../src/claude/claude-service.js').ClaudeService;

      const service = new TransferService(config);
      const result = await service.executeTransfer({
        sourceSessionId: 'src-1',
        createNew: true,
        targetSdkType: 'claude',
        targetCwd: '/home/user',
        scope: 'visible_full',
      });

      expect(result.success).toBe(true);
      expect(result.createdNewSession).toBe(true);
      expect(claudeMock.createSession).toHaveBeenCalledWith('/home/user');
    });

    it('transfers OpenCode → OpenCode existing target', async () => {
      const config = makeConfig();
      (config.registry.get as ReturnType<typeof vi.fn>)
        .mockImplementation(async (id: string) => {
          if (id === 'src-1') return makeRegistryEntry({ id: 'src-1', sdkType: 'opencode' });
          if (id === 'tgt-1') return makeRegistryEntry({ id: 'tgt-1', sdkType: 'opencode' });
          return undefined;
        });

      const ocMock = makeOpenCodeServiceMock();
      config.opencodeService = ocMock as unknown as import('../../../src/opencode/opencode-service.js').OpenCodeService;

      const service = new TransferService(config);
      const result = await service.executeTransfer({
        sourceSessionId: 'src-1',
        targetSessionId: 'tgt-1',
        scope: 'visible_full',
      });

      expect(result.success).toBe(true);
      expect(ocMock.sendPrompt).toHaveBeenCalledWith('tgt-1', expect.any(String), expect.any(Function), expect.any(Function));
    });

    it('completes the transfer once the target accepts it instead of waiting for the whole agent turn', async () => {
      const config = makeConfig();
      (config.registry.get as ReturnType<typeof vi.fn>)
        .mockImplementation(async (id: string) => {
          if (id === 'src-1') return makeRegistryEntry({ id: 'src-1' });
          if (id === 'tgt-1') return makeRegistryEntry({ id: 'tgt-1' });
          return undefined;
        });

      const claudeMock = makeClaudeServiceMock();
      let completeTurn: ((error?: Error) => void) | undefined;
      claudeMock.sendPrompt.mockImplementation((_sessionId, _prompt, onEvent, onComplete) => {
        completeTurn = onComplete;
        onEvent({ type: 'agent_start' });
      });
      config.claudeService = claudeMock as unknown as import('../../../src/claude/claude-service.js').ClaudeService;

      const result = await Promise.race([
        new TransferService(config).executeTransfer({
          sourceSessionId: 'src-1',
          targetSessionId: 'tgt-1',
          scope: 'visible_full',
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('transfer waited for target turn completion')), 50)),
      ]);

      expect(result.success).toBe(true);
      expect(completeTurn).toBeDefined();
    });

    it('fails cleanly instead of loading indefinitely when a target never accepts the handoff', async () => {
      const config = makeConfig();
      config.acceptanceTimeoutMs = 5;
      (config.registry.get as ReturnType<typeof vi.fn>)
        .mockImplementation(async (id: string) => {
          if (id === 'src-1') return makeRegistryEntry({ id: 'src-1' });
          if (id === 'tgt-1') return makeRegistryEntry({ id: 'tgt-1' });
          return undefined;
        });
      const claudeMock = makeClaudeServiceMock();
      claudeMock.sendPrompt.mockImplementation(() => undefined);
      config.claudeService = claudeMock as unknown as import('../../../src/claude/claude-service.js').ClaudeService;

      const result = await new TransferService(config).executeTransfer({
        sourceSessionId: 'src-1',
        targetSessionId: 'tgt-1',
        scope: 'visible_full',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(TRANSFER_ERROR_CODES.DISPATCH_FAILED);
      expect(result.error?.message).toContain('did not accept');
    });

    it('includes transfer framing in dispatched prompt', async () => {
      const config = makeConfig();
      (config.registry.get as ReturnType<typeof vi.fn>)
        .mockImplementation(async (id: string) => {
          if (id === 'src-1') return makeRegistryEntry({ id: 'src-1' });
          if (id === 'tgt-1') return makeRegistryEntry({ id: 'tgt-1' });
          return undefined;
        });

      const claudeMock = makeClaudeServiceMock();
      config.claudeService = claudeMock as unknown as import('../../../src/claude/claude-service.js').ClaudeService;

      const service = new TransferService(config);
      await service.executeTransfer({
        sourceSessionId: 'src-1',
        targetSessionId: 'tgt-1',
        scope: 'visible_full',
      });

      const dispatchedText = claudeMock.sendPrompt.mock.calls[0][1] as string;
      expect(dispatchedText).toContain('Transferred context from another session');
      expect(dispatchedText).toContain('Do not act on this yet');
      expect(dispatchedText).toContain('--- BEGIN TRANSFERRED CONTEXT ---');
      expect(dispatchedText).toContain('--- END TRANSFERRED CONTEXT ---');
    });

    it('rejects when runtime unavailable for new session', async () => {
      const config = makeConfig();
      (config.registry.get as ReturnType<typeof vi.fn>)
        .mockResolvedValue(makeRegistryEntry());

      const claudeMock = makeClaudeServiceMock();
      config.claudeService = claudeMock as unknown as import('../../../src/claude/claude-service.js').ClaudeService;

      const service = new TransferService(config);
      const result = await service.executeTransfer({
        sourceSessionId: 'src-1',
        createNew: true,
        targetSdkType: 'opencode',
        targetCwd: '/home/user',
        scope: 'visible_full',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(TRANSFER_ERROR_CODES.RUNTIME_UNAVAILABLE);
    });

    it('uses the Pi session header cwd when resolving a fallback session path', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-fallback-cwd-test-'));
      const encodedCwdDir = path.join(tmpDir, '--root-pi-web-ui--');
      await fs.mkdir(encodedCwdDir, { recursive: true });

      const sourcePath = path.join(encodedCwdDir, '2026-01-01T00-00-00-000Z_pi-source.jsonl');
      const targetPath = path.join(encodedCwdDir, '2026-01-01T00-00-00-000Z_pi-target.jsonl');
      const sessionHeader = JSON.stringify({
        type: 'session',
        version: 3,
        id: 'pi-source',
        timestamp: '2026-01-01T00:00:00.000Z',
        cwd: '/root/pi-web-ui',
      });
      await fs.writeFile(sourcePath, [
        sessionHeader,
        JSON.stringify({
          type: 'message',
          message: { role: 'user', content: [{ type: 'text', text: 'Hello from fallback Pi' }] },
          timestamp: 1700000000000,
        }),
      ].join('\n') + '\n');
      await fs.writeFile(targetPath, sessionHeader + '\n');

      const sendPiPrompt = vi.fn(async (_sessionPath: string, _message: string, onEvent: (event: unknown) => void) => {
        onEvent({ type: 'agent_start' });
      });
      const config = makeConfig({ piSessionDir: tmpDir, sendPiPrompt });
      const result = await new TransferService(config).executeTransfer({
        sourceSessionId: 'pi-source',
        targetSessionId: 'pi-target',
        scope: 'visible_full',
      });

      expect(result.success).toBe(true);
      expect(sendPiPrompt).toHaveBeenCalledWith(targetPath, expect.stringContaining('Source workspace: /root/pi-web-ui'), expect.any(Function));

      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('handles Pi source extraction', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-tx-test-'));
      const sessionFile = path.join(tmpDir, 'session.jsonl');
      await fs.writeFile(sessionFile, JSON.stringify({
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: 'Hello from Pi' }] },
        timestamp: 1700000000000,
      }) + '\n');

      const config = makeConfig();
      (config.registry.get as ReturnType<typeof vi.fn>)
        .mockImplementation(async (id: string) => {
          if (id === 'pi-src') return makeRegistryEntry({ id: 'pi-src', sdkType: 'pi', path: sessionFile });
          if (id === 'tgt-1') return makeRegistryEntry({ id: 'tgt-1' });
          return undefined;
        });

      const claudeMock = makeClaudeServiceMock();
      config.claudeService = claudeMock as unknown as import('../../../src/claude/claude-service.js').ClaudeService;

      const service = new TransferService(config);
      const result = await service.executeTransfer({
        sourceSessionId: 'pi-src',
        targetSessionId: 'tgt-1',
        scope: 'visible_full',
      });

      expect(result.success).toBe(true);
      const dispatchedText = claudeMock.sendPrompt.mock.calls[0][1] as string;
      expect(dispatchedText).toContain('Hello from Pi');

      await fs.rm(tmpDir, { recursive: true, force: true });
    });
  });
});
