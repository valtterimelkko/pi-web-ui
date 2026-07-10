import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { TransferService } from '../../src/session-transfer/transfer-service.js';
import type { TransferServiceConfig } from '../../src/session-transfer/transfer-service.js';
import type { RegistryEntry } from '../../src/session-registry.js';
import { TRANSFER_ERROR_CODES } from '../../src/session-transfer/types.js';

function makeEntry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
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

function makeClaudeService() {
  return {
    isRunning: vi.fn().mockReturnValue(false),
    isActive: vi.fn().mockReturnValue(false),
    createSession: vi.fn().mockResolvedValue({ sessionId: 'new-claude-1', claudeSessionId: 'claude-abc' }),
    sendPrompt: vi.fn((_sid, _prompt, onEvent, onComplete) => {
      onEvent({ type: 'agent_start' });
      onComplete(undefined);
    }),
    loadSessionHistory: vi.fn().mockResolvedValue([
      { type: 'user', sessionId: 'src-1', content: 'Hello Claude', timestamp: 1700000000000 },
      { type: 'assistant', sessionId: 'src-1', content: 'Hi there!', timestamp: 1700000001000 },
    ]),
  };
}

function makeOpenCodeService() {
  return {
    isRunning: vi.fn().mockReturnValue(false),
    createSession: vi.fn().mockResolvedValue({ sessionId: 'new-oc-1', opencodeSessionId: 'oc-abc' }),
    sendPrompt: vi.fn((_sid, _prompt, onEvent, onComplete) => {
      onEvent({ type: 'agent_start' });
      onComplete(undefined);
    }),
    getReplayEvents: vi.fn().mockResolvedValue([
      { type: 'message_start', message: { id: 'u1', role: 'user', content: 'Hello OC' }, timestamp: 1700000000000 },
      { type: 'message_end', message: { id: 'u1' } },
      { type: 'message_start', message: { id: 'a1', role: 'assistant' }, timestamp: 1700000001000 },
      { type: 'message_update', message: { id: 'a1' }, assistantMessageEvent: { type: 'text_delta', delta: 'Response' } },
      { type: 'message_end', message: { id: 'a1' } },
    ]),
  };
}

