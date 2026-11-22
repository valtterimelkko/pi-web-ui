import { describe, it, expect, afterAll, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Lane B: past the background watch ceiling, a task is no longer "known
 * pending work".
 *
 * The watcher times a running task out at ANTIGRAVITY_BACKGROUND_WATCH_MAX_MS
 * (2 hours in production) rather than hanging the ChildrenStrip for ever. The
 * same ceiling bounds the stall deferral: once a task is outside it, the run
 * watchdog and the stream stall clock must apply again, or a tracked banner
 * could keep a dead turn alive indefinitely.
 *
 * A short ceiling is used here because the production value is two hours; the
 * ceiling is read from the environment at module load, so this file sets it
 * before importing the service. The watcher cadence is deliberately slower than
 * the test, so the task is still `running` in tracked state while the predicate
 * must already answer false: the ceiling is applied by the predicate itself, not
 * only as a side-effect of the watcher's timeout.
 */

const svcCtrl = vi.hoisted(() => {
  const sessionDir = `/tmp/agy-bg-ceiling-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const state = {
    sessionDir,
    registryPath: `${sessionDir}/registry.json`,
    scripted: '',
    writes: [] as string[],
  };
  process.env.ANTIGRAVITY_SESSION_DIR = sessionDir;
  // Watcher cadence longer than this test: the tracked task must stay 'running'.
  process.env.ANTIGRAVITY_BACKGROUND_WATCH_INTERVAL_MS = '10000';
  process.env.ANTIGRAVITY_BACKGROUND_WATCH_MAX_MS = '200';
  return state;
});

import { AntigravityService } from '../../../src/antigravity/antigravity-service.js';

const CONV = 'c-bg-ceiling';
const TASK = `${CONV}/task-92`;

const INIT = JSON.stringify({
  event: 'init',
  conversation_id: CONV,
  init: { cwd: '/tmp/bg-ceiling-test', tools: ['run_command'], permission_mode: 'always-proceed', model: 'gemini-3.8-flash-medium' },
});

function startStep(baseDir: string, index = 10): string {
  return JSON.stringify({
    event: 'step_update',
    step_update: {
      conversation_id: CONV, step_index: index, state: 'RUNNING', step_type: 'GENERIC',
      content:
        `Created At: 2026-11-22T01:08:15Z\n` +
        `Tool is running as a background task with task id: ${TASK}\n` +
        `Task Description: sleep 1800 && echo DONE\n` +
        `Task logs are available at: file://${baseDir}/.system_generated/tasks/task-92.log\n` +
        `YOU MUST TAKE ONE OF THE FOLLOWING TWO ACTIONS: A) either proceed to other relevant work...`,
    },
  });
}

function delta(text: string, state: 'ACTIVE' | 'DONE' = 'ACTIVE', index = 11): string {
  return JSON.stringify({
    event: 'step_update',
    step_update: { conversation_id: CONV, step_index: index, state, step_type: 'agent_response', text_delta: text },
  });
}

function resultLine(response = 'STARTED'): string {
  return JSON.stringify({
    event: 'result',
    result: {
      conversation_id: CONV, status: 'SUCCESS', response,
      duration_seconds: 6.2, num_turns: 1,
      usage: { input_tokens: 100, output_tokens: 10, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 110 },
    },
  });
}

function fakeSpawnChild(): EventEmitter {
  const child = new EventEmitter();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const stdin = new EventEmitter() as EventEmitter & { write: (s: string) => boolean; destroyed: boolean; end: () => void };
  stdin.destroyed = false;
  stdin.end = () => {};
  stdin.write = (s: string) => {
    svcCtrl.writes.push(s);
    if (stdout.listenerCount('data') > 0) stdout.emit('data', Buffer.from(svcCtrl.scripted));
    return true;
  };
  (child as unknown as { stdout: EventEmitter }).stdout = stdout;
  (child as unknown as { stderr: EventEmitter }).stderr = stderr;
  (child as unknown as { stdin: typeof stdin }).stdin = stdin;
  (child as unknown as { kill: () => void }).kill = vi.fn();
  return child;
}

describe('AntigravityService — watched task past the watch ceiling', () => {
  const watchDir = mkdtempSync(join(tmpdir(), 'agy-bg-ceiling-watch-'));

  afterAll(() => {
    rmSync(svcCtrl.sessionDir, { recursive: true, force: true });
    rmSync(watchDir, { recursive: true, force: true });
  });

  it('stops counting a task as pending work once the watch ceiling times it out', async () => {
    svcCtrl.writes = [];
    const service = new AntigravityService({
      registryPath: svcCtrl.registryPath,
      streamSpawnFn: (() => fakeSpawnChild()) as unknown as typeof import('node:child_process').spawn,
    });
    try {
      const { sessionId } = await service.createSession('/tmp/bg-ceiling-test', 'gemini-3.8-flash-medium');
      svcCtrl.scripted = [INIT, startStep(watchDir), delta('STARTED', 'DONE'), resultLine()].join('\n') + '\n';
      await new Promise<void>((resolve, reject) => {
        void service.sendPrompt(sessionId, 'run the long command', () => {}, (err) => {
          if (err) reject(err); else resolve();
        });
      });

      // Ceiling 200 ms, watcher cadence 10 s: the task stays 'running' in the
      // tracked map, yet it is outside the ceiling and can no longer hold a turn
      // alive.
      await vi.waitFor(() => {
        expect(service.hasRunningBackgroundTasks(sessionId)).toBe(false);
      }, { timeout: 10_000 });
      expect(service.getBackgroundChildren(sessionId)[0]?.status).toBe('running');
    } finally {
      await service.shutdown();
    }
  });
});
