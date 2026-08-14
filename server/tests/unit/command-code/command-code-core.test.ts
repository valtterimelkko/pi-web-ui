import { chmod, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  COMMAND_CODE_EXCLUDED_MODELS,
  isCommandCodeEligible,
  parseCommandCodeModelList,
  discoverCommandCodeModels,
} from '../../../src/command-code/command-code-model-catalog.js';
import {
  CommandCodeNdjsonParser,
  CommandCodeProtocolError,
} from '../../../src/command-code/command-code-ndjson-parser.js';
import {
  buildCommandCodeArgs,
  defaultCommandCodeConfig,
} from '../../../src/command-code/command-code-config.js';

describe('Command Code model discovery', () => {
  it('does not pin readiness to a repository-owned CLI version', () => {
    expect(defaultCommandCodeConfig().enabled).toBe(false);
    expect(defaultCommandCodeConfig().maxTurns).toBe(8);
  });

  it('excludes exactly the 19 premium models and nothing else', () => {
    expect(COMMAND_CODE_EXCLUDED_MODELS).toHaveLength(19);
    expect(isCommandCodeEligible('qwen/qwen3.8-max')).toBe(true);
    expect(isCommandCodeEligible('gpt-5.6-luna')).toBe(true);
    expect(isCommandCodeEligible('google/gemini-3.7-flash')).toBe(true);
    expect(isCommandCodeEligible('meta/muse-spark-1.2-contributor')).toBe(true);
    for (const excluded of COMMAND_CODE_EXCLUDED_MODELS) {
      expect(isCommandCodeEligible(excluded)).toBe(false);
    }
    // An unknown id is eligible by default: the denylist fails open.
    expect(isCommandCodeEligible('unknown/new-model')).toBe(true);
  });

  it('keeps version and exact ids from a fresh cmd --list-models probe', () => {
    const probe = 'Command Code v1.19.0\nqwen/qwen3.8-max             autonomous description\nmeta/muse-spark-1.2-contributor             contributor description';
    expect(parseCommandCodeModelList(probe)).toEqual({
      version: '1.19.0',
      models: ['qwen/qwen3.8-max', 'meta/muse-spark-1.2-contributor'],
      ambiguous: [],
    });
  });

  it('accepts the current bare cmd --version format', () => {
    expect(parseCommandCodeModelList('1.19.0\n')).toMatchObject({ version: '1.19.0' });
  });

  it('ignores prose and single-space aliases instead of treating them as executable model ids', () => {
    expect(parseCommandCodeModelList([
      'Available models · 2 models',
      'Use the full id or short alias',
      'qwen/qwen3.8-max alias',
      'qwen/qwen3.8-max             full description',
      'cmd --model qwen/qwen3.8-max',
    ].join('\n'))).toMatchObject({
      models: ['qwen/qwen3.8-max'],
      ambiguous: [],
    });
  });

  it('parses every exact model id advertised by the live catalogue, not only shadow routes', () => {
    const probe = [
      'Available models  ·  3 models',
      '',
      'Open Source',
      'deepseek/deepseek-v4-pro             long-context reasoning',
      'claude-sonnet-5                       provider short id',
      'qwen/qwen3.8-max                     autonomous coding',
      'meta/muse-spark-1.2-contributor      contributor route',
      '',
      'Pass the full id, or just the short name after the last "/":',
      'cmd --model moonshotai/kimi-k2.5',
      'cmd --model kimi-k2.5',
    ].join('\n');

    expect(parseCommandCodeModelList(probe)).toMatchObject({
      models: [
        'deepseek/deepseek-v4-pro',
        'claude-sonnet-5',
        'qwen/qwen3.8-max',
        'meta/muse-spark-1.2-contributor',
      ],
      ambiguous: [],
    });
  });

  it('uses a bounded controlled environment and kills a hung discovery probe', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'command-code-discovery-'));
    const script = path.join(root, 'fake-cmd.mjs');
    const secretMarker = path.join(root, 'secret-seen');
    const scriptBody = `import { writeFileSync } from 'node:fs';\nconst marker = ${JSON.stringify(secretMarker)};\nif (process.env.COMMAND_CODE_TEST_SECRET) writeFileSync(marker, 'secret-seen');\nif (process.argv.includes('--version')) console.log('Command Code v1.19.0');\nelse if (process.argv.includes('--list-models')) console.log('qwen/qwen3.8-max             autonomous description\\nmeta/muse-spark-1.2-contributor             contributor description');\nelse setTimeout(() => {}, 1000);\n`;
    await import('node:fs/promises').then(({ writeFile }) => writeFile(script, `#!/usr/bin/env node\n${scriptBody}`));
    await chmod(script, 0o700);
    const previous = process.env.COMMAND_CODE_TEST_SECRET;
    process.env.COMMAND_CODE_TEST_SECRET = 'do-not-forward';
    const hangScript = path.join(root, 'hang-cmd.mjs');
    await import('node:fs/promises').then(({ writeFile }) => writeFile(hangScript, '#!/usr/bin/env node\nsetTimeout(() => {}, 1000);'));
    await chmod(hangScript, 0o700);
    try {
      const { readFile } = await import('node:fs/promises');
      await expect(discoverCommandCodeModels(script)).resolves.toMatchObject({ version: '1.19.0', models: ['qwen/qwen3.8-max', 'meta/muse-spark-1.2-contributor'] });
      await expect(discoverCommandCodeModels(hangScript, { timeoutMs: 20 })).rejects.toThrow(/timed out/i);
      await expect(readFile(secretMarker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      if (previous === undefined) delete process.env.COMMAND_CODE_TEST_SECRET;
      else process.env.COMMAND_CODE_TEST_SECRET = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('Command Code command construction', () => {
  it('uses the absolute executable, exact model, stdin prompt, and never --continue', () => {
    const args = buildCommandCodeArgs({
      executablePath: '/opt/bin/cmd',
      model: 'qwen/qwen3.8-max',
      maxTurns: 3,
    });
    expect(args).toEqual([
      '-p', '--output-format', 'json', '--model', 'qwen/qwen3.8-max',
      '--max-turns', '3', '--trust', '--skip-onboarding', '--no-auto-update',
      '--plan',
    ]);
    expect(args).not.toContain('--continue');
    expect(args).not.toContain('--yolo');
  });

  it('accepts every discovered model id without a permission profile branch', () => {
    expect(buildCommandCodeArgs({
      executablePath: '/opt/bin/cmd', model: 'deepseek/deepseek-v4-pro', maxTurns: 2,
    })).toContain('deepseek/deepseek-v4-pro');
  });

  it('validates native effort against the committed effort table', () => {
    expect(() => buildCommandCodeArgs({
      executablePath: '/opt/bin/cmd', model: 'qwen/qwen3.8-max', maxTurns: 2, effort: 'not-a-level',
    })).toThrow(/effort|supported/i);
  });

  it('resumes only by the stored exact native session id', () => {
    const args = buildCommandCodeArgs({
      executablePath: '/opt/bin/cmd',
      model: 'meta/muse-spark-1.2-contributor',
      maxTurns: 2,
      nativeSessionId: 'native-123',
    });
    expect(args).toContain('--resume');
    expect(args).toContain('native-123');
    expect(args).not.toContain('--continue');
  });
});

describe('Command Code NDJSON parser', () => {
  it('handles chunk-split frames, retains unknown events, and requires one terminal result', () => {
    const parser = new CommandCodeNdjsonParser();
    parser.push('{"type":"event","event":{"type":"message_update","text":"hel');
    parser.push('lo"}}\n{"type":"event","event":{"type":"mystery","x":"y"}}\n');
    parser.push('{"type":"result","subtype":"success","sessionId":"native-1","finalText":"hello"}\n');
    const parsed = parser.finish(0);
    expect(parsed.terminal).toMatchObject({ subtype: 'success', sessionId: 'native-1' });
    expect(parsed.events).toHaveLength(2);
    expect(parsed.unknownEventTypes).toEqual(['mystery']);
  });

  it('rejects EOF without a terminal result and contradictory exit status', () => {
    const incomplete = new CommandCodeNdjsonParser();
    incomplete.push('{"type":"event","event":{"type":"message_update","text":"x"}}\n');
    expect(() => incomplete.finish(0)).toThrow(CommandCodeProtocolError);

    const contradiction = new CommandCodeNdjsonParser();
    contradiction.push('{"type":"result","subtype":"success","sessionId":"native-1"}\n');
    expect(() => contradiction.finish(1)).toThrow(CommandCodeProtocolError);
  });

  it('suppresses repeated cumulative text snapshots while preserving suffixes', () => {
    const parser = new CommandCodeNdjsonParser();
    parser.push([
      { type: 'event', event: { type: 'message_update', messageId: 'm1', text: 'a', cumulative: true } },
      { type: 'event', event: { type: 'message_update', messageId: 'm1', text: 'a', cumulative: true } },
      { type: 'event', event: { type: 'message_update', messageId: 'm1', text: 'ab', cumulative: true } },
      { type: 'result', subtype: 'success', sessionId: 'native-1', finalText: 'ab' },
    ].map((value) => `${JSON.stringify(value)}\n`).join(''));
    const parsed = parser.finish(0);
    expect(parsed.events.map((event) => event.event.text)).toEqual(['a', 'b']);
    expect(parsed.suppressedDuplicateCount).toBe(1);
  });
});