describe('Cross-runtime transfer integration', () => {
  let tmpDir: string;
  let registry: { get: ReturnType<typeof vi.fn>; getByPath: ReturnType<typeof vi.fn>; upsert: ReturnType<typeof vi.fn>; listAll: ReturnType<typeof vi.fn>; listBySdkType: ReturnType<typeof vi.fn>; updateStatus: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tx-integ-'));
    registry = {
      get: vi.fn().mockResolvedValue(undefined),
      getByPath: vi.fn().mockResolvedValue(undefined),
      upsert: vi.fn().mockResolvedValue(makeEntry()),
      listAll: vi.fn().mockResolvedValue([]),
      listBySdkType: vi.fn().mockResolvedValue([]),
      updateStatus: vi.fn(),
      delete: vi.fn(),
    };
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('Pi → Claude transfer works end-to-end', async () => {
    const piSessionFile = path.join(tmpDir, 'pi-session.jsonl');
    await fs.writeFile(piSessionFile, [
      JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'Pi user message' }] }, timestamp: 1700000000000 }),
      JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Pi assistant response' }] }, timestamp: 1700000001000 }),
    ].join('\n'));

    registry.get.mockImplementation(async (id: string) => {
      if (id === 'pi-src') return makeEntry({ id: 'pi-src', sdkType: 'pi', path: piSessionFile });
      if (id === 'claude-tgt') return makeEntry({ id: 'claude-tgt', sdkType: 'claude' });
      return undefined;
    });

    const claudeMock = makeClaudeService();
    const config: TransferServiceConfig = {
      registry: registry as unknown as import('../../src/session-registry.js').SessionRegistryManager,
      claudeService: claudeMock as unknown as import('../../src/claude/claude-service.js').ClaudeService,
      opencodeService: null,
    };

    const service = new TransferService(config);
    const result = await service.executeTransfer({
      sourceSessionId: 'pi-src',
      targetSessionId: 'claude-tgt',
      scope: 'visible_full',
    });

    expect(result.success).toBe(true);
    expect(result.targetSessionId).toBe('claude-tgt');
    const dispatched = claudeMock.sendPrompt.mock.calls[0][1] as string;
    expect(dispatched).toContain('Pi user message');
    expect(dispatched).toContain('Pi assistant response');
    expect(dispatched).toContain('Transferred context from another session');
  });

  it('Claude → OpenCode transfer works end-to-end', async () => {
    registry.get.mockImplementation(async (id: string) => {
      if (id === 'claude-src') return makeEntry({ id: 'claude-src', sdkType: 'claude' });
      if (id === 'oc-tgt') return makeEntry({ id: 'oc-tgt', sdkType: 'opencode' });
      return undefined;
    });

    const claudeMock = makeClaudeService();
    const ocMock = makeOpenCodeService();
    const config: TransferServiceConfig = {
      registry: registry as unknown as import('../../src/session-registry.js').SessionRegistryManager,
      claudeService: claudeMock as unknown as import('../../src/claude/claude-service.js').ClaudeService,
      opencodeService: ocMock as unknown as import('../../src/opencode/opencode-service.js').OpenCodeService,
    };

    const service = new TransferService(config);
    const result = await service.executeTransfer({
      sourceSessionId: 'claude-src',
      targetSessionId: 'oc-tgt',
      scope: 'visible_full',
    });

    expect(result.success).toBe(true);
    expect(result.targetSessionId).toBe('oc-tgt');
    expect(ocMock.sendPrompt).toHaveBeenCalledWith('oc-tgt', expect.any(String), expect.any(Function), expect.any(Function));
  });

  it('Antigravity → Pi transfer works end-to-end', async () => {
    registry.get.mockImplementation(async (id: string) => {
      if (id === 'agy-src') return makeEntry({ id: 'agy-src', sdkType: 'antigravity' });
      if (id === 'pi-tgt') return makeEntry({ id: 'pi-tgt', sdkType: 'pi', path: path.join(tmpDir, 'pi-target.jsonl') });
      return undefined;
    });

    const antigravityMock = {
      isRunning: vi.fn().mockReturnValue(false),
      getReplayEvents: vi.fn().mockResolvedValue([
        { type: 'message_start', message: { id: 'u1', role: 'user' }, timestamp: 1700000000000 },
        { type: 'message_update', message: { id: 'u1' }, assistantMessageEvent: { type: 'text_delta', delta: 'Hello from Antigravity' } },
        { type: 'message_end', message: { id: 'u1' } },
      ]),
      sendPrompt: vi.fn((_sid, _prompt, onEvent) => onEvent({ type: 'agent_start' })),
    };
    const config = {
      registry: registry as unknown as import('../../src/session-registry.js').SessionRegistryManager,
      claudeService: null,
      opencodeService: null,
      antigravityService: antigravityMock,
    } as unknown as TransferServiceConfig;

    const result = await new TransferService(config).executeTransfer({
      sourceSessionId: 'agy-src',
      targetSessionId: 'pi-tgt',
      scope: 'visible_full',
    });

    expect(result.success).toBe(true);
    expect(antigravityMock.getReplayEvents).toHaveBeenCalledWith('agy-src');
  });

  it('OpenCode → new Claude session transfer works', async () => {
    registry.get.mockImplementation(async (id: string) => {
      if (id === 'oc-src') return makeEntry({ id: 'oc-src', sdkType: 'opencode' });
      if (id === 'new-claude-1') return makeEntry({ id: 'new-claude-1', sdkType: 'claude' });
      return undefined;
    });

    const claudeMock = makeClaudeService();
    const ocMock = makeOpenCodeService();
    const config: TransferServiceConfig = {
      registry: registry as unknown as import('../../src/session-registry.js').SessionRegistryManager,
      claudeService: claudeMock as unknown as import('../../src/claude/claude-service.js').ClaudeService,
      opencodeService: ocMock as unknown as import('../../src/opencode/opencode-service.js').OpenCodeService,
    };

    const service = new TransferService(config);
    const result = await service.executeTransfer({
      sourceSessionId: 'oc-src',
      createNew: true,
      targetSdkType: 'claude',
      targetCwd: '/home/user/new-project',
      scope: 'visible_recent',
    });

    expect(result.success).toBe(true);
    expect(result.createdNewSession).toBe(true);
    expect(claudeMock.createSession).toHaveBeenCalledWith('/home/user/new-project');
  });

  it('busy target rejection works', async () => {
    registry.get.mockImplementation(async (id: string) => {
      if (id === 'src-1') return makeEntry({ id: 'src-1' });
      if (id === 'busy-tgt') return makeEntry({ id: 'busy-tgt' });
      return undefined;
    });

    const claudeMock = makeClaudeService();
    claudeMock.isRunning.mockReturnValue(true);

    const config: TransferServiceConfig = {
      registry: registry as unknown as import('../../src/session-registry.js').SessionRegistryManager,
      claudeService: claudeMock as unknown as import('../../src/claude/claude-service.js').ClaudeService,
      opencodeService: null,
    };

    const service = new TransferService(config);
    const result = await service.executeTransfer({
      sourceSessionId: 'src-1',
      targetSessionId: 'busy-tgt',
      scope: 'visible_full',
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(TRANSFER_ERROR_CODES.TARGET_BUSY);
  });

  it('CWD mismatch metadata preserved in handoff', async () => {
    registry.get.mockImplementation(async (id: string) => {
      if (id === 'src-1') return makeEntry({ id: 'src-1', cwd: '/project-A' });
      if (id === 'tgt-1') return makeEntry({ id: 'tgt-1', cwd: '/project-B' });
      return undefined;
    });

    const claudeMock = makeClaudeService();
    const config: TransferServiceConfig = {
      registry: registry as unknown as import('../../src/session-registry.js').SessionRegistryManager,
      claudeService: claudeMock as unknown as import('../../src/claude/claude-service.js').ClaudeService,
      opencodeService: null,
    };

    const service = new TransferService(config);
    const result = await service.executeTransfer({
      sourceSessionId: 'src-1',
      targetSessionId: 'tgt-1',
      scope: 'visible_full',
    });

    expect(result.success).toBe(true);
    const dispatched = claudeMock.sendPrompt.mock.calls[0][1] as string;
    expect(dispatched).toContain('/project-A');
  });

  it('long source session with tool-heavy content stays bounded', async () => {
    const entries = [];
    for (let i = 0; i < 50; i++) {
      entries.push({ type: 'user', sessionId: 'src-1', content: `Message ${i}`, timestamp: 1700000000000 + i * 1000 });
      entries.push({ type: 'tool', sessionId: 'src-1', toolName: 'Read', toolCallId: `t${i}`, toolInput: { file_path: `/file${i}.ts` }, timestamp: 1700000000000 + i * 1000 + 500 });
      entries.push({ type: 'tool_result', sessionId: 'src-1', toolCallId: `t${i}`, toolOutput: 'x'.repeat(500), timestamp: 1700000000000 + i * 1000 + 600 });
      entries.push({ type: 'assistant', sessionId: 'src-1', content: `Response ${i}`, timestamp: 1700000000000 + i * 1000 + 700 });
    }

    registry.get.mockImplementation(async (id: string) => {
      if (id === 'src-1') return makeEntry({ id: 'src-1' });
      if (id === 'tgt-1') return makeEntry({ id: 'tgt-1' });
      return undefined;
    });

    const claudeMock = makeClaudeService();
    claudeMock.loadSessionHistory.mockResolvedValue(entries);

    const config: TransferServiceConfig = {
      registry: registry as unknown as import('../../src/session-registry.js').SessionRegistryManager,
      claudeService: claudeMock as unknown as import('../../src/claude/claude-service.js').ClaudeService,
      opencodeService: null,
    };

    const service = new TransferService(config);
    const result = await service.executeTransfer({
      sourceSessionId: 'src-1',
      targetSessionId: 'tgt-1',
      scope: 'visible_full',
    });

    expect(result.success).toBe(true);
    const dispatched = claudeMock.sendPrompt.mock.calls[0][1] as string;
    expect(dispatched.length).toBeLessThan(50000);
    expect(dispatched).toContain('--- BEGIN TRANSFERRED CONTEXT ---');
  });

  it('dispatch failure returns explicit error with target session ID', async () => {
    registry.get.mockImplementation(async (id: string) => {
      if (id === 'src-1') return makeEntry({ id: 'src-1' });
      if (id === 'tgt-1') return makeEntry({ id: 'tgt-1' });
      return undefined;
    });

    const claudeMock = makeClaudeService();
    claudeMock.sendPrompt.mockImplementation((_sid, _prompt, _onEvent, onComplete) => {
      onComplete(new Error('Claude process crashed'));
    });

    const config: TransferServiceConfig = {
      registry: registry as unknown as import('../../src/session-registry.js').SessionRegistryManager,
      claudeService: claudeMock as unknown as import('../../src/claude/claude-service.js').ClaudeService,
      opencodeService: null,
    };

    const service = new TransferService(config);
    const result = await service.executeTransfer({
      sourceSessionId: 'src-1',
      targetSessionId: 'tgt-1',
      scope: 'visible_full',
    });

    expect(result.success).toBe(false);
    expect(result.targetSessionId).toBe('tgt-1');
    expect(result.error?.code).toBe(TRANSFER_ERROR_CODES.DISPATCH_FAILED);
  });
});
