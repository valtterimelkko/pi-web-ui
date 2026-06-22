import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, writeFileSync as fsWrite, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ClaudeProfileSchema,
  ClaudeProfilesFileSchema,
  ClaudeProfileManager,
  ClaudeProfileError,
  resolveProfile,
  redactSecrets,
  DEFAULT_ALLOWED_TOOLS,
  defaultProfilesPath,
  type ClaudeProfile,
} from '../../../src/claude/claude-profiles.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  const dir = join(tmpdir(), `claude-profile-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function glmNativeEnvProfile(): ClaudeProfile {
  return ClaudeProfileSchema.parse({
    id: 'glm52-claude-sdk',
    label: 'GLM 5.2 via Claude SDK',
    backend: 'sdk-subscription',
    launcherType: 'native-env',
    baseUrl: 'https://api.z.ai/api/anthropic',
    authTokenEnv: 'GLM_CODING_PLAN_TOKEN',
    authMode: 'anthropic-compatible-token',
    model: 'sonnet',
    modelMode: 'claude-alias',
    modelAliases: {
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.2[1m]',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-4.7',
    },
    permissionMode: 'dontAsk',
    skills: 'all',
  });
}

function nativeClaudeProfile(): ClaudeProfile {
  return ClaudeProfileSchema.parse({
    id: 'claude-sonnet-sdk',
    label: 'Claude Sonnet via SDK subscription',
    backend: 'sdk-subscription',
    launcherType: 'native-env',
    authMode: 'subscription',
    model: 'sonnet',
    skills: 'all',
  });
}

// ─── Schema tests ─────────────────────────────────────────────────────────────

