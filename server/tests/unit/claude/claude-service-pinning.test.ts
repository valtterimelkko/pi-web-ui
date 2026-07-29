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

  it('enforces the direct Claude pin limit only among existing Claude sessions', async () => {
    const { service, dir } = await makeService();
    dirs.push(dir);

    const s1 = await service.createSession('/tmp/a', 'sonnet');
    const s2 = await service.createSession('/tmp/b', 'sonnet');
    const s3 = await service.createSession('/tmp/c', 'sonnet');

    expect(service.pinSession(s1.sessionId)).toBe(true);
    expect(service.pinSession(s2.sessionId)).toBe(true);
    expect(service.pinSession(s3.sessionId)).toBe(false);
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

  it('does not count Internal API claims against the Web UI pin limit', async () => {
    const { service, dir } = await makeService();
    dirs.push(dir);
    const s1 = await service.createSession('/tmp/a', 'sonnet');
    const s2 = await service.createSession('/tmp/b', 'sonnet');
    const s3 = await service.createSession('/tmp/c', 'sonnet');

    expect(service.pinSession(s1.sessionId)).toBe(true);
    expect(service.pinSession(s2.sessionId)).toBe(true);
    expect(service.pinSession(s3.sessionId, 'internal-api:lease-3')).toBe(true);
    expect(service.pinSession(s3.sessionId)).toBe(false);
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
