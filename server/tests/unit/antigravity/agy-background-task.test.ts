import { describe, it, expect } from 'vitest';
import { AgyEventNormalizer } from '../../../src/antigravity/agy-event-normalizer.js';
import { parseAgyLine } from '../../../src/antigravity/agy-event-types.js';
import type { NormalizedEvent } from '@pi-web-ui/shared';
import type { ChildCardProjection } from '@pi-web-ui/shared';

/**
 * Antigravity background-task surfacing (plan
 * docs/plans/ANTIGRAVITY-BACKGROUND-TASKS-AND-ARCHIVE-ROBUSTNESS-PLAN.md
 * Phase 1): when agy demotes a run_command to a background task, the
 * normalizer must detect the task start/completion from step content and
 * emit `background_child_state` events whose children match
 * ChildCardProjection, so the frontend ChildrenStrip shows the running
 * banner.
 *
 * Wire evidence (live session 1de6598c, 2026-09-10):
 * - START  (GENERIC/RUNNING step content):
 *     "Created At: ...\nTool is running as a background task with task id:
 *      <conversationId>/task-3085\nTask Description: <command>\nTask logs
 *      are available at: file://.../.system_generated/tasks/task-3085.log\n..."
 * - DONE   (SYSTEM_MESSAGE step content):
 *     "[Message] timestamp=... sender=<conversationId>/task-3085 ...
 *      content=Task id \"<conversationId>/task-3085\" finished with result:
 *      \n\nThe command exited with code 1.\nOutput:\n..."
 * The same notice text can also arrive through run_command tool_info.output
 * or agent_response text_delta in stream-json mode — all three carriers are
 * probed.
 */

const SID = 'agy-bg-session';
const T = 1_700_000_000_000;
const CONV = '1de6598c-cbef-4bd8-bec9-937bfdbf09c1';
const TASK_ID = `${CONV}/task-3085`;
const COMMAND = 'python3 /brain/scratch/verify_e2e.py';

function feed(n: AgyEventNormalizer, lines: string[], ts = T): NormalizedEvent[] {
  return lines.flatMap((l) => n.onParsed(parseAgyLine(l), ts));
}

const INIT = JSON.stringify({
  event: 'init',
  conversation_id: CONV,
  init: { cwd: '/w', tools: ['run_command'], permission_mode: 'always-proceed', model: 'gemini-3.6-flash-low' },
});

/** Native GENERIC step shape: content rides the passthrough `content` field. */
function genericStep(content: string, state = 'RUNNING', index = 10): string {
  return JSON.stringify({
    event: 'step_update',
    step_update: { conversation_id: CONV, step_index: index, state, step_type: 'GENERIC', content },
  });
}

function startContent(taskId = TASK_ID, description = COMMAND): string {
  const shortTask = taskId.includes('/') ? taskId.slice(taskId.lastIndexOf('/') + 1) : taskId;
  return (
    `Created At: 2026-09-10T07:08:35Z\n` +
    `Tool is running as a background task with task id: ${taskId}\n` +
    `Task Description: ${description}\n` +
    `Task logs are available at: file:///root/.gemini/antigravity-cli/brain/${CONV}/.system_generated/tasks/${shortTask}.log\n` +
    `YOU MUST TAKE ONE OF THE FOLLOWING TWO ACTIONS: A) either proceed to other relevant work...`
  );
}

function completionContent(taskId = TASK_ID, code = 1): string {
  return (
    `The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n\n<SYSTEM_MESSAGE>\n` +
    `[Message] timestamp=2026-09-10T07:09:02Z sender=${taskId} priority=MESSAGE_PRIORITY_HIGH ` +
    `content=Task id "${taskId}" finished with result:\n\nThe command exited with code ${code}.\nOutput:\nsome output`
  );
}

function backgroundEvents(events: NormalizedEvent[]): Array<{ sessionId: string; children: ChildCardProjection[] }> {
  return events
    .filter((e) => e.type === 'background_child_state')
    .map((e) => e.data as unknown as { sessionId: string; children: ChildCardProjection[] });
}

