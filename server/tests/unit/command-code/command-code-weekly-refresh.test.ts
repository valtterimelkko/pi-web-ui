import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: spawnMock };
});

import { runWeeklyRefresh, type WeeklyRefreshPaths } from '../../../../scripts/command-code-weekly-refresh.js';

interface ProcessResult {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  timedOut?: boolean;
}

interface Invocation {
  command: string;
  args: string[];
}

const KNOWN_MODEL = 'deepseek/deepseek-v4-pro';
const NEW_MODEL = 'newvendor/new-model';
const EXCLUDED_MODEL = 'claude-sonnet-5';
const CATALOGUE_SOURCE = [
  'export const COMMAND_CODE_EXCLUDED_MODELS = [',
  "  'existing/model',",
  '] as const;',
  '',
].join('\n');

let tempDir: string;
let cataloguePath: string;
let invocations: Invocation[];
let resolveProcess: (command: string, args: string[]) => ProcessResult;
let stagedPaths: string[];

function makeChild(result: ProcessResult) {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = vi.fn(() => true);
  queueMicrotask(() => {
    const stdout = child.stdout as PassThrough;
    const stderr = child.stderr as PassThrough;
    if (result.stdout) stdout.write(result.stdout);
    if (result.stderr) stderr.write(result.stderr);
    stdout.end();
    stderr.end();
    child.emit('close', result.exitCode ?? 0);
  });
  return child;
}

function modelList(...models: string[]): string {
  return ['Command Code CLI 1.50.0', ...models.map((model) => `${model}  available`), ''].join('\n');
}

function configureSpawn() {
  spawnMock.mockImplementation((command: string, args: string[]) => {
    invocations.push({ command, args: [...args] });
    return makeChild(resolveProcess(command, args));
  });
}

function defaultResolver(command: string, args: string[]): ProcessResult {
  if (command === '/tmp/mock-cmd') {
    if (args.includes('--list-models')) return { stdout: modelList(KNOWN_MODEL, NEW_MODEL) };
    return { stdout: '{"result":"ok"}' };
  }
  if (command === 'npm' || command === 'npx') return {};
  if (command === 'git') {
    if (args[0] === 'status') return {};
    if (args[0] === 'diff') return { stdout: stagedPaths.join('\n') };
    if (args[0] === 'add') {
      // The effort table is the only changed fixture in the default eligible
      // scenario; git add receives both exact catalogue pathspecs, but git's
      // index only reports the path with an actual diff.
      stagedPaths = ['efforts.ts'];
      return {};
    }
    return {};
  }
  if (command === '/tmp/weekly-refresh-notify') return {};
  if (command === 'systemctl') return {};
  throw new Error(`unexpected child process: ${command} ${args.join(' ')}`);
}

function testPaths(): WeeklyRefreshPaths {
  return {
    repoRoot: tempDir,
    executablePath: '/tmp/mock-cmd',
    cataloguePath,
    notify: '/tmp/weekly-refresh-notify',
    effortTableRel: 'efforts.ts',
    catalogueRel: 'catalogue.ts',
  };
}

function options(overrides: Partial<Parameters<typeof runWeeklyRefresh>[1]> = {}) {
  return {
    paths: testPaths(),
    createInternalApiClient: () => ({ getCapacity: vi.fn().mockResolvedValue({ activeTurns: 0, stalledRuns: 0 }) }),
    sleep: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'weekly-refresh-test-'));
  cataloguePath = path.join(tempDir, 'catalogue.ts');
  await writeFile(cataloguePath, CATALOGUE_SOURCE, 'utf8');
  invocations = [];
  stagedPaths = [];
  resolveProcess = defaultResolver;
  configureSpawn();
});

afterEach(async () => {
  spawnMock.mockReset();
  await rm(tempDir, { recursive: true, force: true });
});

