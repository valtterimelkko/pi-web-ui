import { describe, it, expect, afterAll, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Lane B: the antigravity service's own answer to "is this session still doing
 * work we know about?".
 *
 * The run watchdog and the stream stall clock may only defer while the service
 * tracks a background task that is genuinely RUNNING and still inside the
 * background watch ceiling. A completed task, a timed-out one, a session with
 * no tasks and an unknown session are all "no pending work", so neither clock
 * is ever deferred on a stale banner.
 */

const svcCtrl = vi.hoisted(() => {
  const sessionDir = `/tmp/agy-bg-pending-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const state = {
    sessionDir,
    registryPath: `${sessionDir}/registry.json`,
    scripted: '',
    writes: [] as string[],
  };
  process.env.ANTIGRAVITY_SESSION_DIR = sessionDir;
  // Fast receipt polling; the default 2-hour watch ceiling stays in force here.
  process.env.ANTIGRAVITY_BACKGROUND_WATCH_INTERVAL_MS = '50';
  return state;
});

import { AntigravityService } from '../../../src/antigravity/antigravity-service.js';

const CONV = 'c-bg-pending';
const TASK = `${CONV}/task-91`;

const INIT = JSON.stringify({
  event: 'init',
  conversation_id: CONV,
  init: { cwd: '/tmp/bg-pending-test', tools: ['run_command'], permission_mode: 'always-proceed', model: 'gemini-3.8-flash-medium' },
});

function startContent(taskId: string, command: string, baseDir: string): string {
  return (
    `Created At: 2026-11-22T01:08:15Z\n` +
    `Tool is running as a background task with task id: ${taskId}\n` +
    `Task Description: ${command}\n` +
    `Task logs are available at: file://${baseDir}/.system_generated/tasks/task-91.log\n` +
    `YOU MUST TAKE ONE OF THE FOLLOWING TWO ACTIONS: A) either proceed to other relevant work...`
  );
}

function startStep(baseDir: string, index = 10): string {
  return JSON.stringify({
    event: 'step_update',
    step_update: {
      conversation_id: CONV, step_index: index, state: 'RUNNING', step_type: 'GENERIC',
      content: startContent(TASK, 'sleep 1800 && echo DONE', baseDir),
    },
  });
}

function completionStep(index = 40): string {
  return JSON.stringify({
    event: 'step_update',
    step_update: {
      conversation_id: CONV, step_index: index, state: 'DONE', step_type: 'system_message',
      content: `Task id "${TASK}" finished with result:\n\nThe command exited with code 0.\nOutput:\nDONE`,
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

async function runTurn(service: AntigravityService, sessionId: string, scripted: string): Promise<void> {
  svcCtrl.scripted = scripted;
  await new Promise<void>((resolve, reject) => {
    void service.sendPrompt(sessionId, 'run the long command', () => {}, (err) => {
      if (err) reject(err); else resolve();
    });
  });
}

describe('AntigravityService — hasRunningBackgroundTasks', () => {
  const watchDir = mkdtempSync(join(tmpdir(), 'agy-bg-pending-watch-'));

  afterAll(() => {
    rmSync(svcCtrl.sessionDir, { recursive: true, force: true });
    rmSync(watchDir, { recursive: true, force: true });
  });

  function makeService(child: EventEmitter): AntigravityService {
    svcCtrl.writes = [];
    return new AntigravityService({
      registryPath: svcCtrl.registryPath,
      streamSpawnFn: (() => child) as unknown as typeof import('node:child_process').spawn,
    });
  }

  it('is true while a tracked task is running and false once the completion notice arrives', async () => {
    const child = fakeSpawnChild();
    const service = makeService(child);
    try {
      const { sessionId } = await service.createSession('/tmp/bg-pending-test', 'gemini-3.8-flash-medium');

      // Turn 1: agy announces the background task and answers STARTED.
      await runTurn(
        service,
        sessionId,
        [INIT, startStep(watchDir), delta('STARTED', 'DONE'), resultLine()].join('\n') + '\n',
      );

      // The turn ended but the task is still running: this is exactly the
      // window in which both stall clocks must leave the turn alone.
      expect(service.getBackgroundChildren(sessionId)[0]?.status).toBe('running');
      expect(service.hasRunningBackgroundTasks(sessionId)).toBe(true);

      // Turn 2: the completion notice arrives in-stream.
      await runTurn(
        service,
        sessionId,
        [INIT, completionStep(), delta('it finished', 'DONE', 41), resultLine('it finished')].join('\n') + '\n',
      );

      expect(service.getBackgroundChildren(sessionId)[0]?.status).toBe('completed');
      expect(service.hasRunningBackgroundTasks(sessionId)).toBe(false);
    } finally {
      await service.shutdown();
    }
  });

  it('is false for a session with no background tasks and for an unknown session', async () => {
    const child = fakeSpawnChild();
    const service = makeService(child);
    try {
      const { sessionId } = await service.createSession('/tmp/bg-pending-test', 'gemini-3.8-flash-medium');
      await runTurn(
        service,
        sessionId,
        [INIT, delta('ordinary answer', 'DONE'), resultLine('ordinary answer')].join('\n') + '\n',
      );
      expect(service.getBackgroundChildren(sessionId)).toEqual([]);
      expect(service.hasRunningBackgroundTasks(sessionId)).toBe(false);
      expect(service.hasRunningBackgroundTasks('no-such-session')).toBe(false);
    } finally {
      await service.shutdown();
    }
  });
});