describe('AgyEventNormalizer background task detection', () => {
  it('emits background_child_state with a running child when the GENERIC step announces a background task', () => {
    const n = new AgyEventNormalizer({ sessionId: SID });
    const events = feed(n, [INIT, genericStep(startContent())]);

    const bg = backgroundEvents(events);
    expect(bg).toHaveLength(1);
    expect(bg[0].sessionId).toBe(SID);
    expect(bg[0].children).toHaveLength(1);
    const child = bg[0].children[0];
    expect(child.id).toBe(TASK_ID);
    expect(child.kind).toBe('antigravity_task');
    expect(child.status).toBe('running');
    expect(child.task).toBe(COMMAND);
    expect(child.label).toBe(COMMAND);
    expect(child.model).toBe('antigravity-task');
    expect(child.startedAt).toBe(T);
    // The full projection round-trips through getBackgroundChildren.
    expect(n.getBackgroundChildren()).toEqual(bg[0].children);
  });

  it('detects the start notice delivered via run_command tool_info.output (stream-json carrier)', () => {
    const n = new AgyEventNormalizer({ sessionId: SID });
    const toolDone = JSON.stringify({
      event: 'step_update',
      step_update: {
        conversation_id: CONV, step_index: 3, state: 'DONE', step_type: 'tool', tool_name: 'run_command',
        tool_info: { name: 'run_command', parameters: { CommandLine: COMMAND }, output: startContent() },
      },
    });
    const events = feed(n, [INIT, toolDone]);
    const bg = backgroundEvents(events);
    expect(bg).toHaveLength(1);
    expect(bg[0].children[0].id).toBe(TASK_ID);
    expect(bg[0].children[0].status).toBe('running');
  });

  it('detects the start notice delivered via text_delta', () => {
    const n = new AgyEventNormalizer({ sessionId: SID });
    const step = JSON.stringify({
      event: 'step_update',
      step_update: { conversation_id: CONV, step_index: 4, state: 'ACTIVE', step_type: 'agent_response', text_delta: startContent() },
    });
    const events = feed(n, [INIT, step]);
    expect(backgroundEvents(events)).toHaveLength(1);
  });

  it('does not re-announce a known task when its step is re-delivered', () => {
    const n = new AgyEventNormalizer({ sessionId: SID });
    const events = feed(n, [INIT, genericStep(startContent(), 'RUNNING', 10), genericStep(startContent(), 'DONE', 10)]);
    expect(backgroundEvents(events)).toHaveLength(1);
  });

  it('marks the child completed (with exit code) when the completion SYSTEM_MESSAGE arrives', () => {
    const n = new AgyEventNormalizer({ sessionId: SID });
    const events = feed(n, [INIT, genericStep(startContent()), genericStep(completionContent(), 'DONE', 11)]);

    const bg = backgroundEvents(events);
    expect(bg).toHaveLength(2);
    const done = bg[1].children[0];
    expect(done.id).toBe(TASK_ID);
    expect(done.status).toBe('completed');
    expect(done.exitCode).toBe(1);
    expect(done.endedAt).toBe(T);
    // Still tracked (durable card keeps the final state), just not running.
    expect(n.getBackgroundChildren()).toHaveLength(1);
    expect(n.getBackgroundChildren().every((c) => c.status !== 'running')).toBe(true);
  });

  it('completes only the task named in the completion message; siblings keep running', () => {
    const n = new AgyEventNormalizer({ sessionId: SID });
    const other = `${CONV}/task-3096`;
    const events = feed(n, [
      INIT,
      genericStep(startContent(TASK_ID), 'RUNNING', 10),
      genericStep(startContent(other), 'RUNNING', 20),
      genericStep(completionContent(TASK_ID, 0), 'DONE', 21),
    ]);

    const bg = backgroundEvents(events);
    expect(bg).toHaveLength(3);
    const last = bg[2].children;
    expect(last).toHaveLength(2);
    const byId = new Map(last.map((c) => [c.id, c]));
    expect(byId.get(TASK_ID)?.status).toBe('completed');
    expect(byId.get(TASK_ID)?.exitCode).toBe(0);
    expect(byId.get(other)?.status).toBe('running');
  });

  it('background tasks survive the turn boundary (result does not clear them)', () => {
    const n = new AgyEventNormalizer({ sessionId: SID });
    feed(n, [INIT, genericStep(startContent())]);
    const result = JSON.stringify({
      event: 'result',
      result: {
        conversation_id: CONV, status: 'SUCCESS', response: 'launched the command and will wait',
        duration_seconds: 6.2, num_turns: 1,
        usage: { input_tokens: 100, output_tokens: 10, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 110 },
      },
    });
    const events = feed(n, [result]);
    expect(events.some((e) => e.type === 'agent_end')).toBe(true);
    expect(n.getBackgroundChildren()).toHaveLength(1);
    expect(n.getBackgroundChildren()[0].status).toBe('running');
  });

  it('seeds initialBackgroundChildren (respawn parity) and completes them later', () => {
    const seeded: ChildCardProjection[] = [{
      id: TASK_ID, kind: 'antigravity_task', status: 'running', label: COMMAND,
      model: 'antigravity-task', task: COMMAND, startedAt: T - 1000,
    }];
    const n = new AgyEventNormalizer({ sessionId: SID, initialBackgroundChildren: seeded });
    expect(n.getBackgroundChildren()).toHaveLength(1);
    const events = feed(n, [INIT, genericStep(completionContent(TASK_ID, 0), 'DONE', 30)]);
    const bg = backgroundEvents(events);
    expect(bg).toHaveLength(1);
    expect(bg[0].children[0].status).toBe('completed');
  });

  it('ignores ordinary content that merely mentions tasks (no false positives)', () => {
    const n = new AgyEventNormalizer({ sessionId: SID });
    const events = feed(n, [
      INIT,
      delta('Let me check the task list and run the tests.'),
      genericStep('Created At: 2026-09-10T07:00:00Z\nCompleted At: 2026-09-10T07:00:01Z\nFile Path: /w/file.py'),
    ]);
    expect(backgroundEvents(events)).toHaveLength(0);
    expect(n.getBackgroundChildren()).toHaveLength(0);
  });

  it('label falls back to the task id when no Task Description is present', () => {
    const n = new AgyEventNormalizer({ sessionId: SID });
    const bare = `Created At: 2026-09-10T07:08:35Z\nTool is running as a background task with task id: ${TASK_ID}\n`;
    const events = feed(n, [INIT, genericStep(bare)]);
    const bg = backgroundEvents(events);
    expect(bg).toHaveLength(1);
    expect(bg[0].children[0].label).toBe(TASK_ID);
  });

  it('exposes the messages directory hint parsed from the task-log line (completion watcher input)', () => {
    const n = new AgyEventNormalizer({ sessionId: SID });
    feed(n, [INIT, genericStep(startContent())]);
    expect(n.getBackgroundTaskWatchDirs().get(TASK_ID)).toBe(
      `/root/.gemini/antigravity-cli/brain/${CONV}/.system_generated/messages`,
    );
  });
});;