describe('ClaudeProfileSchema', () => {
  it('parses a valid native-env GLM profile', () => {
    const profile = glmNativeEnvProfile();
    expect(profile.id).toBe('glm52-claude-sdk');
    expect(profile.backend).toBe('sdk-subscription');
    expect(profile.launcherType).toBe('native-env');
    expect(profile.modelMode).toBe('claude-alias');
    expect(profile.settingSources).toEqual(['user', 'project']);
    expect(profile.permissionMode).toBe('dontAsk');
    expect(profile.maxConcurrent).toBe(2);
    expect(profile.enabled).toBe(true);
  });

  it('parses a native Claude subscription profile with defaults', () => {
    const profile = nativeClaudeProfile();
    expect(profile.authMode).toBe('subscription');
    expect(profile.model).toBe('sonnet');
    expect(profile.modelMode).toBe('claude-alias');
    expect(profile.permissionMode).toBe('dontAsk');
  });

  it('rejects an invalid backend', () => {
    const result = ClaudeProfileSchema.safeParse({
      id: 'bad',
      label: 'Bad',
      backend: 'invalid',
      launcherType: 'native-env',
      model: 'sonnet',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid baseUrl', () => {
    const result = ClaudeProfileSchema.safeParse({
      id: 'bad',
      label: 'Bad',
      backend: 'sdk-subscription',
      launcherType: 'native-env',
      baseUrl: 'not-a-url',
      model: 'sonnet',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a profile with no model', () => {
    const result = ClaudeProfileSchema.safeParse({
      id: 'bad',
      label: 'Bad',
      backend: 'sdk-subscription',
      launcherType: 'native-env',
    });
    expect(result.success).toBe(false);
  });

  it('accepts skills as "all", array, or empty array', () => {
    for (const skills of ['all', ['pdf', 'docx'], []]) {
      const profile = ClaudeProfileSchema.parse({
        id: 'test',
        label: 'Test',
        backend: 'sdk-subscription',
        launcherType: 'native-env',
        model: 'sonnet',
        skills,
      });
      expect(profile.skills).toEqual(skills);
    }
  });
});

// ─── Profile file schema ──────────────────────────────────────────────────────

describe('ClaudeProfilesFileSchema', () => {
  it('parses a file with profiles and defaultProfileId', () => {
    const result = ClaudeProfilesFileSchema.parse({
      profiles: [glmNativeEnvProfile(), nativeClaudeProfile()],
      defaultProfileId: 'glm52-claude-sdk',
    });
    expect(result.profiles).toHaveLength(2);
    expect(result.defaultProfileId).toBe('glm52-claude-sdk');
  });
});

// ─── Profile Manager tests ────────────────────────────────────────────────────

describe('ClaudeProfileManager', () => {
  let tmpDir: string;
  let profilesPath: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    profilesPath = join(tmpDir, 'claude-profiles.json');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads profiles from a valid file', () => {
    writeFileSync(
      profilesPath,
      JSON.stringify({
        profiles: [glmNativeEnvProfile(), nativeClaudeProfile()],
        defaultProfileId: 'glm52-claude-sdk',
      }),
    );
    const mgr = new ClaudeProfileManager({ profilesPath });
    mgr.load();
    expect(mgr.hasProfiles).toBe(true);
    expect(mgr.getProfile('glm52-claude-sdk')?.label).toBe('GLM 5.2 via Claude SDK');
    expect(mgr.getDefaultProfileId()).toBe('glm52-claude-sdk');
  });

  it('returns empty when file does not exist', () => {
    const mgr = new ClaudeProfileManager({ profilesPath: join(tmpDir, 'nope.json') });
    mgr.load();
    expect(mgr.hasProfiles).toBe(false);
    expect(mgr.listEnabledProfiles()).toEqual([]);
  });

  it('throws on invalid profile file', () => {
    writeFileSync(profilesPath, JSON.stringify({ profiles: 'not-an-array' }));
    const mgr = new ClaudeProfileManager({ profilesPath });
    expect(() => mgr.load()).toThrow(ClaudeProfileError);
  });

  it('requireProfile throws on missing profile', () => {
    writeFileSync(profilesPath, JSON.stringify({ profiles: [] }));
    const mgr = new ClaudeProfileManager({ profilesPath });
    mgr.load();
    expect(() => mgr.requireProfile('nonexistent')).toThrow(ClaudeProfileError);
  });

  it('requireProfile throws on disabled profile', () => {
    const p = glmNativeEnvProfile();
    p.enabled = false;
    writeFileSync(profilesPath, JSON.stringify({ profiles: [p] }));
    const mgr = new ClaudeProfileManager({ profilesPath });
    mgr.load();
    expect(() => mgr.requireProfile(p.id)).toThrow(ClaudeProfileError);
  });

  it('listEnabledProfiles filters out disabled profiles', () => {
    const p1 = glmNativeEnvProfile();
    const p2 = nativeClaudeProfile();
    p2.enabled = false;
    writeFileSync(profilesPath, JSON.stringify({ profiles: [p1, p2] }));
    const mgr = new ClaudeProfileManager({ profilesPath });
    mgr.load();
    const enabled = mgr.listEnabledProfiles();
    expect(enabled).toHaveLength(1);
    expect(enabled[0].id).toBe('glm52-claude-sdk');
  });

  it('lazy-loads on first access', () => {
    writeFileSync(
      profilesPath,
      JSON.stringify({ profiles: [nativeClaudeProfile()] }),
    );
    const mgr = new ClaudeProfileManager({ profilesPath });
    // No explicit load() call
    expect(mgr.getProfile('claude-sonnet-sdk')).toBeDefined();
  });
});

// ─── Profile Resolver tests ───────────────────────────────────────────────────

describe('resolveProfile', () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    // Restore env
    for (const key of Object.keys(process.env)) {
      if (!(key in origEnv)) delete process.env[key];
    }
    Object.assign(process.env, origEnv);
  });

  it('sets ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN for GLM native-env profile', () => {
    process.env.GLM_CODING_PLAN_TOKEN = 'test-token-12345';
    delete process.env.ANTHROPIC_API_KEY;
    const resolved = resolveProfile(glmNativeEnvProfile());
    expect(resolved.env.ANTHROPIC_BASE_URL).toBe('https://api.z.ai/api/anthropic');
    expect(resolved.env.ANTHROPIC_AUTH_TOKEN).toBe('test-token-12345');
    expect(resolved.providerId).toBe('zai');
  });

  it('applies model aliases as env vars', () => {
    process.env.GLM_CODING_PLAN_TOKEN = 'test-token';
    delete process.env.ANTHROPIC_API_KEY;
    const resolved = resolveProfile(glmNativeEnvProfile());
    expect(resolved.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('glm-5.2[1m]');
    expect(resolved.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('glm-4.7');
  });

  it('ALWAYS strips ANTHROPIC_API_KEY even if set in process.env', () => {
    process.env.GLM_CODING_PLAN_TOKEN = 'test-token';
    process.env.ANTHROPIC_API_KEY = 'should-be-stripped';
    const resolved = resolveProfile(glmNativeEnvProfile());
    expect(resolved.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('does NOT set ANTHROPIC_AUTH_TOKEN for native subscription profiles', () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    const resolved = resolveProfile(nativeClaudeProfile());
    expect(resolved.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(resolved.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(resolved.providerId).toBe('anthropic');
  });

  it('strips ANTHROPIC_AUTH_TOKEN for native subscription profiles', () => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'stale-token';
    process.env.ANTHROPIC_API_KEY = 'stale-key';
    const resolved = resolveProfile(nativeClaudeProfile());
    expect(resolved.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(resolved.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('throws when authTokenEnv is not set', () => {
    delete process.env.GLM_CODING_PLAN_TOKEN;
    expect(() => resolveProfile(glmNativeEnvProfile())).toThrow(ClaudeProfileError);
    expect(() => resolveProfile(glmNativeEnvProfile())).toThrow(/GLM_CODING_PLAN_TOKEN/);
  });

  it('reads token from authTokenPath file', () => {
    const tmpDir = makeTmpDir();
    const secretFile = join(tmpDir, 'glm-token');
    fsWrite(secretFile, 'file-token-67890\n', { mode: 0o600 });
    const profile = ClaudeProfileSchema.parse({
      id: 'glm-file',
      label: 'GLM file token',
      backend: 'sdk-subscription',
      launcherType: 'native-env',
      baseUrl: 'https://api.z.ai/api/anthropic',
      authTokenPath: secretFile,
      model: 'sonnet',
    });
    const resolved = resolveProfile(profile);
    expect(resolved.env.ANTHROPIC_AUTH_TOKEN).toBe('file-token-67890');
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('throws when authTokenPath file does not exist', () => {
    const profile = ClaudeProfileSchema.parse({
      id: 'glm-missing',
      label: 'GLM missing file',
      backend: 'sdk-subscription',
      launcherType: 'native-env',
      baseUrl: 'https://api.z.ai/api/anthropic',
      authTokenPath: '/nonexistent/path/token',
      model: 'sonnet',
    });
    expect(() => resolveProfile(profile)).toThrow(ClaudeProfileError);
  });

  it('throws when authTokenPath is relative', () => {
    const profile = ClaudeProfileSchema.parse({
      id: 'glm-rel',
      label: 'GLM relative path',
      backend: 'sdk-subscription',
      launcherType: 'native-env',
      baseUrl: 'https://api.z.ai/api/anthropic',
      authTokenPath: 'relative/token',
      model: 'sonnet',
    });
    expect(() => resolveProfile(profile)).toThrow(/absolute/);
  });

  it('throws when command profile has no command', () => {
    const profile = ClaudeProfileSchema.parse({
      id: 'cmd-no-command',
      label: 'Missing command',
      backend: 'cli-direct',
      launcherType: 'command',
      model: 'sonnet',
    });
    expect(() => resolveProfile(profile)).toThrow(ClaudeProfileError);
  });

  it('uses command executable for command launcher type', () => {
    const profile = ClaudeProfileSchema.parse({
      id: 'cmd-wrapper',
      label: 'Wrapper',
      backend: 'cli-direct',
      launcherType: 'command',
      command: 'clother-zai',
      model: 'sonnet',
    });
    const resolved = resolveProfile(profile);
    expect(resolved.executable).toBe('clother-zai');
    expect(resolved.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('passes through sdkOptions correctly', () => {
    process.env.GLM_CODING_PLAN_TOKEN = 'token';
    delete process.env.ANTHROPIC_API_KEY;
    const resolved = resolveProfile(glmNativeEnvProfile());
    expect(resolved.sdkOptions.settingSources).toEqual(['user', 'project']);
    expect(resolved.sdkOptions.skills).toBe('all');
    expect(resolved.sdkOptions.permissionMode).toBe('dontAsk');
    expect(resolved.sdkOptions.allowedTools).toEqual(DEFAULT_ALLOWED_TOOLS);
  });

  it('builds cliArgsBase with --model', () => {
    const resolved = resolveProfile(nativeClaudeProfile());
    expect(resolved.cliArgsBase).toEqual(['--model', 'sonnet']);
  });

  it('preserves PATH and HOME from process.env', () => {
    process.env.GLM_CODING_PLAN_TOKEN = 'token';
    delete process.env.ANTHROPIC_API_KEY;
    const resolved = resolveProfile(glmNativeEnvProfile());
    expect(resolved.env.PATH).toBe(process.env.PATH);
    expect(resolved.env.HOME).toBe(process.env.HOME);
  });
});

// ─── Secret redaction tests ───────────────────────────────────────────────────

describe('redactSecrets', () => {
  it('redacts ANTHROPIC_AUTH_TOKEN and ANTHROPIC_API_KEY', () => {
    const redacted = redactSecrets({
      ANTHROPIC_AUTH_TOKEN: 'secret-token',
      ANTHROPIC_API_KEY: 'secret-key',
      PATH: '/usr/bin',
      HOME: '/root',
    });
    expect(redacted.ANTHROPIC_AUTH_TOKEN).toBe('<redacted>');
    expect(redacted.ANTHROPIC_API_KEY).toBe('<redacted>');
    expect(redacted.PATH).toBe('/usr/bin');
    expect(redacted.HOME).toBe('/root');
  });

  it('handles undefined values', () => {
    const redacted = redactSecrets({
      ANTHROPIC_API_KEY: undefined,
      PATH: '/usr/bin',
    });
    expect(redacted.ANTHROPIC_API_KEY).toBeUndefined();
    expect(redacted.PATH).toBe('/usr/bin');
  });
});

// ─── defaultProfilesPath ──────────────────────────────────────────────────────

describe('defaultProfilesPath', () => {
  it('returns ~/.pi-web-ui/claude-profiles.json', () => {
    const p = defaultProfilesPath();
    expect(p).toContain('.pi-web-ui');
    expect(p).toContain('claude-profiles.json');
  });
});
