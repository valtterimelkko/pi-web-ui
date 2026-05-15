import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ClaudeChannelHooksConfig } from '../../../src/claude/claude-channel-hooks-config.js';

describe('ClaudeChannelHooksConfig', () => {
  let tmpDir: string;
  let settingsPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-hooks-test-'));
    settingsPath = path.join(tmpDir, '.claude', 'settings.json');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const makeConfig = (port = 3101) =>
    new ClaudeChannelHooksConfig({ hookPort: port, claudeSettingsPath: settingsPath });

  const readSettings = async () => {
    const raw = await fs.readFile(settingsPath, 'utf-8');
    return JSON.parse(raw);
  };

  it('should generate correct hooks JSON', () => {
    const config = makeConfig(3101);
    const hooks = config.buildHooksConfig();

    expect(hooks.hooks).toHaveProperty('PostToolUse');
    expect(hooks.hooks).toHaveProperty('Stop');
    expect(hooks.hooks).toHaveProperty('SessionStart');
    expect(hooks.hooks).toHaveProperty('UserPromptSubmit');

    expect(hooks.hooks.PostToolUse[0].matcher).toBe('*');
    expect(hooks.hooks.PostToolUse[0].hooks[0]).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:3101/hook/post-tool-use',
    });
    expect(hooks.hooks.Stop[0].hooks[0]).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:3101/hook/stop',
    });
    expect(hooks.hooks.SessionStart[0].hooks[0]).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:3101/hook/session-start',
    });
    expect(hooks.hooks.UserPromptSubmit[0].hooks[0]).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:3101/hook/user-prompt',
    });
  });

  it('should merge with existing settings.json', async () => {
    const claudeDir = path.join(tmpDir, '.claude');
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ permissions: { allow: ['npm'] } }, null, 2),
      'utf-8'
    );

    const config = makeConfig(3101);
    await config.writeHooksConfig();

    const settings = await readSettings();
    expect(settings.permissions).toEqual({ allow: ['npm'] });
    expect(settings.hooks.PostToolUse[0].hooks[0].url).toBe(
      'http://127.0.0.1:3101/hook/post-tool-use'
    );
  });

  it('should preserve non-hook settings', async () => {
    const claudeDir = path.join(tmpDir, '.claude');
    await fs.mkdir(claudeDir, { recursive: true });
    const original = {
      env: { FOO: 'bar' },
      permissions: { deny: ['rm'] },
      someOtherKey: 'value',
    };
    await fs.writeFile(settingsPath, JSON.stringify(original, null, 2), 'utf-8');

    const config = makeConfig(3101);
    await config.writeHooksConfig();

    const settings = await readSettings();
    expect(settings.env).toEqual({ FOO: 'bar' });
    expect(settings.permissions).toEqual({ deny: ['rm'] });
    expect(settings.someOtherKey).toBe('value');
    expect(settings.hooks).toBeDefined();
  });

  it('should remove only its own hooks on cleanup', async () => {
    const claudeDir = path.join(tmpDir, '.claude');
    await fs.mkdir(claudeDir, { recursive: true });

    const config = makeConfig(3101);
    await config.writeHooksConfig();

    const customHook = { matcher: 'Read', hooks: [{ type: 'command' as const, command: 'echo' }] };
    const settingsWithExtra = await readSettings();
    settingsWithExtra.hooks.CustomHook = [customHook];
    settingsWithExtra.hooks.PostToolUse.push(customHook);
    await fs.writeFile(settingsPath, JSON.stringify(settingsWithExtra, null, 2), 'utf-8');

    await config.removeHooksConfig();

    const cleaned = await readSettings();
    expect(cleaned.hooks).not.toHaveProperty('Stop');
    expect(cleaned.hooks).not.toHaveProperty('SessionStart');
    expect(cleaned.hooks).not.toHaveProperty('UserPromptSubmit');
    expect(cleaned.hooks).toHaveProperty('CustomHook');
    expect(cleaned.hooks.CustomHook).toEqual([customHook]);
    expect(cleaned.hooks.PostToolUse).toEqual([customHook]);
  });

  it('should create settings file if it does not exist', async () => {
    const config = makeConfig(3101);
    await config.writeHooksConfig();

    const settings = await readSettings();
    expect(settings.hooks).toBeDefined();
    expect(settings.hooks.PostToolUse[0].hooks[0].url).toBe(
      'http://127.0.0.1:3101/hook/post-tool-use'
    );
  });

  it('should handle malformed existing settings.json', async () => {
    const claudeDir = path.join(tmpDir, '.claude');
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.writeFile(settingsPath, 'not valid json{{{', 'utf-8');

    const config = makeConfig(3101);
    await config.writeHooksConfig();

    const settings = await readSettings();
    expect(settings.hooks).toBeDefined();
    expect(settings.hooks.PostToolUse[0].hooks[0].url).toBe(
      'http://127.0.0.1:3101/hook/post-tool-use'
    );
  });

  it('should handle directory not existing', async () => {
    const deepPath = path.join(tmpDir, 'a', 'b', 'c', 'settings.json');
    const config = new ClaudeChannelHooksConfig({ hookPort: 3101, claudeSettingsPath: deepPath });

    await config.writeHooksConfig();

    const raw = await fs.readFile(deepPath, 'utf-8');
    const settings = JSON.parse(raw);
    expect(settings.hooks.PostToolUse).toBeDefined();
  });

  it('should use custom claudeSettingsPath when provided', async () => {
    const customPath = path.join(tmpDir, 'custom-settings.json');
    const config = new ClaudeChannelHooksConfig({ hookPort: 9999, claudeSettingsPath: customPath });

    await config.writeHooksConfig();

    const raw = await fs.readFile(customPath, 'utf-8');
    const settings = JSON.parse(raw);
    expect(settings.hooks.PostToolUse[0].hooks[0].url).toBe(
      'http://127.0.0.1:9999/hook/post-tool-use'
    );
  });

  it('should use default path when claudeSettingsPath is not provided', () => {
    const config = new ClaudeChannelHooksConfig({ hookPort: 3101 });
    expect(config).toBeDefined();

    const hooks = config.buildHooksConfig();
    expect(hooks.hooks.PostToolUse[0].hooks[0].url).toContain('3101');
  });

  it('should handle removeHooksConfig when file does not exist', async () => {
    const config = makeConfig(3101);
    await expect(config.removeHooksConfig()).resolves.toBeUndefined();
  });

  it('should remove hooks key entirely when no hooks remain', async () => {
    const config = makeConfig(3101);
    await config.writeHooksConfig();

    const settings = await readSettings();
    expect(settings.hooks).toBeDefined();

    await config.removeHooksConfig();

    const cleaned = await readSettings();
    expect(cleaned).not.toHaveProperty('hooks');
  });
});
