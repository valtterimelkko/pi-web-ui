import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { ClaudeService } from '../../../src/claude/claude-service.js';

async function makeService(useChannel = false): Promise<{ service: ClaudeService; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-claude-service-pin-'));
  const service = new ClaudeService({
    claudeSessionDir: path.join(dir, 'claude-sessions'),
    registryPath: path.join(dir, 'session-registry.json'),
    useChannel,
    channelPluginDir: useChannel ? path.join(dir, 'fake-channel-plugin') : undefined,
  });
  return { service, dir };
}

describe('ClaudeService direct pinning', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it('can pin a newly-created direct Claude session before its first prompt', async () => {
    const { service, dir } = await makeService();
    dirs.push(dir);

    const { sessionId } = await service.createSession('/tmp/project', 'sonnet');

    expect(service.pinSession(sessionId)).toBe(true);
    expect(service.isSessionPinned(sessionId)).toBe(true);
  });

  it('enforces the Claude facade pin limit at five existing sessions', async () => {
    const { service, dir } = await makeService();
    dirs.push(dir);

    const sessions = await Promise.all(
      Array.from({ length: 6 }, (_, index) => service.createSession(`/tmp/${index + 1}`, 'sonnet')),
    );

    for (const session of sessions.slice(0, 5)) expect(service.pinSession(session.sessionId)).toBe(true);
    expect(service.pinSession(sessions[5].sessionId)).toBe(false);
  });

  it('keeps an Internal API claim when the Web UI releases its own claim', async () => {
    const { service, dir } = await makeService();
    dirs.push(dir);
    const { sessionId } = await service.createSession('/tmp/project', 'sonnet');

    expect(service.pinSession(sessionId)).toBe(true);
    expect(service.pinSession(sessionId, 'internal-api:lease-1')).toBe(true);
    expect(service.unpinSession(sessionId)).toBe(true);
    expect(service.isSessionPinned(sessionId)).toBe(true);
    expect(service.unpinSession(sessionId, 'internal-api:lease-1')).toBe(true);
    expect(service.isSessionPinned(sessionId)).toBe(false);
  });

  it('does not count Internal API claims against the five-session Web UI pin limit', async () => {
    const { service, dir } = await makeService();
    dirs.push(dir);
    const sessions = await Promise.all(
      Array.from({ length: 6 }, (_, index) => service.createSession(`/tmp/${index + 1}`, 'sonnet')),
    );

    for (const session of sessions.slice(0, 5)) expect(service.pinSession(session.sessionId)).toBe(true);
    expect(service.pinSession(sessions[5].sessionId, 'internal-api:lease-6')).toBe(true);
    expect(service.pinSession(sessions[5].sessionId)).toBe(false);
  });

  it('pins direct fallback sessions when channel mode is configured but unhealthy', async () => {
    const { service, dir } = await makeService(true);
    dirs.push(dir);

    expect(await service.getBackendMode()).toBe('direct');
    const { sessionId } = await service.createSession('/tmp/project', 'sonnet');

    expect(service.pinSession(sessionId)).toBe(true);
    expect(service.isSessionPinned(sessionId)).toBe(true);
  });
});
