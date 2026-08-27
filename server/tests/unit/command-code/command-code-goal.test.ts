/**
 * Cross-runtime goal function (contract 1.27.0) — Command Code pieces:
 * goal-control store + goal-armed argv extension.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildCommandCodeArgs } from '../../../src/command-code/command-code-config.js';
import { CommandCodeGoalStore } from '../../../src/command-code/command-code-goal-store.js';

describe('CommandCodeGoalStore', () => {
  let dir: string;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cmdc-goal-store-')); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it('round-trips an armed goal record and patches honestly', async () => {
    const store = new CommandCodeGoalStore(dir);
    await store.arm('s1', {
      objective: 'make the thing',
      maxTurns: 12,
      verifier: 'command',
      verifyCommand: 'test -f thing',
      modelVerifier: '',
      autoContinue: true,
    });
    const rec = await store.get('s1');
    expect(rec?.objective).toBe('make the thing');
    expect(rec?.status).toBe('running');
    await store.patch('s1', { status: 'paused', pausedReason: 'user' });
    expect((await store.get('s1'))?.status).toBe('paused');
  });

  it('get returns null when never armed', async () => {
    expect(await new CommandCodeGoalStore(dir).get('ghost')).toBeNull();
  });
});

describe('buildCommandCodeArgs — goal arming (server-owned argv exception)', () => {
  const base = {
    executablePath: '/usr/bin/cmd',
    model: 'meta/muse-spark-1.2-contributor',
    maxTurns: 40,
  };

  it('keeps argv byte-identical when no goal is armed', () => {
    const without = buildCommandCodeArgs(base);
    const explicit = buildCommandCodeArgs({ ...base, goal: undefined });
    expect(explicit).toEqual(without);
  });

  it('appends --mod and --mod-option set when a goal is armed', () => {
    const args = buildCommandCodeArgs({
      ...base,
      goal: {
        modPath: '/srv/mods/goal-runner.ts',
        options: [
          ['goal.objective', 'make the thing'],
          ['goal.maxTurns', '20'],
          ['goal.verifyCommand', 'test -f thing'],
        ],
      },
    });
    const modIndex = args.indexOf('--mod');
    expect(modIndex).toBeGreaterThan(0);
    expect(args[modIndex + 1]).toBe('/srv/mods/goal-runner.ts');
    expect(args.filter((a) => a === '--mod-option')).toHaveLength(3);
    expect(args).toContain('goal.objective=make the thing');
    // The fixed policy args stay untouched and precede the feature-gated tail.
    expect(args.slice(0, 2)).toEqual(['-p', '--output-format']);
    expect(args.at(-2)).toBe('--mod-option');
  });
});
