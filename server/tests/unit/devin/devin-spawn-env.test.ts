import { describe, it, expect } from 'vitest';
import { devinSpawnEnv, DEVIN_ENV_ALLOWLIST } from '../../../src/devin/devin-spawn-env.js';

/**
 * Plan D2 (frozen): every `devin acp` spawn gets an explicit allow-listed
 * environment — HOME, PATH, LANG, TERM, plus optional DEVIN_* the server
 * sets. The server's own environment is NEVER forwarded: a Claude session's
 * tokens leaked into trial hook logs once hooks inherit the parent env.
 */
const SECRET = 'ANTHROPIC_API_KEY';

describe('devin spawn env allow-list (plan D2)', () => {
  it('passes only the allow-listed variables plus DEVIN_*', () => {
    const parent = {
      HOME: '/home/owner',
      PATH: '/usr/bin:/bin',
      LANG: 'en_GB.UTF-8',
      TERM: 'xterm-256color',
      [SECRET]: 'sk-leak-me-not',
      CLAUDE_CODE_SESSION_ID: 'abc',
      ANTHROPIC_AUTH_TOKEN: 'leak',
      PI_TOOLS_PLACEMENT: 'on',
      DEVIN_PROJECT_DIR: '/project',
    };
    const env = devinSpawnEnv('/home/throwaway', parent);
    expect(env.HOME).toBe('/home/throwaway');
    expect(env.PATH).toBe('/usr/bin:/bin');
    expect(env.LANG).toBe('en_GB.UTF-8');
    expect(env.TERM).toBe('xterm-256color');
    expect(env.DEVIN_PROJECT_DIR).toBe('/project');
  });

  it('never forwards parent-harness variables even without a HOME override', () => {
    const parent = {
      HOME: '/root',
      PATH: '/bin',
      [SECRET]: 'sk-secret',
      CLAUDECODE: '1',
      DEVIN_TRACE: 'x',
    };
    const env = devinSpawnEnv(undefined, parent);
    expect(env[SECRET]).toBeUndefined();
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.DEVIN_TRACE).toBe('x');
    expect(env.HOME).toBe('/root');
  });

  it('HOME defaults to os.homedir() when no override is given (plan D1 real-HOME production)', () => {
    const env = devinSpawnEnv(undefined, { HOME: '/irrelevant', PATH: '/bin' });
    expect(env.HOME).not.toBe('/irrelevant');
    expect(env.HOME.length).toBeGreaterThan(0);
  });

  it('keeps PATH with the CLI dir when the parent has none (spawning still works)', () => {
    const env = devinSpawnEnv(undefined, {});
    expect(typeof env.PATH).toBe('string');
    expect(env.PATH.length).toBeGreaterThan(0);
  });

  it('documents the allow-list keys for audit', () => {
    expect([...DEVIN_ENV_ALLOWLIST].sort()).toEqual(['HOME', 'LANG', 'PATH', 'TERM']);
  });
});