// Local helper (mirrors the sibling test files' delta builder).
function delta(text: string, state: 'ACTIVE' | 'DONE' = 'ACTIVE', index = 2): string {
  return JSON.stringify({
    event: 'step_update',
    step_update: { conversation_id: CONV, step_index: index, state, step_type: 'agent_response', text_delta: text },
  });
}

// ── Service-level tracking (Phase 1b) ─────────────────────────────────────────

import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AntigravityService } from '../../../src/antigravity/antigravity-service.js';

const svcCtrl = vi.hoisted(() => {
  const sessionDir = `/tmp/agy-bg-service-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const state = {
    sessionDir,
    registryPath: `${sessionDir}/registry.json`,
    scripted: '',
    writes: [] as string[],
  };
  // Watcher cadence fast enough for tests; module config reads this at import.
  process.env.ANTIGRAVITY_SESSION_DIR = sessionDir;
  process.env.ANTIGRAVITY_BACKGROUND_WATCH_INTERVAL_MS = '50';
  return state;
});

import { vi } from 'vitest';

const SVC_CONV = 'c-bg-svc';
const SVC_TASK = `${SVC_CONV}/task-77`;

function svcLine(raw: string): string {
  return raw.replaceAll('c-bg-svc', SVC_CONV);
}

const SVC_INIT = svcLine(INIT.replaceAll(CONV, 'c-bg-svc'));

function svcStartStep(taskId = SVC_TASK, command = 'sleep 30 && echo DONE', index = 10): string {
  return JSON.stringify({
    event: 'step_update',
    step_update: {
      conversation_id: SVC_CONV, step_index: index, state: 'RUNNING', step_type: 'GENERIC',
      content: startContent(taskId, command).replaceAll(CONV, SVC_CONV),
    },
  });
}

function svcResultLine(response = 'launched the command and will wait for it to finish'): string {
  return JSON.stringify({
    event: 'result',
    result: {
      conversation_id: SVC_CONV, status: 'SUCCESS', response,
      duration_seconds: 6.2, num_turns: 1,
      usage: { input_tokens: 100, output_tokens: 10, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 110 },
    },
  });
}

function svcFakeSpawnChild() {
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

describe('AntigravityService background task tracking', () => {
  const watchDir = mkdtempSync(join(tmpdir(), 'agy-bg-watch-'));

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

  /** Point the scripted task-log line at the temp watch dir. */
  function scriptedStartStep(command: string, index: number): string {
    return svcStartStep(SVC_TASK, command, index).replace(
      /file:\/\/[^\n]+\.system_generated\/tasks\/task-77\.log/,
      `file://${watchDir}/.system_generated/tasks/task-77.log`,
    );
  }

  async function runTurn(service: AntigravityService, sessionId: string, scripted: string): Promise<NormalizedEvent[]> {
    svcCtrl.scripted = scripted;
    const events: NormalizedEvent[] = [];
    await new Promise<void>((resolve, reject) => {
      void service.sendPrompt(sessionId, 'run the long command', (e) => events.push(e), (err) => {
        if (err) reject(err); else resolve();
      });
    });
    return events;
  }

  it('tracks a detected background task across the turn boundary and reports it via getBackgroundChildren', async () => {
    // Turn script: init, the background-task start notice, closing text, result.
    // The task-log line points at the temp watch dir so the watcher polls THERE.
    const scripted = [SVC_INIT, scriptedStartStep('sleep 30 && echo DONE', 10), delta('Launched; ending the turn now.', 'DONE', 11), svcResultLine()].join('\n') + '\n';

    const child = svcFakeSpawnChild();
    const service = makeService(child);
    try {
      const { sessionId } = await service.createSession('/tmp/bg-svc-test', 'gemini-3.6-flash-medium');
      const events = await runTurn(service, sessionId, scripted);

      // The turn ends (agent_end) even though the task still runs.
      expect(events.some((e) => e.type === 'agent_end')).toBe(true);
      // The background state event flowed through the normal prompt fan-out.
      const bg = events.filter((e) => e.type === 'background_child_state');
      expect(bg).toHaveLength(1);
      // The service keeps tracking AFTER the turn: the strip can rehydrate.
      const children = service.getBackgroundChildren(sessionId);
      expect(children).toHaveLength(1);
      expect(children[0].id).toBe(SVC_TASK);
      expect(children[0].status).toBe('running');
    } finally {
      await service.shutdown();
    }
  });

  it('completion receipt written to the messages dir is observed by the watcher and emitted post-turn', async () => {
    const scripted = [SVC_INIT, scriptedStartStep('sleep 30 && echo DONE', 10), delta('Launched.', 'DONE', 11), svcResultLine()].join('\n') + '\n';

    const child = svcFakeSpawnChild();
    const service = makeService(child);
    try {
      const { sessionId } = await service.createSession('/tmp/bg-svc-test', 'gemini-3.6-flash-medium');
      await runTurn(service, sessionId, scripted);
      expect(service.getBackgroundChildren(sessionId)[0].status).toBe('running');

      // Post-turn events arrive via API observers (the Internal API path).
      const postTurn: NormalizedEvent[] = [];
      service.addApiObserver(sessionId, (e) => postTurn.push(e));

      // agy writes the completion receipt into <brain>/<conv>/messages/.
      mkdirSync(join(watchDir, '.system_generated', 'messages'), { recursive: true });
      writeFileSync(
        join(watchDir, '.system_generated', 'messages', 'receipt-1.json'),
        JSON.stringify({
          id: 'receipt-1', recipient: SVC_CONV, sender: SVC_TASK,
          priority: 'MESSAGE_PRIORITY_HIGH', timestamp: new Date().toISOString(),
          content: `Task id "${SVC_TASK}" finished with result:\n\nThe command exited with code 0.\nOutput:\nDONE`,
        }),
      );

      await vi.waitFor(() => {
        const children = service.getBackgroundChildren(sessionId);
        expect(children[0]?.status).toBe('completed');
      }, { timeout: 5000 });
      expect(service.getBackgroundChildren(sessionId)[0].exitCode).toBe(0);
      const bg = postTurn.filter((e) => e.type === 'background_child_state');
      expect(bg.length).toBeGreaterThan(0);
    } finally {
      await service.shutdown();
    }
  });

  it('respawn parity: a fresh process turn still reports the running task and can complete it in-stream', async () => {
    const turn1 = [SVC_INIT, scriptedStartStep('sleep 30 && echo DONE', 10), delta('Launched.', 'DONE', 11), svcResultLine()].join('\n') + '\n';
    const completion = JSON.stringify({
      event: 'step_update',
      step_update: {
        conversation_id: SVC_CONV, step_index: 40, state: 'DONE', step_type: 'system_message',
        content: `Task id "${SVC_TASK}" finished with result:\n\nThe command exited with code 1.\nOutput:\nboom`,
      },
    });
    const turn2 = [SVC_INIT, delta('checking on it', 'ACTIVE', 30), completion, delta('it finished', 'DONE', 41), svcResultLine('it finished with code 1')].join('\n') + '\n';

    const child = svcFakeSpawnChild();
    const service = makeService(child);
    try {
      const { sessionId } = await service.createSession('/tmp/bg-svc-test', 'gemini-3.6-flash-medium');
      await runTurn(service, sessionId, turn1);
      expect(service.getBackgroundChildren(sessionId)[0].status).toBe('running');

      // Turn 2: process respawned (close the fake child so the service must
      // spawn a fresh one with a fresh normalizer seeded from service meta),
      // then the completion receipt arrives in-stream.
      child.emit('close', 0);
      const events2 = await runTurn(service, sessionId, turn2);
      const bg = events2.filter((e) => e.type === 'background_child_state');
      expect(bg).toHaveLength(1);
      const children = (bg[0].data as unknown as { children: Array<{ id: string; status: string; exitCode?: number }> }).children;
      expect(children[0].id).toBe(SVC_TASK);
      expect(children[0].status).toBe('completed');
      expect(children[0].exitCode).toBe(1);
      expect(service.getBackgroundChildren(sessionId)[0].status).toBe('completed');
    } finally {
      await service.shutdown();
    }
  });

  it('idle cleanup does not evict a session with running background tasks', async () => {
    vi.useFakeTimers();
    try {
      const scripted = [SVC_INIT, scriptedStartStep('sleep 30 && echo DONE', 10), delta('Launched.', 'DONE', 11), svcResultLine()].join('\n') + '\n';
      const child = svcFakeSpawnChild();
      const service = makeService(child);
      const { sessionId } = await service.createSession('/tmp/bg-svc-test', 'gemini-3.6-flash-medium');
      await runTurn(service, sessionId, scripted);
      // Advance past the idle timeout (30 min default) but INSIDE the watch
      // window (2h default): the running task must keep the meta (and banner
      // truth) alive against cleanup.
      vi.advanceTimersByTime(60 * 60 * 1000);
      vi.advanceTimersByTime(60 * 60 * 1000);
      expect(service.getBackgroundChildren(sessionId)).toHaveLength(1);
      expect(service.getBackgroundChildren(sessionId)[0].status).toBe('running');
      await service.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });
});
