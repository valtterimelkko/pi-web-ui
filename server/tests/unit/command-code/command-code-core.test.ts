import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  COMMAND_CODE_MODELS,
  COMMAND_CODE_FULL_MODEL_CATALOGUE,
  COMMAND_CODE_VERSION,
  assertCommandCodeModel,
  discoverCommandCodeEfforts,
  discoverCommandCodeModels,
  parseCommandCodeModelList,
  validateCommandCodeModelCatalogue,
} from '../../../src/command-code/command-code-model-catalog.js';
import {
  CommandCodeNdjsonParser,
  CommandCodeProtocolError,
} from '../../../src/command-code/command-code-ndjson-parser.js';
import {
  buildCommandCodeArgs,
  COMMAND_CODE_EXECUTION_INSTANCE_ID,
  defaultCommandCodeConfig,
  getCommandCodeProfile,
} from '../../../src/command-code/command-code-config.js';

describe('Command Code model identity', () => {
  it('does not pin readiness to a repository-owned CLI version', () => {
    expect(defaultCommandCodeConfig().expectedVersion).toBeUndefined();
  });

  it('pins the complete 54-model catalogue and rejects catalogue drift', () => {
    expect(COMMAND_CODE_FULL_MODEL_CATALOGUE).toHaveLength(54);
    expect(COMMAND_CODE_FULL_MODEL_CATALOGUE).toContain('google/gemini-3.7-flash');
    expect(validateCommandCodeModelCatalogue(COMMAND_CODE_FULL_MODEL_CATALOGUE)).toEqual({ valid: true });
    expect(validateCommandCodeModelCatalogue([
      ...COMMAND_CODE_FULL_MODEL_CATALOGUE.slice(0, 10),
      'unknown/provider-model',
      ...COMMAND_CODE_FULL_MODEL_CATALOGUE.slice(11),
    ])).toMatchObject({ valid: false, reason: 'extra_model' });
    expect(validateCommandCodeModelCatalogue([
      ...COMMAND_CODE_FULL_MODEL_CATALOGUE.slice(0, 4),
      COMMAND_CODE_FULL_MODEL_CATALOGUE[3],
      ...COMMAND_CODE_FULL_MODEL_CATALOGUE.slice(5),
    ])).toMatchObject({ valid: false, reason: 'duplicate_model' });
    expect(validateCommandCodeModelCatalogue([
      COMMAND_CODE_FULL_MODEL_CATALOGUE[1],
      COMMAND_CODE_FULL_MODEL_CATALOGUE[0],
      ...COMMAND_CODE_FULL_MODEL_CATALOGUE.slice(2),
    ])).toMatchObject({ valid: false, reason: 'reordered_model' });
    expect(validateCommandCodeModelCatalogue(COMMAND_CODE_FULL_MODEL_CATALOGUE.slice(0, -1))).toMatchObject({ valid: false, reason: 'missing_model' });
    expect(validateCommandCodeModelCatalogue([...COMMAND_CODE_FULL_MODEL_CATALOGUE, 'extra/model'])).toMatchObject({ valid: false, reason: 'extra_model' });
  });

  it('accepts only the two exact discovered model ids', () => {
    expect(COMMAND_CODE_MODELS).toEqual([
      'qwen/qwen3.8-max',
      'meta/muse-spark-1.2-contributor',
    ]);
    expect(assertCommandCodeModel('qwen/qwen3.8-max')).toBe('qwen/qwen3.8-max');
    expect(assertCommandCodeModel('Qwen/Qwen3.8-Max')).toBeUndefined();
    expect(assertCommandCodeModel('qwen3.8-max')).toBeUndefined();
    expect(assertCommandCodeModel('meta/muse-spark-1.2')).toBeUndefined();
  });

  it('keeps version and exact ids from a fresh cmd --list-models probe', () => {
    const probe = `Command Code v${COMMAND_CODE_VERSION}\nqwen/qwen3.8-max             autonomous description\nmeta/muse-spark-1.2-contributor             contributor description`;
    expect(parseCommandCodeModelList(probe)).toEqual({
      version: COMMAND_CODE_VERSION,
      models: [...COMMAND_CODE_MODELS],
      ambiguous: [],
    });
  });

  it('accepts the current bare cmd --version format', () => {
    expect(parseCommandCodeModelList('1.19.0\n')).toMatchObject({ version: '1.19.0' });
  });

  it('allows a discovered model only through the contained browser profile', () => {
    const options = {
      executablePath: '/opt/bin/cmd',
      model: 'deepseek/deepseek-v4-pro',
      maxTurns: 1,
    } as const;
    expect(buildCommandCodeArgs({ ...options, permissionProfile: 'browser-contained' })).toContain('deepseek/deepseek-v4-pro');
    expect(() => buildCommandCodeArgs({ ...options, permissionProfile: 'implementation-child-wide' })).toThrow(/allowlisted executable route/i);
  });

  it('fails closed when the version probe and model-list version disagree', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'command-code-version-drift-'));
    const script = path.join(root, 'fake-cmd.mjs');
    const catalogueRows = COMMAND_CODE_FULL_MODEL_CATALOGUE
      .map((model) => `${model}             fixture model`)
      .join('\\n');
    await import('node:fs/promises').then(({ writeFile }) => writeFile(script, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('1.19.0'); process.exit(0); }
if (args.includes('--list-models')) { console.log('Command Code v1.23.1\\nAvailable models  ·  54 models\\n${catalogueRows}'); process.exit(0); }
process.exit(0);
`));
    await chmod(script, 0o700);
    try {
      await expect(discoverCommandCodeModels(script)).rejects.toThrow(/version.*(disagree|mismatch)|mismatch.*version/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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

  it('discovers model-specific native effort support and defaults without inheriting credentials', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'command-code-effort-discovery-'));
    const script = path.join(root, 'fake-cmd.mjs');
    const secretMarker = path.join(root, 'secret-seen');
    const scriptBody = `import { writeFileSync } from 'node:fs';\nconst marker = ${JSON.stringify(secretMarker)};\nif (process.env.COMMAND_CODE_TEST_SECRET) writeFileSync(marker, 'secret-seen');\nconst args = process.argv.slice(2);\nconst model = args[args.indexOf('--model') + 1];\nconst effort = args[args.indexOf('--effort') + 1];\nif (args.includes('--version')) console.log('Command Code v1.19.0');\nelse if (args.includes('--list-models')) console.log('qwen/qwen3.8-max             autonomous description\\nmeta/muse-spark-1.2-contributor             contributor description');\nelse if (model === 'qwen/qwen3.8-max' && ['low', 'medium', 'xhigh'].includes(effort)) { console.error('authentication required'); process.exit(3); }\nelse { console.error('unsupported reasoning effort'); process.exit(2); }\n`;
    await import('node:fs/promises').then(({ writeFile }) => writeFile(script, `#!/usr/bin/env node
${scriptBody}`));
    await chmod(script, 0o700);
    const previous = process.env.COMMAND_CODE_TEST_SECRET;
    process.env.COMMAND_CODE_TEST_SECRET = 'do-not-forward';
    try {
      const discovered = await discoverCommandCodeEfforts(script);
      expect(discovered.capabilities['qwen/qwen3.8-max']).toMatchObject({
        supportsEffort: true,
        effortLevels: ['low', 'medium', 'xhigh'],
        defaultEffort: 'medium',
        source: 'live-preflight',
      });
      expect(discovered.capabilities['meta/muse-spark-1.2-contributor']).toMatchObject({
        supportsEffort: false,
        effortLevels: [],
        source: 'live-preflight',
      });
      await expect(readFile(secretMarker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      if (previous === undefined) delete process.env.COMMAND_CODE_TEST_SECRET;
      else process.env.COMMAND_CODE_TEST_SECRET = previous;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('recognises flag-accepted effort probes that stop before a model turn', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'command-code-effort-flag-probe-'));
    const script = path.join(root, 'fake-cmd.mjs');
    const scriptBody = `#!/usr/bin/env node
const args = process.argv.slice(2);
const model = args[args.indexOf('--model') + 1];
const effort = args[args.indexOf('--effort') + 1];
if (args.includes('--version')) console.log('Command Code v1.19.0');
else if (args.includes('--list-models')) console.log('qwen/qwen3.8-max             autonomous description\\nmeta/muse-spark-1.2-contributor             contributor description');
else if (model === 'qwen/qwen3.8-max' && ['low', 'medium', 'xhigh'].includes(effort)) { console.log('Reasoning effort set to ' + effort + ' for Qwen 3.8 Max.'); console.error('Error: No query provided. Usage: cmd -p \\"your query\\"'); process.exit(1); }
else { console.error('Muse Spark 1.2 Contributor has no adjustable reasoning effort.'); process.exit(1); }
`;
    await import('node:fs/promises').then(({ writeFile }) => writeFile(script, scriptBody));
    await chmod(script, 0o700);
    try {
      const discovered = await discoverCommandCodeEfforts(script);
      expect(discovered.capabilities['qwen/qwen3.8-max']).toMatchObject({
        supportsEffort: true,
        effortLevels: ['low', 'medium', 'xhigh'],
        defaultEffort: 'medium',
      });
      expect(discovered.capabilities['meta/muse-spark-1.2-contributor']).toMatchObject({
        supportsEffort: false,
        effortLevels: [],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses exhaustive probes for approved models while using bounded list probes for extra discoveries', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'command-code-effort-hybrid-probe-'));
    const script = path.join(root, 'fake-cmd.mjs');
    const calls = path.join(root, 'calls.jsonl');
    const scriptBody = `import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
const model = args[args.indexOf('--model') + 1] || '';
const effort = args[args.indexOf('--effort') + 1] || '';
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ model, effort }) + '\\n');
if (model === 'qwen/qwen3.8-max' && ['low', 'medium', 'xhigh'].includes(effort)) { console.error('authentication required'); process.exit(3); }
if (model === 'qwen/qwen3.8-max') { console.error('Unknown effort. Supported: low, medium, xhigh.'); process.exit(2); }
if (model === 'deepseek/deepseek-v4-pro') { console.error('Unknown effort. Supported: high, max.'); process.exit(2); }
console.error('unsupported reasoning effort'); process.exit(2);
`;
    await import('node:fs/promises').then(({ writeFile }) => writeFile(script, `#!/usr/bin/env node\n${scriptBody}`));
    await chmod(script, 0o700);
    try {
      const discovered = await discoverCommandCodeEfforts(script, {
        models: ['qwen/qwen3.8-max', 'deepseek/deepseek-v4-pro'],
        probeAllValues: false,
        probeAllValuesForModels: ['qwen/qwen3.8-max'],
      });
      expect(discovered.capabilities['qwen/qwen3.8-max']).toMatchObject({ supportsEffort: true, effortLevels: ['low', 'medium', 'xhigh'], defaultEffort: 'medium' });
      expect(discovered.capabilities['deepseek/deepseek-v4-pro']).toMatchObject({ supportsEffort: true, effortLevels: ['high', 'max'] });
      expect(discovered.capabilities['deepseek/deepseek-v4-pro']?.defaultEffort).toBeUndefined();
      const probes = (await readFile(calls, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { model: string; effort: string });
      expect(probes.filter((probe) => probe.model === 'qwen/qwen3.8-max').map((probe) => probe.effort)).toEqual(expect.arrayContaining(['low', 'medium', 'xhigh']));
      expect(probes.filter((probe) => probe.model === 'deepseek/deepseek-v4-pro').map((probe) => probe.effort)).toEqual(['__pi_web_ui_capability_probe__']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed when an approved model advertises a newly added native effort value', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'command-code-effort-drift-probe-'));
    const script = path.join(root, 'fake-cmd.mjs');
    const scriptBody = `#!/usr/bin/env node
const args = process.argv.slice(2);
const model = args[args.indexOf('--model') + 1];
const effort = args[args.indexOf('--effort') + 1];
if (effort === '__pi_web_ui_capability_probe__') { console.error('Unknown effort. Supported: low, medium, xhigh, ultra.'); process.exit(2); }
if (model === 'qwen/qwen3.8-max' && ['low', 'medium', 'xhigh'].includes(effort)) { console.error('authentication required'); process.exit(3); }
console.error('unsupported reasoning effort'); process.exit(2);
`;
    await import('node:fs/promises').then(({ writeFile }) => writeFile(script, scriptBody));
    await chmod(script, 0o700);
    try {
      const discovered = await discoverCommandCodeEfforts(script, {
        models: ['qwen/qwen3.8-max'],
        probeAllValues: false,
        probeAllValuesForModels: ['qwen/qwen3.8-max'],
      });
      expect(discovered.capabilities['qwen/qwen3.8-max']).toMatchObject({
        supportsEffort: false,
        effortLevels: [],
        status: 'unknown',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('parses native effort lists from one model-specific invalid-value probe', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'command-code-effort-list-probe-'));
    const script = path.join(root, 'fake-cmd.mjs');
    const scriptBody = `#!/usr/bin/env node
const args = process.argv.slice(2);
const model = args[args.indexOf('--model') + 1];
if (model === 'qwen/qwen3.8-max') console.error('Unknown effort "probe". Supported: low, medium, xhigh.');
else console.error('Muse Spark 1.2 Contributor has no adjustable reasoning effort.');
process.exit(1);
`;
    await import('node:fs/promises').then(({ writeFile }) => writeFile(script, scriptBody));
    await chmod(script, 0o700);
    try {
      const discovered = await discoverCommandCodeEfforts(script, {
        models: ['qwen/qwen3.8-max', 'meta/muse-spark-1.2-contributor'],
        probeAllValues: false,
      });
      expect(discovered.capabilities['qwen/qwen3.8-max']).toMatchObject({ supportsEffort: true, effortLevels: ['low', 'medium', 'xhigh'], defaultEffort: 'medium' });
      expect(discovered.capabilities['meta/muse-spark-1.2-contributor']).toMatchObject({ supportsEffort: false, effortLevels: [], status: 'unavailable' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('bounds the complete hybrid effort discovery budget', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'command-code-effort-total-timeout-'));
    const script = path.join(root, 'slow-cmd.mjs');
    await import('node:fs/promises').then(({ writeFile }) => writeFile(script, '#!/usr/bin/env node\nsetTimeout(() => {}, 1000);'));
    await chmod(script, 0o700);
    try {
      await expect(discoverCommandCodeEfforts(script, {
        models: ['qwen/qwen3.8-max'],
        probeAllValues: false,
        totalTimeoutMs: 1,
        timeoutMs: 50,
      })).rejects.toThrow(/effort discovery timed out/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
      await expect(discoverCommandCodeModels(script)).resolves.toMatchObject({ version: '1.19.0', models: [...COMMAND_CODE_MODELS] });
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
      permissionProfile: 'agent-os-7f-root-readonly',
    });
    expect(args).toEqual([
      '-p', '--output-format', 'json', '--model', 'qwen/qwen3.8-max',
      '--max-turns', '3', '--trust', '--skip-onboarding', '--no-auto-update',
      '--plan',
    ]);
    expect(args).not.toContain('--continue');
    expect(args).not.toContain('--yolo');
    expect(COMMAND_CODE_EXECUTION_INSTANCE_ID).toBe('commandcode-default');
    expect(getCommandCodeProfile('implementation-child-wide').args).toContain('--yolo');
    expect(() => getCommandCodeProfile('invalid-profile' as never)).toThrow(/unknown.*profile/i);
  });

  it('rejects evidence-only catalogue models at the executable argument boundary', () => {
    expect(() => buildCommandCodeArgs({
      executablePath: '/opt/bin/cmd', model: 'deepseek/deepseek-v4-pro', maxTurns: 2,
      permissionProfile: 'implementation-child-wide',
    })).toThrow(/allowlist|policy|approved|exact/i);
  });

  it('validates native effort against the exact model capability', () => {
    expect(buildCommandCodeArgs({
      executablePath: '/opt/bin/cmd', model: 'qwen/qwen3.8-max', maxTurns: 2,
      permissionProfile: 'implementation-child-wide', effort: 'xhigh',
    })).toContain('xhigh');
    expect(() => buildCommandCodeArgs({
      executablePath: '/opt/bin/cmd', model: 'qwen/qwen3.8-max', maxTurns: 2,
      permissionProfile: 'implementation-child-wide', effort: 'high',
    })).toThrow(/effort|supported/i);
    expect(() => buildCommandCodeArgs({
      executablePath: '/opt/bin/cmd', model: 'meta/muse-spark-1.2-contributor', maxTurns: 2,
      permissionProfile: 'implementation-child-wide', effort: 'low',
    })).toThrow(/effort|supported/i);
  });

  it('resumes only by the stored exact native session id', () => {
    const args = buildCommandCodeArgs({
      executablePath: '/opt/bin/cmd',
      model: 'meta/muse-spark-1.2-contributor',
      maxTurns: 2,
      permissionProfile: 'implementation-child-wide',
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
