import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClaudeService } from '../../../src/claude/claude-service.js';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'claude-service-flag-test-'));
}

describe('ClaudeService feature flags', () => {
  let tmpDir: string;
  let registryPath: string;
  let sessionDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    registryPath = join(tmpDir, 'registry.json');
    sessionDir = join(tmpDir, 'sessions');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does not create SDK service when useSdk=false', () => {
    const svc = new ClaudeService({
      claudeSessionDir: sessionDir,
      registryPath,
      useChannel: false,
      useSdk: false,
    });
    expect(svc.getProfiles()).toEqual([]);
    expect(svc.getProfileManager()).toBeNull();
  });

  it('creates SDK service when useSdk=true with profilesPath', () => {
    const profilesPath = join(tmpDir, 'profiles.json');
    writeFileSync(profilesPath, JSON.stringify({
      profiles: [{
        id: 'test-profile',
        label: 'Test',
        backend: 'sdk-subscription',
        launcherType: 'native-env',
        model: 'sonnet',
        skills: 'all',
      }],
      defaultProfileId: 'test-profile',
    }));

    const svc = new ClaudeService({
      claudeSessionDir: sessionDir,
      registryPath,
      useChannel: false,
      useSdk: true,
      profilesPath,
    });
    expect(svc.getProfileManager()).not.toBeNull();
    expect(svc.getProfiles()).toHaveLength(1);
    expect(svc.getProfiles()[0].id).toBe('test-profile');
  });

  it('returns empty profiles when profiles file is missing', () => {
    const svc = new ClaudeService({
      claudeSessionDir: sessionDir,
      registryPath,
      useChannel: false,
      useSdk: true,
      profilesPath: join(tmpDir, 'nonexistent.json'),
    });
    expect(svc.getProfiles()).toEqual([]);
  });

  it('getBackendMode returns direct when no SDK and no channel', async () => {
    const svc = new ClaudeService({
      claudeSessionDir: sessionDir,
      registryPath,
      useChannel: false,
      useSdk: false,
    });
    const mode = await svc.getBackendMode();
    expect(mode).toBe('direct');
  });

  it('preserves channel service when useChannel=true', () => {
    // Channel requires a plugin dir; we pass a dummy path
    const svc = new ClaudeService({
      claudeSessionDir: sessionDir,
      registryPath,
      useChannel: true,
      channelPluginDir: '/tmp/nonexistent-channel-plugin',
      channelWsPort: 13999,
      channelHookPort: 13998,
      useSdk: false,
    });
    // The channel service is created even if the plugin isn't running
    // (it will just report unhealthy)
    expect(svc.getProfiles()).toEqual([]);
  });

  it('both SDK and channel can coexist', () => {
    const profilesPath = join(tmpDir, 'profiles.json');
    writeFileSync(profilesPath, JSON.stringify({
      profiles: [{
        id: 'test',
        label: 'Test',
        backend: 'sdk-subscription',
        launcherType: 'native-env',
        model: 'sonnet',
      }],
    }));

    const svc = new ClaudeService({
      claudeSessionDir: sessionDir,
      registryPath,
      useChannel: true,
      channelPluginDir: '/tmp/nonexistent-channel-plugin',
      channelWsPort: 13999,
      channelHookPort: 13998,
      useSdk: true,
      profilesPath,
    });
    expect(svc.getProfiles()).toHaveLength(1);
  });
});
