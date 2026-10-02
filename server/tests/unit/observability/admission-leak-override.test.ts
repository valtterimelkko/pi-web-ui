import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createValidationLeakOverride } from '../../../src/observability/admission-leak-override.js';
import type { AdmissionCountsReading } from '../../../src/observability/health-readings.js';

const dirs: string[] = [];

async function tempDir(name: string): Promise<string> {
  const dir = path.join(tmpdir(), `${name}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(dir, { recursive: true });
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const counts: AdmissionCountsReading = {
  activeTurns: 0,
  classes: { P0: { active: 0 }, P1: { active: 0 }, P2: { active: 0 }, P3: { active: 0 } },
  runtimes: { pi: { activeTurns: 0 }, claude: { activeTurns: 0 }, opencode: { activeTurns: 0 }, antigravity: { activeTurns: 0 }, commandcode: { activeTurns: 0 } },
};

/** A validation layout that passes every identity gate, like the disposable server child writes. */
async function validLayout(): Promise<{ env: Record<string, string>; recordDir: string; leakFile: string }> {
  const recordDir = await tempDir('j3-leak-record');
  const leakFile = path.join(recordDir, 'leak.json');
  await writeFile(path.join(recordDir, 'server-process.json'), JSON.stringify({ pid: process.pid, validationDir: recordDir }));
  return {
    recordDir,
    leakFile,
    env: {
      INTERNAL_API_ADMISSION_TEST_LEAK_FILE: leakFile,
      PI_WEB_UI_VALIDATION_MODE: 'true',
      PI_WEB_UI_VALIDATION_SERVER_CHILD: '1',
      PI_WEB_UI_VALIDATION_RECORD_DIR: recordDir,
      INTERNAL_API_SOCKET_PATH: path.join(recordDir, 'api.sock'),
    },
  };
}

describe('createValidationLeakOverride (J3 validation-only leak injection)', () => {
  it('is undefined when no leak file is named', () => {
    expect(createValidationLeakOverride({} as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it('refuses when the process is not a validation server child', () => {
    const refusals: string[] = [];
    const override = createValidationLeakOverride(
      { INTERNAL_API_ADMISSION_TEST_LEAK_FILE: '/tmp/leak.json' } as NodeJS.ProcessEnv,
      { onRefused: (reason) => refusals.push(reason) },
    );
    expect(override).toBeUndefined();
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain('validation');
  });

  it('refuses when the identity record does not belong to this process', async () => {
    const { env, recordDir } = await validLayout();
    await writeFile(path.join(recordDir, 'server-process.json'), JSON.stringify({ pid: process.pid + 999, validationDir: recordDir }));
    const refusals: string[] = [];
    expect(createValidationLeakOverride(env as NodeJS.ProcessEnv, { onRefused: (reason) => refusals.push(reason) })).toBeUndefined();
    expect(refusals[0]).toContain('identity');
  });

  it('refuses when the record dir is or contains the production state root', async () => {
    const { env } = await validLayout();
    const refusals: string[] = [];
    const productionRoot = path.join(tmpdir(), 'j3-fake-production');
    await mkdir(productionRoot, { recursive: true });
    dirs.push(productionRoot);
    const override = createValidationLeakOverride(
      { ...env, PI_WEB_UI_VALIDATION_RECORD_DIR: tmpdir() } as NodeJS.ProcessEnv,
      { productionStateRoot: productionRoot, onRefused: (reason) => refusals.push(reason) },
    );
    expect(override).toBeUndefined();
    expect(refusals[0]).toContain('production state root');
  });

  it('applies a phantom P2 permit to the counts a valid validation server samples, re-reading the file each call', async () => {
    const { env, leakFile } = await validLayout();
    const override = createValidationLeakOverride(env as NodeJS.ProcessEnv);
    expect(override).toBeDefined();
    await writeFile(leakFile, JSON.stringify({ leakActiveTurns: 1 }));

    const leaked = override!.apply(counts);
    expect(leaked.activeTurns).toBe(1);
    expect(leaked.classes.P2.active).toBe(1);
    expect(leaked.classes.P0.active).toBe(0);
    // The input is never mutated.
    expect(counts.activeTurns).toBe(0);

    // Re-read every call: raising and clearing needs no restart.
    await writeFile(leakFile, JSON.stringify({ leakActiveTurns: 2 }));
    expect(override!.apply(counts).activeTurns).toBe(2);
    await rm(leakFile);
    expect(override!.apply(counts)).toEqual(counts);
  });

  it('honours an explicit class and runtime for the phantom permit and ignores junk', async () => {
    const { env, leakFile } = await validLayout();
    const override = createValidationLeakOverride(env as NodeJS.ProcessEnv)!;
    await writeFile(leakFile, JSON.stringify({ leakActiveTurns: 1, leakClass: 'P3', leakRuntime: 'claude' }));
    const leaked = override.apply(counts);
    expect(leaked.activeTurns).toBe(1);
    expect(leaked.classes.P3.active).toBe(1);
    expect(leaked.runtimes?.claude.activeTurns).toBe(1);
    expect(leaked.classes.P2.active).toBe(0);

    await writeFile(leakFile, JSON.stringify({ leakActiveTurns: 'many', leakClass: 'P9' }));
    expect(override.apply(counts)).toEqual(counts);
  });
});
