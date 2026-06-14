import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Must mock before importing the module under test
vi.mock('node:fs/promises');
vi.mock('node:fs');

import {
  parseModelId,
  applyThinkingBudget,
  readOpenCodeConfig,
  writeOpenCodeConfig,
} from '../../../src/opencode/opencode-config-manager.js';
import type { ThinkingLevel } from '../../../src/opencode/opencode-config-manager.js';

const MOCK_CONFIG_PATH = path.join(os.homedir(), '.config', 'opencode', 'opencode.json');

const NON_OFF_LEVELS: Exclude<ThinkingLevel, 'off'>[] = ['minimal', 'low', 'medium', 'high', 'xhigh'];

// Reset all mock state before every test so call counts don't bleed across describe blocks
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fs.writeFile).mockResolvedValue(undefined);
});

function mockConfigFile(content: object | null): void {
  vi.mocked(fsSync.existsSync).mockReturnValue(content !== null);
  vi.mocked(fs.readFile).mockResolvedValue(
    content !== null ? JSON.stringify(content) : '',
  );
}

describe('parseModelId', () => {
  it('splits provider/model correctly', () => {
    expect(parseModelId('zai-coding-plan/glm-5.1')).toEqual({
      providerId: 'zai-coding-plan',
      modelId: 'glm-5.1',
    });
  });

  it('handles model with no provider prefix', () => {
    expect(parseModelId('glm-5.1')).toEqual({
      providerId: null,
      modelId: 'glm-5.1',
    });
  });

  it('handles multi-segment paths', () => {
    expect(parseModelId('anthropic/claude/sonnet-4')).toEqual({
      providerId: 'anthropic',
      modelId: 'claude/sonnet-4',
    });
  });
});

describe('readOpenCodeConfig', () => {
  it('returns empty object when config file missing', async () => {
    mockConfigFile(null);
    const cfg = await readOpenCodeConfig();
    expect(cfg).toEqual({});
  });

  it('parses existing config', async () => {
    const content = { $schema: 'x', mcp: {} };
    mockConfigFile(content);
    const cfg = await readOpenCodeConfig();
    expect(cfg).toEqual(content);
  });

  it('returns empty object on parse error', async () => {
    vi.mocked(fsSync.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFile).mockResolvedValue('not json');
    const cfg = await readOpenCodeConfig();
    expect(cfg).toEqual({});
  });
});

describe('writeOpenCodeConfig', () => {
  it('writes pretty-printed JSON with trailing newline', async () => {
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    const cfg = { $schema: 'x', provider: {} };
    await writeOpenCodeConfig(cfg);
    const [writePath, content] = vi.mocked(fs.writeFile).mock.calls[0] as [string, string, string];
    expect(writePath).toBe(MOCK_CONFIG_PATH);
    expect(content).toBe(JSON.stringify(cfg, null, 2) + '\n');
  });
});

describe('applyThinkingBudget', () => {
  it('is a no-op when model has no provider prefix', async () => {
    mockConfigFile({});
    await applyThinkingBudget('glm-5.1', 'high');
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it('writes thinking:{type:"enabled"} for each non-off level', async () => {
    for (const level of NON_OFF_LEVELS) {
      vi.clearAllMocks();
      mockConfigFile({});
      await applyThinkingBudget('zai-coding-plan/glm-5.2', level);
      expect(fs.writeFile).toHaveBeenCalledTimes(1);
      const written = JSON.parse((vi.mocked(fs.writeFile).mock.calls[0] as [string, string])[1]);
      expect(written.provider['zai-coding-plan'].models['glm-5.2'].options.thinking).toEqual({
        type: 'enabled',
      });
    }
  });

  it('removes thinking option on level=off, cleaning up empty objects', async () => {
    const existing = {
      provider: {
        'zai-coding-plan': {
          models: { 'glm-5.2': { options: { thinking: { type: 'enabled' } } } },
        },
      },
    };
    mockConfigFile(existing);
    await applyThinkingBudget('zai-coding-plan/glm-5.2', 'off');
    const written = JSON.parse((vi.mocked(fs.writeFile).mock.calls[0] as [string, string])[1]);
    expect(written.provider).toBeUndefined();
  });

  it('preserves existing config keys when writing', async () => {
    const existing = { $schema: 'x', mcp: { server: {} } };
    mockConfigFile(existing);
    await applyThinkingBudget('zai-coding-plan/glm-5.2', 'medium');
    const written = JSON.parse((vi.mocked(fs.writeFile).mock.calls[0] as [string, string])[1]);
    expect(written.$schema).toBe('x');
    expect(written.mcp).toEqual({ server: {} });
    expect(written.provider['zai-coding-plan'].models['glm-5.2'].options.thinking).toEqual({
      type: 'enabled',
    });
  });

  it('off cleans up empty provider objects but preserves schema', async () => {
    const existing = {
      $schema: 'https://opencode.ai/config.json',
      provider: {
        'zai-coding-plan': {
          models: { 'glm-5.2': { options: { thinking: { type: 'disabled' } } } },
        },
      },
    };
    mockConfigFile(existing);
    await applyThinkingBudget('zai-coding-plan/glm-5.2', 'off');
    const written = JSON.parse((vi.mocked(fs.writeFile).mock.calls[0] as [string, string])[1]);
    expect(written.provider).toBeUndefined();
    expect(written.$schema).toBe('https://opencode.ai/config.json');
  });

  it('off leaves other model options intact', async () => {
    const existing = {
      provider: {
        'zai-coding-plan': {
          models: {
            'glm-5.2': { options: { thinking: { type: 'enabled' } } },
            'glm-4.5': { options: { thinking: { type: 'enabled' } } },
          },
        },
      },
    };
    mockConfigFile(existing);
    await applyThinkingBudget('zai-coding-plan/glm-5.2', 'off');
    const written = JSON.parse((vi.mocked(fs.writeFile).mock.calls[0] as [string, string])[1]);
    expect(written.provider?.['zai-coding-plan']?.models?.['glm-5.2']).toBeUndefined();
    expect(written.provider?.['zai-coding-plan']?.models?.['glm-4.5']?.options?.thinking).toEqual({
      type: 'enabled',
    });
  });

  it('works for GLM-5.1 model ID', async () => {
    mockConfigFile({});
    await applyThinkingBudget('zai-coding-plan/glm-5.1', 'high');
    const written = JSON.parse((vi.mocked(fs.writeFile).mock.calls[0] as [string, string])[1]);
    expect(written.provider['zai-coding-plan'].models['glm-5.1'].options.thinking).toEqual({
      type: 'enabled',
    });
  });

  it('works for GLM-5.2 model ID', async () => {
    mockConfigFile({});
    await applyThinkingBudget('zai-coding-plan/glm-5.2', 'high');
    const written = JSON.parse((vi.mocked(fs.writeFile).mock.calls[0] as [string, string])[1]);
    expect(written.provider['zai-coding-plan'].models['glm-5.2'].options.thinking).toEqual({
      type: 'enabled',
    });
  });
});
