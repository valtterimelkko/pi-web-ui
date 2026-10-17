import { describe, it, expect, vi, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Step 1j item 1 (m-piweb review finding 2): with the receipt watcher
 * disabled (ANTIGRAVITY_BACKGROUND_WATCH_INTERVAL_MS=0), pollBackgroundCompletions
 * never runs, so a Stop (abort()) on a session with a running background task
 * left the session's stream normalizer in `streamNormalizers` for the whole
 * process lifetime. abort() must drop it when the watcher is disabled;
 * unchanged when the watcher runs (that retention is covered by the sibling
 * test "a user Stop keeps polling background-task completion receipts").
 */

const ctrl = vi.hoisted(() => {
  // Must be set BEFORE the config module is imported (module-level singleton
  // reads this env at import time). vi.hoisted runs before the imports below.
  const sessionDir = `/tmp/agy-abort-norm-${process.pid}-${Math.random().toString(36).slice(2)}`;
  process.env.ANTIGRAVITY_SESSION_DIR = sessionDir;
  // The whole point of this file: the receipt watcher is disabled.
  process.env.ANTIGRAVITY_BACKGROUND_WATCH_INTERVAL_MS = '0';
  return { sessionDir };
});

import { AntigravityService } from '../../../src/antigravity/antigravity-service.js';
import { AgyEventNormalizer } from '../../../src/antigravity/agy-event-normalizer.js';
import { parseAgyLine } from '../../../src/antigravity/agy-event-types.js';

const CONV = 'c-abort-norm';
const TASK_ID = `${CONV}/task-42`;
const COMMAND = 'sleep 30 && echo DONE';
const WATCH_DIR_BASE = `/root/.gemini/antigravity-cli/brain/${CONV}/.system_generated/tasks/task-42.log`;

const INIT = JSON.stringify({
  event: 'init',
  conversation_id: CONV,
  init: { cwd: '/w', tools: ['run_command'], permission_mode: 'always-proceed', model: 'gemini-3.6-flash-low' },
});

function startStep(index = 10): string {
  return JSON.stringify({
    event: 'step_update',
    step_update: {
      conversation_id: CONV, step_index: index, state: 'RUNNING', step_type: 'GENERIC',
      content:
        `Created At: 2026-09-10T07:08:35Z\n` +
        `Tool is running as a background task with task id: ${TASK_ID}\n` +
        `Task Description: ${COMMAND}\n` +
        `Task logs are available at: file://${WATCH_DIR_BASE}\n`,
    },
  });
}

const RESULT = JSON.stringify({
  event: 'result',
  result: {
    conversation_id: CONV, status: 'SUCCESS', response: 'launched the command',
    duration_seconds: 1.2, num_turns: 1,
    usage: { input_tokens: 10, output_tokens: 2, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 12 },
  },
});

const SCRIPTED = [INIT, startStep(), RESULT].join('\n') + '\n';

/** Scripted fake agy child (same shape as the sibling background-task tests). */
function fakeSpawnChild(): EventEmitter {
  const child = new EventEmitter();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const stdin = new EventEmitter() as EventEmitter & { write: (s: string) => boolean; destroyed: boolean; end: () => void };
  stdin.destroyed = false;
  stdin.end = () => {};
  stdin.write = (s: string) => {
    if (stdout.listenerCount('data') > 0) stdout.emit('data', Buffer.from(SCRIPTED));
    return true;
  };
  (child as unknown as { stdout: EventEmitter }).stdout = stdout;
  (child as unknown as { stderr: EventEmitter }).stderr = stderr;
  (child as unknown as { stdin: typeof stdin }).stdin = stdin;
  (child as unknown as { kill: () => void }).kill = vi.fn();
  return child;
}

describe('AntigravityService.abort() with the receipt watcher disabled', () => {
  const watchDirs: string[] = [];

  afterAll(() => {
    rmSync(ctrl.sessionDir, { recursive: true, force: true });
    for (const dir of watchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    // Do not leak this file's disabled cadence into other test files that do
    // not set the variable themselves (they should see the built-in default).
    delete process.env.ANTIGRAVITY_BACKGROUND_WATCH_INTERVAL_MS;
  });

  it('the scripted start notice is the real grammar: the normalizer derives the receipt watch dir from it', () => {
    // Sanity for the main test: the start notice this file scripts must be
    // the live grammar — the normalizer must see the task and its watch dir.
    const n = new AgyEventNormalizer({ sessionId: CONV });
    n.onParsed(parseAgyLine(startStep()), 1_700_000_000_000);
    expect([...n.getBackgroundChildren()]).toHaveLength(1);
    expect(n.getBackgroundTaskWatchDir(TASK_ID)).toContain(`${CONV}/.system_generated/messages`);
  });

  it('drops the stream normalizer on abort while a background task is still running (pollBackgroundCompletions can never run: interval 0)', async () => {
    const isolatedWatchDir = mkdtempSync(join(tmpdir(), 'agy-abort-norm-watch-'));
    watchDirs.push(isolatedWatchDir);

    const child = fakeSpawnChild();
    const service = new AntigravityService({
      registryPath: join(ctrl.sessionDir, 'registry.json'),
      streamSpawnFn: (() => child) as unknown as typeof import('node:child_process').spawn,
    });

    try {
      const { sessionId } = await service.createSession('/tmp/abort-norm-test', 'gemini-3.6-flash-medium');
      const events: unknown[] = [];
      await new Promise<void>((resolve, reject) => {
        void service.sendPrompt(sessionId, 'run the long command', (e) => events.push(e), (err) => {
          if (err) reject(err); else resolve();
        });
      });

      // The turn ended while the task is still running.
      expect(service.getBackgroundChildren(sessionId)[0].status).toBe('running');
      // The normalizer exists for this session (private state under fix; the
      // behaviour that matters is observable only through retention here).
      const normalizers = (service as unknown as { streamNormalizers: Map<string, unknown> }).streamNormalizers;
      expect(normalizers.has(sessionId)).toBe(true);

      // The user Stops the session: with the watcher disabled nothing will
      // ever poll the receipts, so abort() must drop the normalizer too.
      service.abort(sessionId);
      expect(normalizers.has(sessionId)).toBe(false);
    } finally {
      await service.shutdown();
    }
  });
});
