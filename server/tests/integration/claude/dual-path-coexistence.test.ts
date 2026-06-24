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

  // This drives a real prompt through the real ClaudeChannelWsClient ↔
  // MockClaudeChannelServer WebSocket round-trip, exercising the channel path
  // end-to-end while the PTY/process-manager is fully mocked. The mock stands in
  // for the Claude Code plugin, so NO real `claude` process is spawned and there
  // are no PTY settle / model-switch delays — the prompt→agent_end flow is driven
  // entirely by the test. (The previous version routed through ClaudeService
  // without a `channel` profile, so createSession fell through to the direct-CLI
  // backend and spawned a real `claude -p`, which made the test slow/flaky and
  // hit the network — that is why it had been skipped.)
  it('should use channel path when channel is healthy', { timeout: 15_000 }, async () => {
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

    // The ClaudeChannelService is the unit that owns the WS round-trip. Drive it
    // directly so the test exercises the channel path itself rather than the
    // ClaudeService profile-based routing (which needs a `channel` profile).
    const channelService = (service as unknown as { channelService: {
      start: () => Promise<void>;
      stop: () => Promise<void>;
      isHealthy: () => Promise<boolean>;
      createSession: (cwd: string, model?: string) => Promise<{ sessionId: string; claudeSessionId: string }>;
      sendPrompt: (
        sessionId: string,
        prompt: string,
        onEvent: (e: NormalizedEvent) => void,
        onComplete: (error?: Error) => void,
      ) => Promise<void>;
      processManager: Record<string, (...args: unknown[]) => unknown>;
      hooksConfig: { writeHooksConfig: () => Promise<void>; removeHooksConfig: () => Promise<void> };
    } }).channelService;

    // Mock the PTY/process manager so the channel is "healthy" and runs against
    // the mock WS only — no real Claude process, no settle/switch delays.
    const pm = channelService.processManager;
    vi.spyOn(pm, 'start').mockImplementation(async () => {});
    vi.spyOn(pm, 'stop').mockImplementation(async () => {});
    vi.spyOn(pm, 'isRunning').mockReturnValue(true);
    vi.spyOn(pm, 'isBusy').mockReturnValue(false);
    vi.spyOn(pm, 'switchModel').mockReturnValue(false);
    vi.spyOn(pm, 'setThinkingLevel').mockReturnValue(false);
    vi.spyOn(pm, 'clearContext').mockImplementation(async () => {});
    vi.spyOn(pm, 'markPromptSent').mockImplementation(() => {});
    vi.spyOn(pm, 'markPromptComplete').mockImplementation(() => {});
    vi.spyOn(pm, 'healthCheck').mockResolvedValue(true);
    vi.spyOn(channelService.hooksConfig, 'writeHooksConfig').mockImplementation(async () => {});
    vi.spyOn(channelService.hooksConfig, 'removeHooksConfig').mockImplementation(async () => {});

    await channelService.start();
    // The channel must report healthy for this path to be the one in use.
    expect(await channelService.isHealthy()).toBe(true);

    const { sessionId, claudeSessionId } = await channelService.createSession(tmpDir);
    expect(sessionId).toBeDefined();
    expect(claudeSessionId).toBeDefined();

    const events: NormalizedEvent[] = [];
    const completionPromise = new Promise<void>((resolve, reject) => {
      void channelService.sendPrompt(
        sessionId,
        'Channel test',
        (event) => { events.push(event); },
        (error) => { if (error) reject(error); else resolve(); },
      );
    });

    // Wait until the prompt has actually reached the mock server (deterministic),
    // then have the mock stand in for the plugin's reply + completion.
    await vi.waitFor(() => {
      expect(mockServer.getReceivedMessages().some((m) => m.type === 'prompt')).toBe(true);
    });

    mockServer.simulateReply(claudeSessionId, 'Channel response');
    mockServer.simulateAgentEnd(claudeSessionId);

    await completionPromise;

    const types = events.map(e => e.type);
    expect(types).toContain('agent_start');
    expect(types).toContain('agent_end');

    await channelService.stop();
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
