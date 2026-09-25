import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ClaudeService } from '../../../src/claude/claude-service.js';
import { ClaudeSdkService } from '../../../src/claude/claude-sdk-service.js';
import { ClaudeBackendNotAllowedError } from '../../../src/claude/claude-backend-policy.js';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

/**
 * Internal API Claude backend policy: only the Agent SDK backend may execute.
 * `requireBackend: 'sdk-subscription'` must fail closed — never create a
 * cli-direct, channel or legacy direct (`claude -p`) session, including via the
 * implicit bare-alias / default-profile / SDK-unhealthy fallthrough paths.
 */
describe('ClaudeService create with requireBackend=sdk-subscription', () => {
  let tmpDir: string;
  let registryPath: string;
  let sessionDir: string;
  let profilesPath: string;
  let sdkHealthy: ReturnType<typeof vi.spyOn>;

  function writeProfiles(defaultProfileId: string | undefined, profiles: Array<Record<string, unknown>>) {
    writeFileSync(profilesPath, JSON.stringify({ ...(defaultProfileId ? { defaultProfileId } : {}), profiles }));
  }

  const sdkSonnet = { id: 'claude-sonnet-sdk', label: 'Sonnet SDK', backend: 'sdk-subscription', launcherType: 'native-env', model: 'sonnet', skills: 'all' };
  const directSonnet = { id: 'claude-sonnet-direct', label: 'Sonnet direct', backend: 'cli-direct', launcherType: 'native-env', model: 'sonnet', skills: 'all' };
  const channelSonnet = { id: 'claude-sonnet-channel', label: 'Sonnet channel', backend: 'channel', launcherType: 'native-env', model: 'sonnet', skills: 'all' };
  const directOpus = { id: 'claude-opus-direct', label: 'Opus direct', backend: 'cli-direct', launcherType: 'native-env', model: 'opus', skills: 'all' };

  beforeEach(() => {
    sdkHealthy = vi.spyOn(ClaudeSdkService.prototype, 'isHealthy').mockResolvedValue(true);
    tmpDir = mkdtempSync(join(tmpdir(), 'claude-sdk-only-test-'));
    registryPath = join(tmpDir, 'registry.json');
    sessionDir = join(tmpDir, 'sessions');
    profilesPath = join(tmpDir, 'profiles.json');
    writeProfiles('claude-sonnet-direct', [sdkSonnet, directSonnet, channelSonnet, directOpus]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function svc(opts: { useSdk?: boolean; profiles?: boolean } = {}) {
    return new ClaudeService({
      claudeSessionDir: sessionDir,
      registryPath,
      useChannel: false,
      useSdk: opts.useSdk ?? true,
      ...(opts.profiles === false ? {} : { profilesPath }),
    });
  }

  function registryEntries(): Array<Record<string, unknown>> {
    try {
      return JSON.parse(readFileSync(registryPath, 'utf-8')).entries;
    } catch {
      return [];
    }
  }

  const REQUIRE_SDK = { requireBackend: 'sdk-subscription' } as const;

  it('creates an SDK session for a bare alias that resolves to a native SDK profile', async () => {
    const { sessionId } = await svc().createSession(tmpDir, 'sonnet', undefined, undefined, REQUIRE_SDK);
    expect(registryEntries().find((e) => e.id === sessionId)).toMatchObject({
      claudeProfileId: 'claude-sonnet-sdk',
      claudeProfileBackend: 'sdk-subscription',
    });
  });

  it('creates an SDK session for an explicit SDK profile', async () => {
    const { sessionId } = await svc().createSession(tmpDir, 'sonnet', undefined, 'claude-sonnet-sdk', REQUIRE_SDK);
    expect(registryEntries().find((e) => e.id === sessionId)).toMatchObject({ claudeProfileBackend: 'sdk-subscription' });
  });

  it.each([
    ['cli-direct', 'claude-sonnet-direct'],
    ['channel', 'claude-sonnet-channel'],
  ])('rejects an explicit %s profile without creating anything', async (backend, profileId) => {
    const error = await svc().createSession(tmpDir, 'sonnet', undefined, profileId, REQUIRE_SDK).catch((e) => e);
    expect(error).toBeInstanceOf(ClaudeBackendNotAllowedError);
    expect(error).toMatchObject({ code: 'CLAUDE_BACKEND_NOT_ALLOWED', backend });
    expect(registryEntries()).toEqual([]);
  });

  it('rejects a bare alias with no native SDK profile instead of falling through to direct claude -p', async () => {
    const error = await svc().createSession(tmpDir, 'opus', undefined, undefined, REQUIRE_SDK).catch((e) => e);
    expect(error).toBeInstanceOf(ClaudeBackendNotAllowedError);
    expect(error).toMatchObject({ backend: 'direct' });
    expect(registryEntries()).toEqual([]);
  });

  it('rejects a non-alias model whose default profile is not SDK-backed', async () => {
    const error = await svc().createSession(tmpDir, 'claude-sonnet-4-6', undefined, undefined, REQUIRE_SDK).catch((e) => e);
    expect(error).toMatchObject({ code: 'CLAUDE_BACKEND_NOT_ALLOWED', backend: 'cli-direct' });
    expect(registryEntries()).toEqual([]);
  });

  it('rejects when profiles are disabled (legacy direct CLI only)', async () => {
    const error = await svc({ profiles: false }).createSession(tmpDir, 'sonnet', undefined, undefined, REQUIRE_SDK).catch((e) => e);
    expect(error).toMatchObject({ code: 'CLAUDE_BACKEND_NOT_ALLOWED', backend: 'direct' });
    expect(registryEntries()).toEqual([]);
  });

  it('never degrades a bare alias to direct CLI when the SDK backend is unhealthy', async () => {
    sdkHealthy.mockResolvedValue(false);
    await expect(svc().createSession(tmpDir, 'sonnet', undefined, undefined, REQUIRE_SDK)).rejects.toThrow(/SDK/);
    expect(registryEntries()).toEqual([]);
  });

  it('keeps the unrestricted (browser) behaviour when no backend is required', async () => {
    const { sessionId } = await svc().createSession(tmpDir, 'sonnet', undefined, 'claude-sonnet-direct');
    expect(registryEntries().find((e) => e.id === sessionId)).toMatchObject({ claudeProfileBackend: 'cli-direct' });
  });

  describe('executionBackend', () => {
    it('reports the backend a prompt would actually route to', () => {
      const service = svc();
      expect(service.executionBackend({ id: 'a', claudeProfileBackend: 'sdk-subscription' })).toBe('sdk-subscription');
      expect(service.executionBackend({ id: 'b', claudeProfileBackend: 'cli-direct' })).toBe('cli-direct');
      expect(service.executionBackend({ id: 'c', claudeProfileBackend: 'channel' })).toBe('channel');
      expect(service.executionBackend({ id: 'd' })).toBe('direct');
    });

    it('does not report sdk-subscription when the SDK service is absent (prompt would run direct CLI)', () => {
      const service = svc({ useSdk: false });
      expect(service.executionBackend({ id: 'a', claudeProfileBackend: 'sdk-subscription' })).toBe('direct');
    });

    it('reports channel for a live channel session regardless of the registry field', () => {
      const service = svc();
      (service as any).channelService = { hasSession: (id: string) => id === 'live-channel' };
      expect(service.executionBackend({ id: 'live-channel', claudeProfileBackend: 'sdk-subscription' })).toBe('channel');
    });
  });
});
