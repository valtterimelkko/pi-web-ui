import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
  THINKING_BUDGET_MAP,
} from '../../../src/opencode/opencode-config-manager.js';

const MOCK_CONFIG_PATH = path.join(os.homedir(), '.config', 'opencode', 'opencode.json');

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

describe('THINKING_BUDGET_MAP', () => {
  it('has all non-off levels', () => {
    expect(Object.keys(THINKING_BUDGET_MAP)).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh']);
  });

  it('values increase monotonically', () => {
    const levels = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;
    for (let i = 1; i < levels.length; i++) {
      expect(THINKING_BUDGET_MAP[levels[i]]).toBeGreaterThan(THINKING_BUDGET_MAP[levels[i - 1]]);
    }
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

  it('writes thinkingBudget for each non-off level', async () => {
    for (const [level, expected] of Object.entries(THINKING_BUDGET_MAP)) {
      vi.clearAllMocks();
      mockConfigFile({});
      await applyThinkingBudget('zai-coding-plan/glm-5.1', level as keyof typeof THINKING_BUDGET_MAP);
      const written = JSON.parse((vi.mocked(fs.writeFile).mock.calls[0] as [string, string])[1]);
      expect(written.provider['zai-coding-plan'].models['glm-5.1'].options.thinkingBudget).toBe(expected);
    }
  });

  it('preserves existing config keys when writing', async () => {
    const existing = { $schema: 'x', mcp: { server: {} } };
    mockConfigFile(existing);
    await applyThinkingBudget('zai-coding-plan/glm-5.1', 'medium');
    const written = JSON.parse((vi.mocked(fs.writeFile).mock.calls[0] as [string, string])[1]);
    expect(written.$schema).toBe('x');
    expect(written.mcp).toEqual({ server: {} });
    expect(written.provider['zai-coding-plan'].models['glm-5.1'].options.thinkingBudget).toBe(
      THINKING_BUDGET_MAP.medium,
    );
  });

  it('removes thinkingBudget on level=off', async () => {
    const existing = {
      provider: {
        'zai-coding-plan': {
          models: { 'glm-5.1': { options: { thinkingBudget: 16000 } } },
        },
      },
    };
    mockConfigFile(existing);
    await applyThinkingBudget('zai-coding-plan/glm-5.1', 'off');
    const written = JSON.parse((vi.mocked(fs.writeFile).mock.calls[0] as [string, string])[1]);
    expect(written.provider).toBeUndefined();
  });

  it('off cleans up empty provider objects', async () => {
    const existing = {
      $schema: 'https://opencode.ai/config.json',
      provider: {
        'zai-coding-plan': {
          models: { 'glm-5.1': { options: { thinkingBudget: 16000 } } },
        },
      },
    };
    mockConfigFile(existing);
    await applyThinkingBudget('zai-coding-plan/glm-5.1', 'off');
    const written = JSON.parse((vi.mocked(fs.writeFile).mock.calls[0] as [string, string])[1]);
    expect(written.provider).toBeUndefined();
    expect(written.$schema).toBe('https://opencode.ai/config.json');
  });

  it('off leaves other model options intact', async () => {
    const existing = {
      provider: {
        'zai-coding-plan': {
          models: {
            'glm-5.1': { options: { thinkingBudget: 16000 } },
            'glm-4.5': { options: { thinkingBudget: 4096 } },
          },
        },
      },
    };
    mockConfigFile(existing);
    await applyThinkingBudget('zai-coding-plan/glm-5.1', 'off');
    const written = JSON.parse((vi.mocked(fs.writeFile).mock.calls[0] as [string, string])[1]);
    expect(written.provider?.['zai-coding-plan']?.models?.['glm-5.1']).toBeUndefined();
    expect(written.provider?.['zai-coding-plan']?.models?.['glm-4.5']?.options?.thinkingBudget).toBe(4096);
  });
});
