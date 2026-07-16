import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildValidationIsolationEnv,
  loadValidationEnvFile,
  resolveValidationEnvFile,
  resolveValidationEnvKeys,
} from '../../../src/live-validation/validation-server-env.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pi-validation-env-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('validation server env-file loading', () => {
  it('forces runtime state and working directories under the disposable directory', () => {
    const isolation = buildValidationIsolationEnv({
      validationDir: '/tmp/pi-validation',
      port: '3091',
      claudeWsPort: '43110',
      claudeHookPort: '43111',
      opencodePort: '44097',
    });

    expect(isolation.INTERNAL_API_KEY).toBe('');
    expect(isolation.PI_WEB_UI_VALIDATION_DEFAULT_CWD).toBe('/tmp/pi-validation/workspace');
    expect(isolation.SESSION_DIR).toBe('/tmp/pi-validation/pi-sessions');
    expect(isolation.PI_SESSIONS_DIR).toBe('/tmp/pi-validation/pi-sessions');
    expect(isolation.OPENCODE_WORKING_DIR).toBe('/tmp/pi-validation/opencode-workspace');
    expect(isolation.PI_WEB_UI_VALIDATION_DEFAULT_CWD).toBe('/tmp/pi-validation/workspace');
    expect(isolation.CLAUDE_SESSION_DIR).toBe('/tmp/pi-validation/claude-sessions');
    expect(isolation.CLAUDE_CONFIG_DIR).toBe('/tmp/pi-validation/claude-config');
    expect(isolation.CLAUDE_CHANNEL_ENABLED).toBe('false');
    expect(isolation.CLAUDE_CHANNEL_PLUGIN_DIR).toBe('/tmp/pi-validation/claude-channel-plugin');
    expect(isolation.CLAUDE_PROFILES_PATH).toBe('/tmp/pi-validation/claude-profiles.json');
    expect(isolation.ANTIGRAVITY_SESSION_DIR).toBe('/tmp/pi-validation/antigravity-sessions');
    expect(isolation.ANTIGRAVITY_ENABLED).toBe('false');
    expect(isolation.SESSION_REGISTRY_PATH).toBe('/tmp/pi-validation/session-registry.json');
  });

  it('resolves --env-file before the environment fallback', () => {
    expect(resolveValidationEnvFile(
      ['--env-file', '/tmp/explicit.env'],
      { PI_WEB_UI_VALIDATION_ENV_FILE: '/tmp/fallback.env' },
    )).toBe('/tmp/explicit.env');

    expect(resolveValidationEnvFile(
      [],
      { PI_WEB_UI_VALIDATION_ENV_FILE: '/tmp/fallback.env' },
    )).toBe('/tmp/fallback.env');
  });

  it('resolves repeatable --env-key flags before the comma-separated environment fallback', () => {
    expect(resolveValidationEnvKeys(
      ['--env-key', 'FIRST_TOKEN', '--env-key', 'SECOND_TOKEN'],
      { PI_WEB_UI_VALIDATION_ENV_KEYS: 'FALLBACK_TOKEN' },
    )).toEqual(['FIRST_TOKEN', 'SECOND_TOKEN']);

    expect(resolveValidationEnvKeys(
      [],
      { PI_WEB_UI_VALIDATION_ENV_KEYS: 'FIRST_TOKEN, SECOND_TOKEN' },
    )).toEqual(['FIRST_TOKEN', 'SECOND_TOKEN']);
  });

  it('loads only explicitly requested values without overriding the launching shell environment', () => {
    const dir = makeTempDir();
    const envFile = join(dir, '.env.production');
    writeFileSync(envFile, [
      'GLM_CODING_PLAN_TOKEN=from-file',
      'CLAUDE_PROFILES_PATH=/from/file/profiles.json',
      'TELEGRAM_BOT_TOKEN=must-not-be-imported',
      '',
    ].join('\n'));

    const env: NodeJS.ProcessEnv = {
      CLAUDE_PROFILES_PATH: '/explicit/validation/profiles.json',
    };

    loadValidationEnvFile(
      envFile,
      ['GLM_CODING_PLAN_TOKEN', 'CLAUDE_PROFILES_PATH'],
      env,
    );

    expect(env.GLM_CODING_PLAN_TOKEN).toBe('from-file');
    expect(env.CLAUDE_PROFILES_PATH).toBe('/explicit/validation/profiles.json');
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
  });

  it('requires an explicit allowlist before reading an env file', () => {
    expect(() => loadValidationEnvFile('/unused/validation.env', [], {})).toThrow(
      /at least one --env-key/,
    );
  });

  it('fails clearly when an explicitly requested key is absent', () => {
    const dir = makeTempDir();
    const envFile = join(dir, '.env.production');
    writeFileSync(envFile, 'SOME_OTHER_TOKEN=value\n');

    expect(() => loadValidationEnvFile(
      envFile,
      ['GLM_CODING_PLAN_TOKEN'],
      {},
    )).toThrow(/does not define requested key 'GLM_CODING_PLAN_TOKEN'/);
  });

  it('fails clearly when an explicitly requested env file cannot be loaded', () => {
    expect(() => loadValidationEnvFile(
      '/missing/validation.env',
      ['GLM_CODING_PLAN_TOKEN'],
      {},
    )).toThrow(/Unable to load validation env file.*\/missing\/validation\.env/);
  });
});
