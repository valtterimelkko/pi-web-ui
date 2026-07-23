import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ClaudeService } from '../../../src/claude/claude-service.js';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

/**
 * Verifies the base-alias routing fix: a bare Claude alias (sonnet/opus/haiku)
 * must resolve to a *native* Claude profile, never the (GLM) default profile.
 */
describe('ClaudeService base-alias routing', () => {
  let tmpDir: string;
  let registryPath: string;
  let sessionDir: string;
  let profilesPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'claude-alias-test-'));
    registryPath = join(tmpDir, 'registry.json');
    sessionDir = join(tmpDir, 'sessions');
    profilesPath = join(tmpDir, 'profiles.json');
    writeFileSync(profilesPath, JSON.stringify({
      defaultProfileId: 'glm-sdk',
      profiles: [
        { id: 'glm-sdk', label: 'GLM SDK', backend: 'sdk-subscription', launcherType: 'native-env',
          baseUrl: 'https://api.z.ai/api/anthropic', authTokenEnv: 'NOPE', model: 'sonnet', skills: 'all' },
        { id: 'claude-sonnet-sdk', label: 'Claude Sonnet SDK', backend: 'sdk-subscription', launcherType: 'native-env',
          model: 'sonnet', skills: 'all' },
        { id: 'claude-opus-sdk', label: 'Claude Opus SDK', backend: 'sdk-subscription', launcherType: 'native-env',
          model: 'opus', skills: 'all' },
        { id: 'claude-channel', label: 'Claude Channel', backend: 'channel', launcherType: 'native-env',
          model: 'sonnet', skills: 'all' },
      ],
    }));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function svc() {
    return new ClaudeService({
      claudeSessionDir: sessionDir, registryPath, useChannel: false, useSdk: true, profilesPath,
    });
  }

  function entryOf(sessionId: string): Record<string, unknown> | undefined {
    const reg = JSON.parse(readFileSync(registryPath, 'utf-8'));
    return reg.entries.find((e: { id: string }) => e.id === sessionId);
  }

  function profileOf(sessionId: string): string | undefined {
    return entryOf(sessionId)?.claudeProfileId as string | undefined;
  }

  it('routes bare "sonnet" to the native Claude profile, not the GLM default', async () => {
    const { sessionId } = await svc().createSession(tmpDir, 'sonnet');
    expect(profileOf(sessionId)).toBe('claude-sonnet-sdk');
  });

  it('routes bare "opus" to the native Claude opus profile', async () => {
    const { sessionId } = await svc().createSession(tmpDir, 'opus');
    expect(profileOf(sessionId)).toBe('claude-opus-sdk');
  });

  it('honors an explicit GLM profileId', async () => {
    const { sessionId } = await svc().createSession(tmpDir, 'sonnet', undefined, 'glm-sdk');
    expect(profileOf(sessionId)).toBe('glm-sdk');
  });

  it('rejects an empty explicit profile id instead of treating it as no selection', async () => {
    const service = svc();
    await expect(service.createSession(tmpDir, 'sonnet', undefined, '')).rejects.toThrow(/profile|empty|invalid/i);
    expect(() => readFileSync(registryPath, 'utf-8')).toThrow();
  });

  it('fails closed when an explicit profile id is unknown instead of creating a direct fallback session', async () => {
    const service = svc();
    await expect(service.createSession(tmpDir, 'sonnet', undefined, 'missing-profile')).rejects.toThrow(/missing-profile|profile/i);
    expect(() => readFileSync(registryPath, 'utf-8')).toThrow();
  });

  it('fails closed when an explicit profile backend is unavailable instead of creating a direct fallback session', async () => {
    const service = svc();
    await expect(service.createSession(tmpDir, 'sonnet', undefined, 'claude-channel')).rejects.toThrow(/claude-channel|channel|unavailable|healthy/i);
    expect(() => readFileSync(registryPath, 'utf-8')).toThrow();
  });

  it('checks an explicit SDK backend once so health cannot race into direct fallback', async () => {
    const service = svc();
    const sdk = (service as any).sdkService;
    sdk.isHealthy = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const { sessionId } = await service.createSession(tmpDir, 'sonnet', undefined, 'claude-sonnet-sdk');
    expect(sdk.isHealthy).toHaveBeenCalledTimes(1);
    expect(entryOf(sessionId)).toMatchObject({
      model: 'sonnet',
      claudeProfileId: 'claude-sonnet-sdk',
      claudeProfileBackend: 'sdk-subscription',
      claudeProviderId: 'anthropic',
    });
  });

  it('persists the exact profile tuple for an available channel profile', async () => {
    const service = svc();
    (service as any).channelService = {
      isHealthy: vi.fn().mockResolvedValue(true),
      createSession: vi.fn().mockResolvedValue({ sessionId: 'channel-session', claudeSessionId: 'channel-native' }),
    };
    const { sessionId } = await service.createSession(tmpDir, 'sonnet', undefined, 'claude-channel');
    expect(entryOf(sessionId)).toMatchObject({
      model: 'sonnet',
      claudeProfileId: 'claude-channel',
      claudeProfileBackend: 'channel',
      claudeProviderId: 'anthropic',
    });
  });
});
