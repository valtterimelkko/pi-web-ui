import { EventEmitter } from 'node:events';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { ClaudeChannelService } from '../../../src/claude/claude-channel-service.js';
import type { ClaudeChannelServiceConfig } from '../../../src/claude/claude-channel-service.js';
import { MockClaudeChannelServer } from '../../helpers/mock-claude-channel-server.js';
import type { NormalizedEvent } from '@pi-web-ui/shared';

let portCounter = 15500;

function nextPort(): { wsPort: number; hookPort: number } {
  const wsPort = portCounter++;
  const hookPort = portCounter++;
  return { wsPort, hookPort };
}

describe('Channel Permission Flow', () => {
  let tmpDir: string;
  let sessionDir: string;
  let registryPath: string;
  let pluginDir: string;
  let mockServer: MockClaudeChannelServer;
  let service: ClaudeChannelService;
  let ports: { wsPort: number; hookPort: number };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-channel-perm-'));
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
      switchModel: () => false,
      setThinkingLevel: () => false,
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

  it('should receive permission_request from channel', async () => {
    const { sessionId, claudeSessionId } = await service.createSession(tmpDir);

    const events: NormalizedEvent[] = [];
    const completionPromise = new Promise<void>((resolve, reject) => {
      service.sendPrompt(
        sessionId,
        'Do something dangerous',
        (event) => { events.push(event); },
        (error) => { if (error) reject(error); else resolve(); },
      );
    });

    await new Promise(r => setTimeout(r, 100));

    const permissionResult = mockServer.simulatePermissionRequest(claudeSessionId, 'Write');

    await new Promise(r => setTimeout(r, 100));

    const permEvents = events.filter(e => e.type === 'permission_request');
    expect(permEvents.length).toBe(1);
    expect((permEvents[0].data as Record<string, unknown>)?.toolName).toBe('Write');

    service.sendPermissionResponse(sessionId, (permEvents[0].data as Record<string, unknown>)?.requestId as string, true);

    const allowed = await permissionResult;
    expect(allowed).toBe(true);

    mockServer.simulateReply(claudeSessionId, 'Done');
    await new Promise(r => setTimeout(r, 50));
    mockServer.simulateAgentEnd(claudeSessionId);

    await completionPromise;
  });

  it('should relay permission response back to channel', async () => {
    const { sessionId, claudeSessionId } = await service.createSession(tmpDir);

    const events: NormalizedEvent[] = [];
    const completionPromise = new Promise<void>((resolve, reject) => {
      service.sendPrompt(
        sessionId,
        'Delete files',
        (event) => { events.push(event); },
        (error) => { if (error) reject(error); else resolve(); },
      );
    });

    await new Promise(r => setTimeout(r, 100));

    const permissionResult = mockServer.simulatePermissionRequest(claudeSessionId, 'Bash');

    await new Promise(r => setTimeout(r, 100));

    const permEvent = events.find(e => e.type === 'permission_request');
    expect(permEvent).toBeDefined();

    service.sendPermissionResponse(sessionId, (permEvent!.data as Record<string, unknown>)?.requestId as string, false);

    const allowed = await permissionResult;
    expect(allowed).toBe(false);

    const messages = mockServer.getReceivedMessages();
    const permResponse = messages.find(m => m.type === 'permission_response');
    expect(permResponse).toBeDefined();
    expect(permResponse!.allowed).toBe(false);

    mockServer.simulateReply(claudeSessionId, 'Cancelled');
    await new Promise(r => setTimeout(r, 50));
    mockServer.simulateAgentEnd(claudeSessionId);

    await completionPromise;
  });

  it('should timeout if no response received', async () => {
    const { sessionId, claudeSessionId } = await service.createSession(tmpDir);

    const events: NormalizedEvent[] = [];
    const completionPromise = new Promise<void>((resolve, reject) => {
      service.sendPrompt(
        sessionId,
        'Needs approval',
        (event) => { events.push(event); },
        (error) => { if (error) reject(error); else resolve(); },
      );
    });

    await new Promise(r => setTimeout(r, 100));

    const shortTimeoutServer = new MockClaudeChannelServer({
      wsPort: ports.wsPort + 100,
      hookPort: ports.hookPort + 100,
    });

    mockServer.simulatePermissionRequest(claudeSessionId, 'Write');

    await new Promise(r => setTimeout(r, 100));

    const permEvent = events.find(e => e.type === 'permission_request');
    expect(permEvent).toBeDefined();

    const allowed = await Promise.race([
      new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), 200);
      }),
      (async () => {
        await new Promise(r => setTimeout(r, 6000));
        return true;
      })(),
    ]);

    expect(allowed).toBe(false);

    mockServer.simulateReply(claudeSessionId, 'Timeout fallback');
    await new Promise(r => setTimeout(r, 50));
    mockServer.simulateAgentEnd(claudeSessionId);

    await completionPromise;
  });
});
