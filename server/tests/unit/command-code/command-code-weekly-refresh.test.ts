import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: spawnMock };
});

import {
  runWeeklyRefresh,
  runProcess,
  RESTART_DRAIN_BUDGET_SECONDS,
  RESTART_DRAIN_HTTP_SLACK_SECONDS,
  RESTART_JOB_BUDGET_MS,
  RESTART_JOB_BUDGET_SECONDS,
  RESTART_START_MARGIN_SECONDS,
  UNIT_STOP_TIMEOUT_SECONDS,
  type ProcessRunner,
  type WeeklyRefreshPaths,
} from '../../../../scripts/command-code-weekly-refresh.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

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
const RESTART_SCRIPT = '/tmp/restart-pi-web-ui';
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
  if (command === RESTART_SCRIPT) return {};
  throw new Error(`unexpected child process: ${command} ${args.join(' ')}`);
}

function testPaths(): WeeklyRefreshPaths {
  return {
    repoRoot: tempDir,
    executablePath: '/tmp/mock-cmd',
    cataloguePath,
    notify: '/tmp/weekly-refresh-notify',
    restartScript: RESTART_SCRIPT,
    effortTableRel: 'efforts.ts',
    catalogueRel: 'catalogue.ts',
  };
}

function options(overrides: Partial<Parameters<typeof runWeeklyRefresh>[1]> = {}) {
  return {
    paths: testPaths(),
    createInternalApiClient: () => ({ listSessions: vi.fn().mockResolvedValue({ sessions: [] }) }),
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
    expect(invocations.some(({ command }) => command === RESTART_SCRIPT)).toBe(false);
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
    expect(invocations.some(({ command }) => command === RESTART_SCRIPT)).toBe(false);
  });

  it('performs no file, git, restart, or notification action in dry-run mode', async () => {
    const before = await readFile(cataloguePath, 'utf8');
    const result = await runWeeklyRefresh(['--dry-run'], options());

    expect(result.dryRun).toBe(true);
    expect(await readFile(cataloguePath, 'utf8')).toBe(before);
    expect(invocations.some(({ command }) => command === 'npm' || command === 'npx')).toBe(false);
    expect(invocations.some(({ command }) => command === 'git')).toBe(false);
    expect(invocations.some(({ command }) => command === RESTART_SCRIPT)).toBe(false);
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
      if (command === RESTART_SCRIPT) return { exitCode: 1, stderr: 'restart failed' };
      return defaultResolver(command, args);
    };

    await expect(runWeeklyRefresh([], options())).rejects.toThrow(/restart failed/);
    expect(invocations.some(({ command, args }) => command === 'git' && args[0] === 'push')).toBe(true);
  });

  describe('idle decision from live busy sessions', () => {
    // The fake mirrors InternalApiClient.listSessions(): the restart decision
    // reads the live sessions response and counts busy === true entries.
    function sessionsClient(response: { sessions?: unknown } | Error) {
      const listSessions = response instanceof Error
        ? vi.fn().mockRejectedValue(response)
        : vi.fn().mockResolvedValue(response);
      return { listSessions, createInternalApiClient: () => ({ listSessions }) };
    }

    // Drives the wait loop to exit after its first busy poll regardless of
    // the real wait window: first tick computes the deadline, second enters
    // the loop, then time jumps past any deadline.
    function singlePollNow() {
      const ticks = [0, 0];
      return vi.fn(() => (ticks.length > 0 ? (ticks.shift() as number) : Number.POSITIVE_INFINITY));
    }

    it('defers the restart while any live session reports busy', async () => {
      const client = sessionsClient({ sessions: [{ sessionId: 's1', busy: true }, { sessionId: 's2', busy: false }] });

      const result = await runWeeklyRefresh([], options({ ...client, now: singlePollNow() }));

      expect(result.restarted).toBe(false);
      expect(client.listSessions).toHaveBeenCalledTimes(1);
      expect(invocations.some(({ command }) => command === RESTART_SCRIPT)).toBe(false);
    });

    it('restarts through restart-pi-web-ui.sh with the named reason when every live session is idle', async () => {
      const client = sessionsClient({ sessions: [{ sessionId: 's1', busy: false }] });

      const result = await runWeeklyRefresh([], options(client));

      expect(result.restarted).toBe(true);
      const restarts = invocations.filter(({ command }) => command === '/tmp/restart-pi-web-ui');
      expect(restarts).toHaveLength(1);
      expect(restarts[0]?.args).toEqual(['--reason', 'weekly command-code catalogue refresh']);
      expect(invocations.some(({ command }) => command === 'systemctl')).toBe(false);
    });

    it('defers the restart when the live sessions probe throws', async () => {
      const client = sessionsClient(new Error('sessions probe failed'));

      const result = await runWeeklyRefresh([], options(client));

      expect(result.restarted).toBe(false);
      expect(client.listSessions).toHaveBeenCalledTimes(1);
      expect(invocations.some(({ command }) => command === RESTART_SCRIPT)).toBe(false);
    });

    it('defers the restart when one busy session sits among idle ones', async () => {
      const client = sessionsClient({ sessions: [{ busy: false }, { busy: true }, { busy: false }] });

      const result = await runWeeklyRefresh([], options({ ...client, now: singlePollNow() }));

      expect(result.restarted).toBe(false);
      expect(client.listSessions).toHaveBeenCalledTimes(1);
      expect(invocations.some(({ command }) => command === RESTART_SCRIPT)).toBe(false);
    });

    it('defers the restart when the sessions response is malformed', async () => {
      const client = sessionsClient({ sessions: 'not-an-array' });

      const result = await runWeeklyRefresh([], options(client));

      expect(result.restarted).toBe(false);
      expect(client.listSessions).toHaveBeenCalledTimes(1);
      expect(invocations.some(({ command }) => command === RESTART_SCRIPT)).toBe(false);
    });

    // scripts/restart-pi-web-ui.sh carries its own capacity pre-flight: while
    // the Internal API reports admitted child turns it refuses with exit 1 and
    // the "refusing restart" message. By the time that wrapper runs, this job
    // has already committed the catalogue, so the honest reading of a refusal
    // is the same deferral as the busy-session branch above — the changes go
    // live at the next restart. Throwing here would report a successful
    // refresh as a failed one.
    it('treats a wrapper capacity refusal as a deferral, not a failed run', async () => {
      const client = sessionsClient({ sessions: [{ sessionId: 's1', busy: false }] });
      resolveProcess = (command, args) => {
        if (command === RESTART_SCRIPT) {
          return {
            exitCode: 1,
            stderr: 'restart-pi-web-ui: refusing restart: 2 active child turn(s) in progress. Wait for children to settle or pass --force.',
          };
        }
        return defaultResolver(command, args);
      };

      const result = await runWeeklyRefresh([], options(client));

      expect(result.restarted).toBe(false);
      // The run still completed its work: the catalogue was pushed.
      expect(invocations.some(({ command, args }) => command === 'git' && args[0] === 'push')).toBe(true);
    });

    // Only the wrapper's documented refusal is a deferral. Any other restart
    // failure is a real problem and must keep failing loudly.
    it('still fails the run when the restart command fails for another reason', async () => {
      const client = sessionsClient({ sessions: [{ sessionId: 's1', busy: false }] });
      resolveProcess = (command, args) => {
        if (command === RESTART_SCRIPT) return { exitCode: 1, stderr: 'Failed to restart pi-web-ui.service: Unit not found.' };
        return defaultResolver(command, args);
      };

      await expect(runWeeklyRefresh([], options(client))).rejects.toThrow(/restart failed/);
    });
  });

  // The weekly refresh restart budget (plan §6 small item, the B4 residual):
  // restart-pi-web-ui.sh can spend drain + HTTP slack deciding, and then
  // `systemctl restart` blocks for the unit's stop and the start. The flat
  // 60 s call timeout could fire inside the stop and fail an otherwise
  // committed refresh with an uncertain restart state. These tests pin the
  // budget arithmetic AND each of its parts to the file they come from, so
  // drift in any of them fails here instead of silently outliving the job.
  describe('restart job budget', () => {
    function readRepoFile(relativePath: string): Promise<string> {
      return readFile(path.join(REPO_ROOT, relativePath), 'utf8');
    }

    it('derives the budget from drain + slack + unit stop, plus a start margin, and is strictly above the pre-restart decision time', () => {
      expect(RESTART_JOB_BUDGET_SECONDS).toBe(
        RESTART_DRAIN_BUDGET_SECONDS + RESTART_DRAIN_HTTP_SLACK_SECONDS + UNIT_STOP_TIMEOUT_SECONDS + RESTART_START_MARGIN_SECONDS,
      );
      // Strictly above: the call also has to cover the restart itself (the
      // unit's stop and start), which is exactly what the old flat 60 s —
      // equal to drain + slack + stop — could not.
      expect(RESTART_JOB_BUDGET_SECONDS).toBeGreaterThan(
        RESTART_DRAIN_BUDGET_SECONDS + RESTART_DRAIN_HTTP_SLACK_SECONDS + UNIT_STOP_TIMEOUT_SECONDS,
      );
      expect(RESTART_JOB_BUDGET_MS).toBe(RESTART_JOB_BUDGET_SECONDS * 1000);
    });

    it("pins the drain and slack parts to the wrapper's job defaults", async () => {
      const script = await readRepoFile('scripts/restart-pi-web-ui.sh');
      const drain = script.match(/PI_WEB_UI_JOB_DRAIN_TIMEOUT_SECONDS:-([0-9]+)/);
      const slack = script.match(/PI_WEB_UI_DRAIN_HTTP_SLACK_SECONDS:-([0-9]+)/);
      expect(drain).not.toBeNull();
      expect(slack).not.toBeNull();
      expect(RESTART_DRAIN_BUDGET_SECONDS).toBe(Number(drain?.[1]));
      expect(RESTART_DRAIN_HTTP_SLACK_SECONDS).toBe(Number(slack?.[1]));
    });

    it("pins the stop part to the unit's configured TimeoutStopSec", async () => {
      const unit = await readRepoFile('deploy/systemd/pi-web-ui.service');
      const stop = unit.match(/^TimeoutStopSec=([0-9]+)$/m);
      expect(stop).not.toBeNull();
      expect(UNIT_STOP_TIMEOUT_SECONDS).toBe(Number(stop?.[1]));
    });

    it('runs the restart script within the derived budget, not the old flat 60 s', async () => {
      const restartCalls: Array<{ command: string; timeoutMs: number }> = [];
      const recordingRunner: ProcessRunner = async (command, args, runOptions) => {
        if (command === RESTART_SCRIPT) restartCalls.push({ command, timeoutMs: runOptions.timeoutMs });
        return runProcess(command, args, runOptions);
      };

      const result = await runWeeklyRefresh([], options({ processRunner: recordingRunner }));

      expect(result.restarted).toBe(true);
      expect(restartCalls).toHaveLength(1);
      expect(restartCalls[0]?.timeoutMs).toBe(RESTART_JOB_BUDGET_MS);
      expect(restartCalls[0]?.timeoutMs).toBeGreaterThan(
        (RESTART_DRAIN_BUDGET_SECONDS + RESTART_DRAIN_HTTP_SLACK_SECONDS + UNIT_STOP_TIMEOUT_SECONDS) * 1000,
      );
    });
  });

  // J1 (plan §6): the restart guard judges built content, not HEAD, and guard
  // refusals get their own wrapper exit status and message. The job must
  // report a guard refusal as the hard failure it is (the catalogue was
  // already committed and the changes are NOT live), never as a capacity
  // deferral — that misreading is exactly the J1 defect.
  describe('restart guard classification (J1)', () => {
    const GUARD_REFUSAL_STDERR =
      'restart-pi-web-ui: refusing restart (production checkout guard): the production checkout did not pass its safety guard (detail above); nothing was restarted.';

    it('fails the run naming the checkout guard when the wrapper refuses on the guard', async () => {
      resolveProcess = (command, args) => {
        if (command === RESTART_SCRIPT) return { exitCode: 3, stderr: GUARD_REFUSAL_STDERR };
        return defaultResolver(command, args);
      };

      await expect(runWeeklyRefresh([], options())).rejects.toThrow(/^pi-web-ui restart refused by the production checkout guard/);
      // The catalogue was committed and pushed before the refused restart.
      expect(invocations.some(({ command, args }) => command === 'git' && args[0] === 'push')).toBe(true);
    });

    it('still defers (the capacity reading) on the wrapper drain refusal: exit 1 with the drain wording', async () => {
      resolveProcess = (command, args) => {
        if (command === RESTART_SCRIPT) {
          return {
            exitCode: 1,
            stderr: 'restart-pi-web-ui: refusing restart: the drain did not settle within 20s or the Internal API state could not be confirmed (details above); nothing was restarted.',
          };
        }
        return defaultResolver(command, args);
      };

      const result = await runWeeklyRefresh([], options());
      expect(result.restarted).toBe(false);
    });

    it('pins the guard marker and exit status to the wrapper sources the job classifies', async () => {
      const wrapper = await readFile(path.join(REPO_ROOT, 'scripts', 'restart-pi-web-ui.sh'), 'utf8');
      expect(wrapper).toContain('refusing restart (production checkout guard)');
      expect(wrapper).toMatch(/status == 3/);
      const canonical = await readFile(path.join(REPO_ROOT, 'scripts', 'restart-production.sh'), 'utf8');
      expect(canonical).toContain('Refusing production restart (checkout guard)');
      expect(canonical).toMatch(/exit 3/);
    });

    it('rebuilds the server after committing so the build identity names the committed revision', async () => {
      const result = await runWeeklyRefresh([], options());

      expect(result.committed).toBe(true);
      const pushIndex = invocations.findIndex(({ command, args }) => command === 'git' && args[0] === 'push');
      expect(pushIndex).toBeGreaterThan(-1);
      const rebuildAfterPush = invocations
        .slice(pushIndex + 1)
        .some(({ command, args }) => command === 'npm' && args[0] === 'run' && args.includes('build'));
      expect(rebuildAfterPush, 'expected a server build invocation after git push (the guard reads that build identity)').toBe(true);
    });
  });
});
