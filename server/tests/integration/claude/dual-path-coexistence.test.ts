import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { ClaudeService } from '../../../src/claude/claude-service.js';
import { MockClaudeChannelServer } from '../../helpers/mock-claude-channel-server.js';
import type { NormalizedEvent } from '@pi-web-ui/shared';

let portCounter = 15700;

function nextPort(): { wsPort: number; hookPort: number } {
  const wsPort = portCounter++;
  const hookPort = portCounter++;
  return { wsPort, hookPort };
}

describe('Dual Path Coexistence', () => {
  let tmpDir: string;
  let sessionDir: string;
  let registryPath: string;
  let pluginDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-dual-'));
    sessionDir = path.join(tmpDir, 'sessions');
    registryPath = path.join(tmpDir, 'registry.json');
    pluginDir = path.join(tmpDir, 'plugin');
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.mkdir(pluginDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should use channel path when channel is healthy', async () => {
    const ports = nextPort();
    const mockServer = new MockClaudeChannelServer({ wsPort: ports.wsPort, hookPort: ports.hookPort });
    await mockServer.start();

    const service = new ClaudeService({
      claudeSessionDir: sessionDir,
      registryPath,
      useChannel: true,
      channelPluginDir: pluginDir,
      channelWsPort: ports.wsPort,
      channelHookPort: ports.hookPort,
    });

    const channelService = (service as unknown as { channelService: { start: () => Promise<void>; isHealthy: () => Promise<boolean>; processManager: { start: () => Promise<void>; stop: () => Promise<void>; healthCheck: () => Promise<boolean>; isRunning: () => boolean }; hooksConfig: { writeHooksConfig: () => Promise<void>; removeHooksConfig: () => Promise<void> }; wsClient: { connect: () => Promise<void>; disconnect: () => void; isConnected: () => boolean; send: (m: unknown) => void } } }).channelService;

    vi.spyOn(channelService.processManager, 'start').mockImplementation(async () => {});
    vi.spyOn(channelService.processManager, 'stop').mockImplementation(async () => {});
    vi.spyOn(channelService.hooksConfig, 'writeHooksConfig').mockImplementation(async () => {});
    vi.spyOn(channelService.hooksConfig, 'removeHooksConfig').mockImplementation(async () => {});

    await service.startChannel();

    const { sessionId, claudeSessionId } = await service.createSession(tmpDir);
    expect(sessionId).toBeDefined();
    expect(claudeSessionId).toBeDefined();

    const events: NormalizedEvent[] = [];
    const completionPromise = new Promise<void>((resolve, reject) => {
      service.sendPrompt(
        sessionId,
        'Channel test',
        (event) => { events.push(event); },
        (error) => { if (error) reject(error); else resolve(); },
      );
    });

    await new Promise(r => setTimeout(r, 200));

    mockServer.simulateReply(claudeSessionId, 'Channel response');
    await new Promise(r => setTimeout(r, 50));
    mockServer.simulateAgentEnd(claudeSessionId);

    await completionPromise;

    const types = events.map(e => e.type);
    expect(types).toContain('agent_start');
    expect(types).toContain('agent_end');

    await mockServer.stop();
  });

  it('should fall back to process pool when channel is not healthy', async () => {
    const service = new ClaudeService({
      claudeSessionDir: sessionDir,
      registryPath,
      useChannel: false,
    });

    const { sessionId, claudeSessionId } = await service.createSession(tmpDir);
    expect(sessionId).toBeDefined();
    expect(claudeSessionId).toBeDefined();

    const entry = await service.getSession(sessionId);
    expect(entry).toBeDefined();
    expect(entry?.sdkType).toBe('claude');
    expect(entry?.status).toBe('idle');
  });

  it('should create sessions that work with both paths', async () => {
    const ports = nextPort();
    const mockServer = new MockClaudeChannelServer({ wsPort: ports.wsPort, hookPort: ports.hookPort });
    await mockServer.start();

    const channelService = new ClaudeService({
      claudeSessionDir: sessionDir,
      registryPath,
      useChannel: true,
      channelPluginDir: pluginDir,
      channelWsPort: ports.wsPort,
      channelHookPort: ports.hookPort,
    });

    const processService = new ClaudeService({
      claudeSessionDir: sessionDir,
      registryPath,
      useChannel: false,
    });

    const ch = (channelService as unknown as { channelService: { start: () => Promise<void>; processManager: { start: () => Promise<void>; stop: () => Promise<void>; healthCheck: () => Promise<boolean>; isRunning: () => boolean }; hooksConfig: { writeHooksConfig: () => Promise<void>; removeHooksConfig: () => Promise<void> } } }).channelService;

    vi.spyOn(ch.processManager, 'start').mockImplementation(async () => {});
    vi.spyOn(ch.processManager, 'stop').mockImplementation(async () => {});
    vi.spyOn(ch.hooksConfig, 'writeHooksConfig').mockImplementation(async () => {});
    vi.spyOn(ch.hooksConfig, 'removeHooksConfig').mockImplementation(async () => {});

    await channelService.startChannel();

    const { sessionId: channelSessionId } = await channelService.createSession(tmpDir, 'sonnet');
    const { sessionId: processSessionId } = await processService.createSession(tmpDir, 'sonnet');

    expect(channelSessionId).toBeDefined();
    expect(processSessionId).toBeDefined();
    expect(channelSessionId).not.toBe(processSessionId);

    const channelEntry = await channelService.getSession(channelSessionId);
    const processEntry = await processService.getSession(processSessionId);

    expect(channelEntry?.sdkType).toBe('claude');
    expect(processEntry?.sdkType).toBe('claude');

    const allChannelSessions = await channelService.listSessions();
    const allProcessSessions = await processService.listSessions();

    const channelIds = allChannelSessions.map(s => s.id);
    const processIds = allProcessSessions.map(s => s.id);

    expect(channelIds).toContain(channelSessionId);
    expect(processIds).toContain(processSessionId);

    await mockServer.stop();
  });
});
