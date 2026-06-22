import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

  function profileOf(sessionId: string): string | undefined {
    const reg = JSON.parse(readFileSync(registryPath, 'utf-8'));
    const entry = reg.entries.find((e: { id: string }) => e.id === sessionId);
    return entry?.claudeProfileId;
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
});