describe('runWeeklyRefresh', () => {
  it('reports and refuses a dirty working tree even when no advertised model is unseen', async () => {
    resolveProcess = (command, args) => {
      if (command === '/tmp/mock-cmd' && args.includes('--list-models')) return { stdout: modelList(KNOWN_MODEL) };
      if (command === 'git' && args[0] === 'status') return { stdout: ' M unrelated.txt\n' };
      return defaultResolver(command, args);
    };

    await expect(runWeeklyRefresh([], options())).rejects.toThrow(/working tree is not clean.*unrelated\.txt/);
    expect(invocations.some(({ command, args }) => command === '/tmp/mock-cmd' && args.includes('--model'))).toBe(false);
    expect(invocations.some(({ command, args }) => command === 'git' && args[0] === 'add')).toBe(false);
    expect(invocations.some(({ command }) => command === 'systemctl')).toBe(false);
  });

  it('stages only the two intended catalogue artefacts before committing', async () => {
    const result = await runWeeklyRefresh(['--no-restart'], options());

    expect(result.committed).toBe(true);
    expect(invocations.filter(({ command }) => command === 'git').map(({ args }) => args[0])).toEqual([
      'status', 'diff', 'add', 'diff', 'commit', 'push',
    ]);
    expect(invocations.find(({ command, args }) => command === 'git' && args[0] === 'add')?.args).toEqual([
      'add', '--', 'efforts.ts', 'catalogue.ts',
    ]);
    expect(stagedPaths).toEqual(['efforts.ts']);
    expect(invocations.some(({ command, args }) => command === 'git' && args.includes('unrelated.txt'))).toBe(false);
  });

  it.each([
    ['typecheck', 'server typecheck failed'],
    ['tests', 'command-code unit tests failed'],
    ['build', 'server build failed'],
  ] as const)('does not commit or restart when the %s gate fails', async (failedGate, errorText) => {
    resolveProcess = (command, args) => {
      if (failedGate === 'typecheck' && command === 'npm' && args.includes('typecheck')) return { exitCode: 1, stderr: 'typecheck failed' };
      if (failedGate === 'tests' && command === 'npx') return { exitCode: 1, stdout: 'tests failed' };
      if (failedGate === 'build' && command === 'npm' && args.includes('build')) return { exitCode: 1, stderr: 'build failed' };
      return defaultResolver(command, args);
    };

    await expect(runWeeklyRefresh([], options())).rejects.toThrow(errorText);
    expect(invocations.some(({ command, args }) => command === 'git' && ['add', 'commit', 'push'].includes(args[0]))).toBe(false);
    expect(invocations.some(({ command }) => command === 'systemctl')).toBe(false);
  });

  it('performs no file, git, restart, or notification action in dry-run mode', async () => {
    const before = await readFile(cataloguePath, 'utf8');
    const result = await runWeeklyRefresh(['--dry-run'], options());

    expect(result.dryRun).toBe(true);
    expect(await readFile(cataloguePath, 'utf8')).toBe(before);
    expect(invocations.some(({ command }) => command === 'npm' || command === 'npx')).toBe(false);
    expect(invocations.some(({ command }) => command === 'git')).toBe(false);
    expect(invocations.some(({ command }) => command === 'systemctl')).toBe(false);
    expect(invocations.some(({ command }) => command === '/tmp/weekly-refresh-notify')).toBe(false);
  });

  it('does not send a failure notification for a dry-run discovery error', async () => {
    resolveProcess = (command, args) => {
      if (command === '/tmp/mock-cmd' && args.includes('--list-models')) return { exitCode: 1, stderr: 'discovery failed' };
      return defaultResolver(command, args);
    };

    await expect(runWeeklyRefresh(['--dry-run'], options())).rejects.toThrow('cmd --list-models failed');
    expect(invocations.some(({ command }) => command === '/tmp/weekly-refresh-notify')).toBe(false);
  });

  it('uses a known non-excluded model as the eligibility control probe', async () => {
    const probedModels: string[] = [];
    resolveProcess = (command, args) => {
      if (command === '/tmp/mock-cmd' && args.includes('--list-models')) {
        return { stdout: modelList(EXCLUDED_MODEL, KNOWN_MODEL, NEW_MODEL) };
      }
      if (command === '/tmp/mock-cmd' && args.includes('--model')) {
        probedModels.push(args[args.indexOf('--model') + 1]);
        if (args.includes(EXCLUDED_MODEL)) return { exitCode: 1, stderr: 'not included in your current plan' };
        return { stdout: '{"result":"ok"}' };
      }
      return defaultResolver(command, args);
    };

    const result = await runWeeklyRefresh(['--no-git', '--no-restart'], options());

    expect(result.inconclusive).toEqual([]);
    expect(probedModels).toEqual([KNOWN_MODEL, NEW_MODEL]);
  });

  it('fails when the idle restart command fails instead of returning success', async () => {
    resolveProcess = (command, args) => {
      if (command === 'systemctl') return { exitCode: 1, stderr: 'restart failed' };
      return defaultResolver(command, args);
    };

    await expect(runWeeklyRefresh([], options())).rejects.toThrow(/restart failed/);
    expect(invocations.some(({ command, args }) => command === 'git' && args[0] === 'push')).toBe(true);
  });
});
