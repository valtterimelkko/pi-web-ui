import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCommandCodeArgs } from '../../../src/command-code/command-code-config.js';
import { CommandCodeService } from '../../../src/command-code/command-code-service.js';
import {
  parseCommandCodeModelList,
} from '../../../src/command-code/command-code-model-catalog.js';
import { ADVERTISED_IDS, COMMAND_CODE_EXCLUDED_IDS } from './command-code-fixture.js';

function listModelsFixture(ids: readonly string[]): string {
  return ['Available models', '', ...ids.map((id) => `${id}  advertised model`)].join('\n');
}

async function buildService(models: readonly string[]): Promise<{ service: CommandCodeService; cwd: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'command-code-catalogue-'));
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'command-code-catalogue-cwd-'));
  const service = new CommandCodeService({
    config: { enabled: true, executablePath: '/opt/bin/cmd', stateDir: root, allowedCwdRoots: [cwd] },
    discover: async () => ({ version: '1.23.2', models: [...models], ambiguous: [] }),
    checkExecutable: false,
  });
  await service.init();
  return { service, cwd };
}

describe('Command Code catalogue — denylist, fails open', () => {
  it('parses the 54 advertised ids from a --list-models fixture', () => {
    const parsed = parseCommandCodeModelList(listModelsFixture(ADVERTISED_IDS));
    expect(parsed.models).toHaveLength(54);
    expect(parsed.ambiguous).toEqual([]);
  });

  it('lists exactly the 35 GOAT-eligible models and none of the 19 excluded ids', async () => {
    const { service } = await buildService(ADVERTISED_IDS);
    const models = service.getModels();
    expect(models).toHaveLength(35);
    for (const excluded of COMMAND_CODE_EXCLUDED_IDS) {
      expect(models.map((model) => model.id)).not.toContain(excluded);
    }
    // Eligible premium-adjacent ids the plan explicitly protects.
    for (const eligible of ['gpt-5.6-luna', 'google/gemini-3.7-flash', 'meta/muse-spark-1.2', 'meta/muse-spark-1.2-contributor', 'xai/grok-4.5', 'xai/grok-4.6']) {
      expect(models.map((model) => model.id)).toContain(eligible);
    }
    // The projection carries only the six surviving fields.
    for (const model of models) {
      expect((model as Record<string, unknown>).runnable).toBeUndefined();
      expect((model as Record<string, unknown>).status).toBeUndefined();
      expect((model as Record<string, unknown>).browserRunnable).toBeUndefined();
      expect((model as Record<string, unknown>).supportsEffort).toBeUndefined();
      expect((model as Record<string, unknown>).effortCapabilityHash).toBeUndefined();
      expect((model as Record<string, unknown>).catalogue).toBeUndefined();
      expect(Array.isArray(model.effortLevels)).toBe(true);
      expect(model.provider).toBe('command-code');
    }
  });

  it('an unknown advertised id appears (fails open) and does not change isAvailable()', async () => {
    const { service: before } = await buildService(ADVERTISED_IDS);
    expect(before.isAvailable()).toBe(true);
    const { service: after } = await buildService([...ADVERTISED_IDS, 'unknown/new-model']);
    expect(after.isAvailable()).toBe(true);
    const ids = after.getModels().map((model) => model.id);
    expect(ids).toHaveLength(36);
    expect(ids).toContain('unknown/new-model');
    // A model absent from the effort table is still fully listed with no selector.
    const unknown = after.getModels().find((model) => model.id === 'unknown/new-model')!;
    expect(unknown.effortLevels).toEqual([]);
    expect((unknown as Record<string, unknown>).defaultEffort).toBeUndefined();
  });

  it('a missing advertised id does not make the runtime unavailable', async () => {
    const reduced = ADVERTISED_IDS.filter((id) => id !== 'thinkingmachines/inkling');
    const { service } = await buildService(reduced);
    expect(service.isAvailable()).toBe(true);
    expect(service.getModels()).toHaveLength(34);
  });

  it('the CLI version is reported, never a gate', async () => {
    const { service } = await buildService(ADVERTISED_IDS);
    const health = service.getHealth();
    expect(service.isAvailable()).toBe(true);
    expect(health.version).toBe('1.23.2');
  });
});

describe('Command Code effort table', () => {
  it('serves a listed model with exactly its committed effort levels and default', async () => {
    const { service } = await buildService(ADVERTISED_IDS);
    const qwen = service.getModels().find((model) => model.id === 'qwen/qwen3.8-max')!;
    expect(qwen.effortLevels).toEqual(['low', 'medium', 'xhigh']);
    expect((qwen as Record<string, unknown>).defaultEffort).toBe('medium');
  });

  it('rejects an effort outside the model\'s levels before spawn', () => {
    expect(() => buildCommandCodeArgs({
      executablePath: '/opt/bin/cmd', model: 'qwen/qwen3.8-max', maxTurns: 8, effort: 'max',
    })).toThrow(/effort/i);
    // A model absent from the table has no selector: any explicit effort is rejected.
    expect(() => buildCommandCodeArgs({
      executablePath: '/opt/bin/cmd', model: 'unknown/new-model', maxTurns: 8, effort: 'low',
    })).toThrow(/effort/i);
    // A valid effort for a model with a selector is accepted.
    expect(buildCommandCodeArgs({
      executablePath: '/opt/bin/cmd', model: 'qwen/qwen3.8-max', maxTurns: 8, effort: 'xhigh',
    })).toContain('xhigh');
  });

  it('creates a session for a model absent from the effort table without --effort', async () => {
    const { service, cwd } = await buildService([...ADVERTISED_IDS, 'unknown/new-model']);
    const session = await service.createSession({ cwd, model: 'unknown/new-model' });
    expect(session.modelSelector).toBe('unknown/new-model');
    expect((session as Record<string, unknown>).effort).toBeUndefined();
  });
});
