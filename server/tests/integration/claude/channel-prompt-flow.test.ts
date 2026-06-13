import { EventEmitter } from 'node:events';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { ClaudeChannelService } from '../../../src/claude/claude-channel-service.js';
import type { ClaudeChannelServiceConfig } from '../../../src/claude/claude-channel-service.js';
import { ClaudeSessionStore } from '../../../src/claude/claude-session-store.js';
import { MockClaudeChannelServer } from '../../helpers/mock-claude-channel-server.js';
import type { NormalizedEvent } from '@pi-web-ui/shared';

let portCounter = 15300;

function nextPort(): { wsPort: number; hookPort: number } {
  const wsPort = portCounter++;
  const hookPort = portCounter++;
  return { wsPort, hookPort };
}

describe('Channel Prompt Flow', () => {
  let tmpDir: string;
  let sessionDir: string;
  let registryPath: string;
  let pluginDir: string;
  let mockServer: MockClaudeChannelServer;
  let service: ClaudeChannelService;
  let ports: { wsPort: number; hookPort: number };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-channel-flow-'));
    sessionDir = path.join(tmpDir, 'sessions');
    registryPath = path.join(tmpDir, 'registry.json');
    pluginDir = path.join(tmpDir, 'plugin');
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.mkdir(pluginDir, { recursive: true });

    ports = nextPort();
    mockServer = new MockClaudeChannelServer({ wsPort: ports.wsPort, hookPort: ports.hookPort });
    await mockServer.start();

    const cfg: ClaudeChannelServiceConfig = {
      claudeSessionDir: sessionDir,
      registryPath,
      pluginDir,
      wsPort: ports.wsPort,
      hookPort: ports.hookPort,
      cwd: tmpDir,
    };
    service = new ClaudeChannelService(cfg);

    const mockProcessManager = Object.assign(new EventEmitter(), {
      start: async () => {},
      stop: async () => {},
      healthCheck: async () => true,
      isRunning: () => true,
      switchModel: () => {},
      setThinkingLevel: () => {},
      markPromptSent: () => {},
      markPromptComplete: () => {},
      isBusy: () => false,
      clearContext: async () => {},
      sendInterrupt: () => {},
    });

    vi.spyOn(service as unknown as { processManager: typeof mockProcessManager }, 'processManager', 'get').mockReturnValue(mockProcessManager);

    vi.spyOn(service as unknown as { hooksConfig: { writeHooksConfig: () => Promise<void>; removeHooksConfig: () => Promise<void> } }, 'hooksConfig', 'get').mockReturnValue({
      writeHooksConfig: async () => {},
      removeHooksConfig: async () => {},
    });

    await service.start();
  });

  afterEach(async () => {
    await service.stop();
    await mockServer.stop();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should complete a full prompt→response cycle', async () => {
    const { sessionId, claudeSessionId } = await service.createSession(tmpDir);

    const events: NormalizedEvent[] = [];
    const completionPromise = new Promise<void>((resolve, reject) => {
      service.sendPrompt(
        sessionId,
        'Hello Claude',
        (event) => { events.push(event); },
        (error) => { if (error) reject(error); else resolve(); },
      );
    });

    await new Promise(r => setTimeout(r, 100));

    mockServer.simulateReply(claudeSessionId, 'Hello from Claude!');
    await new Promise(r => setTimeout(r, 50));
    mockServer.simulateAgentEnd(claudeSessionId);

    await completionPromise;

    const types = events.map(e => e.type);
    expect(types).toContain('agent_start');
    expect(types).toContain('message_start');
    expect(types).toContain('message_update');
    expect(types).toContain('message_end');
    expect(types).toContain('agent_end');

    expect(service.isRunning(sessionId)).toBe(false);
  });

  it('should persist message events to JSONL', async () => {
    const { sessionId, claudeSessionId } = await service.createSession(tmpDir);
    const store = new ClaudeSessionStore(sessionDir);

    const completionPromise = new Promise<void>((resolve, reject) => {
      service.sendPrompt(
        sessionId,
        'Test persistence',
        () => {},
        (error) => { if (error) reject(error); else resolve(); },
      );
    });

    await new Promise(r => setTimeout(r, 100));

    mockServer.simulateReply(claudeSessionId, 'Persisted response');
    await new Promise(r => setTimeout(r, 50));
    mockServer.simulateAgentEnd(claudeSessionId);

    await completionPromise;

    const history = await store.loadHistory(sessionId);

    const userEntries = history.filter(e => e.type === 'user');
    expect(userEntries.length).toBeGreaterThanOrEqual(1);
    expect(userEntries.some(e => e.content === 'Test persistence')).toBe(true);

    const assistantEntries = history.filter(e => e.type === 'assistant');
    expect(assistantEntries.length).toBeGreaterThanOrEqual(1);
    expect(assistantEntries.some(e => e.content === 'Persisted response')).toBe(true);

    const metaEntries = history.filter(e => e.type === 'meta');
    expect(metaEntries.length).toBeGreaterThanOrEqual(1);
  });

  it('should persist tool execution events to JSONL', async () => {
    const { sessionId, claudeSessionId } = await service.createSession(tmpDir);
    const store = new ClaudeSessionStore(sessionDir);

    const completionPromise = new Promise<void>((resolve, reject) => {
      service.sendPrompt(
        sessionId,
        'Use a tool',
        () => {},
        (error) => { if (error) reject(error); else resolve(); },
      );
    });

    await new Promise(r => setTimeout(r, 100));

    mockServer.simulateToolUse(claudeSessionId, 'Read', { file_path: '/tmp/test.txt' });
    await new Promise(r => setTimeout(r, 50));
    mockServer.simulateAgentEnd(claudeSessionId);

    await completionPromise;

    const history = await store.loadHistory(sessionId);

    const toolEntries = history.filter(e => e.type === 'tool');
    expect(toolEntries.length).toBeGreaterThanOrEqual(1);
    expect(toolEntries.some(e => e.toolName === 'Read')).toBe(true);

    const toolResultEntries = history.filter(e => e.type === 'tool_result');
    expect(toolResultEntries.length).toBeGreaterThanOrEqual(1);
  });

  it('should update session status throughout the flow', async () => {
    const { sessionId, claudeSessionId } = await service.createSession(tmpDir);

    let entry = await service.getSession(sessionId);
    expect(entry?.status).toBe('idle');

    const completionPromise = new Promise<void>((resolve, reject) => {
      service.sendPrompt(
        sessionId,
        'Status test',
        () => {},
        (error) => { if (error) reject(error); else resolve(); },
      );
    });

    await new Promise(r => setTimeout(r, 100));

    entry = await service.getSession(sessionId);
    expect(entry?.status).toBe('running');

    mockServer.simulateReply(claudeSessionId, 'Done');
    await new Promise(r => setTimeout(r, 50));
    mockServer.simulateAgentEnd(claudeSessionId);

    await completionPromise;

    entry = await service.getSession(sessionId);
    expect(entry?.status).toBe('idle');
  });

  it('should handle multiple prompts in sequence', async () => {
    const { sessionId, claudeSessionId } = await service.createSession(tmpDir);

    for (let i = 0; i < 3; i++) {
      const completionPromise = new Promise<void>((resolve, reject) => {
        service.sendPrompt(
          sessionId,
          `Prompt ${i}`,
          () => {},
          (error) => { if (error) reject(error); else resolve(); },
        );
      });

      await new Promise(r => setTimeout(r, 100));
      mockServer.simulateReply(claudeSessionId, `Response ${i}`);
      await new Promise(r => setTimeout(r, 50));
      mockServer.simulateAgentEnd(claudeSessionId);
      await completionPromise;
    }

    const store = new ClaudeSessionStore(sessionDir);
    const history = await store.loadHistory(sessionId);

    const userEntries = history.filter(e => e.type === 'user');
    expect(userEntries.length).toBe(3);

    const metaEntries = history.filter(e => e.type === 'meta');
    expect(metaEntries.length).toBeGreaterThanOrEqual(3);

    expect(service.isRunning(sessionId)).toBe(false);
  });
});
