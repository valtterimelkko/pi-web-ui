import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {
  readBackgroundTasksSnapshot,
  createPiBackgroundChildBridge,
  BACKGROUND_STATUS_KEY,
  BACKGROUND_STATUS_WIDGET_KEY,
  BACKGROUND_SHELL_STATUS_KEY,
  BACKGROUND_SHELL_STATUS_WIDGET_KEY,
} from '../../../src/internal-api/background-children.js';

const TS = 1700000000000;

/** Typed lookup helper — test files must not use non-null assertions. */
function mustFind<T extends { id: string }>(children: T[], id: string): T {
  const found = children.find((c) => c.id === id);
  if (!found) throw new Error(`expected child card ${id} in snapshot`);
  return found;
}

function entry(line: unknown): string {
  return JSON.stringify(line);
}

function backgroundEntry(tasks: unknown): string {
  return entry({ type: 'custom', customType: 'background-tasks', data: { tasks }, timestamp: TS });
}

describe('readBackgroundTasksSnapshot', () => {
  let tmpDir: string;
  let sessionFile: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bg-children-'));
    sessionFile = path.join(tmpDir, 'session.jsonl');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns [] for a missing file', async () => {
    expect(await readBackgroundTasksSnapshot(path.join(tmpDir, 'nope.jsonl'))).toEqual([]);
  });

  it('returns [] when the file has no background-tasks entries', async () => {
    await fs.writeFile(sessionFile, [
      entry({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }),
      entry({ type: 'custom', customType: 'other', data: { x: 1 } }),
    ].join('\n'));
    expect(await readBackgroundTasksSnapshot(sessionFile)).toEqual([]);
  });

  it('projects the LATEST background-tasks entry with status mapping and model', async () => {
    await fs.writeFile(sessionFile, [
      backgroundEntry([{ taskId: 'bg_old', agent: 'scout', status: 'running' }]),
      entry({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'work in progress' }] } }),
      backgroundEntry([
        { taskId: 'bg_1', runId: 'sa_1', kind: 'bounded', agent: 'web-researcher', task: 'ETF pack', cwd: '/tmp/r', status: 'running', startedAt: '2026-09-04T15:00:00.000Z', model: 'openai-codex/gpt-5.6-luna' },
        { taskId: 'bg_2', agent: 'fixer', status: 'completed', startedAt: '2026-09-04T15:00:00.000Z', endedAt: '2026-09-04T15:01:00.000Z', summary: 'fixed' },
        { taskId: 'bg_3', agent: 'planner', status: 'failed', errorMessage: 'boom' },
        { taskId: 'bg_4', agent: 'scout', status: 'timed_out' },
        { taskId: 'bg_5', agent: 'scout', status: 'aborted' },
        { taskId: 'bg_6', agent: 'scout', status: 'lost' },
      ]),
    ].join('\n'));

    const children = await readBackgroundTasksSnapshot(sessionFile);
    expect(children).toHaveLength(6);

    const running = children.find((c) => c.id === 'bg_1')!;
    expect(running).toMatchObject({
      kind: 'background_subagent',
      status: 'running',
      label: 'web-researcher',
      model: 'openai-codex/gpt-5.6-luna',
      runId: 'sa_1',
      cwd: '/tmp/r',
      startedAt: Date.parse('2026-09-04T15:00:00.000Z'),
    });
    expect(running.task).toContain('ETF pack');

    expect(children.find((c) => c.id === 'bg_2')!.status).toBe('completed');
    expect(children.find((c) => c.id === 'bg_2')!.endedAt).toBe(Date.parse('2026-09-04T15:01:00.000Z'));
    expect(children.find((c) => c.id === 'bg_3')!.status).toBe('failed');
    expect(children.find((c) => c.id === 'bg_3')!.error).toBe('boom');
    const timedOut = children.find((c) => c.id === 'bg_4')!;
    expect(timedOut.status).toBe('failed');
    expect(timedOut.timedOut).toBe(true);
    expect(children.find((c) => c.id === 'bg_5')!.status).toBe('cancelled');
    const lost = children.find((c) => c.id === 'bg_6')!;
    expect(lost.status).toBe('failed');
    expect(lost.error).toBeTruthy();
  });

  it('tolerates a partial first line from a bounded tail read', async () => {
    const pad = 'x'.repeat(2000);
    await fs.writeFile(sessionFile, [
      entry({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: pad }] } }) + '…TRUNC',
      backgroundEntry([{ taskId: 'bg_tail', agent: 'scout', status: 'running' }]),
    ].join('\n'));
    const children = await readBackgroundTasksSnapshot(sessionFile, 4096);
    expect(children.map((c) => c.id)).toEqual(['bg_tail']);
  });
});

describe('createPiBackgroundChildBridge', () => {
  function bgStatusMessage(): unknown {
    return { type: 'extension_status', status: { key: BACKGROUND_STATUS_KEY, text: '🤖 1 background child running' } };
  }

  it('ignores unrelated extension UI messages', async () => {
    const published: unknown[] = [];
    const broadcasts: unknown[] = [];
    const bridge = createPiBackgroundChildBridge({
      sessionId: 'sess-1',
      readChildren: async () => [{ id: 'bg_1', kind: 'background_subagent', status: 'running', label: 'scout' }],
      publish: (e) => published.push(e),
      broadcast: (m) => broadcasts.push(m),
    });
    await bridge({ type: 'extension_status', status: { key: 'goal-engine', text: 'x' } });
    await bridge({ type: 'widget_content', key: 'unrelated', content: [] });
    expect(published).toHaveLength(0);
    expect(broadcasts).toHaveLength(0);
  });

  it('publishes background_child_state to the broker and broadcasts it on a background status message', async () => {
    const published: unknown[] = [];
    const broadcasts: unknown[] = [];
    const children = [{ id: 'bg_1', kind: 'background_subagent' as const, status: 'running' as const, label: 'scout' }];
    const bridge = createPiBackgroundChildBridge({
      sessionId: 'sess-1',
      readChildren: async () => children,
      publish: (e) => published.push(e),
      broadcast: (m) => broadcasts.push(m),
    });

    await bridge(bgStatusMessage());

    expect(published).toHaveLength(1);
    const pub = published[0] as { type: string; data: { sessionId: string; children: unknown } };
    expect(pub.type).toBe('background_child_state');
    expect(pub.data.sessionId).toBe('sess-1');
    expect(pub.data.children).toEqual(children);

    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toMatchObject({ type: 'background_child_state', sessionId: 'sess-1', children });
  });

  it('also triggers on the widget key and on widget_cleared (state transitions)', async () => {
    const published: unknown[] = [];
    let empty = false;
    const bridge = createPiBackgroundChildBridge({
      sessionId: 'sess-1',
      readChildren: async () => (empty ? [] : [{ id: 'bg_1', kind: 'background_subagent' as const, status: 'running' as const, label: 'scout' }]),
      publish: (e) => published.push(e),
      broadcast: () => {},
    });
    await bridge({ type: 'widget_content', key: BACKGROUND_STATUS_WIDGET_KEY, content: ['x'] });
    empty = true;
    await bridge({ type: 'widget_cleared', key: BACKGROUND_STATUS_WIDGET_KEY });
    expect(published).toHaveLength(2);
  });

  it('dedupes identical consecutive snapshots', async () => {
    const published: unknown[] = [];
    const children = [{ id: 'bg_1', kind: 'background_subagent' as const, status: 'running' as const, label: 'scout' }];
    const bridge = createPiBackgroundChildBridge({
      sessionId: 'sess-1',
      readChildren: async () => children,
      publish: (e) => published.push(e),
      broadcast: () => {},
    });
    await bridge(bgStatusMessage());
    await bridge(bgStatusMessage());
    expect(published).toHaveLength(1);
  });

  it('stays silent when the read fails', async () => {
    const published: unknown[] = [];
    const broadcasts: unknown[] = [];
    const bridge = createPiBackgroundChildBridge({
      sessionId: 'sess-1',
      readChildren: async () => { throw new Error('disk gone'); },
      publish: (e) => published.push(e),
      broadcast: (m) => broadcasts.push(m),
    });
    await bridge(bgStatusMessage());
    expect(published).toHaveLength(0);
    expect(broadcasts).toHaveLength(0);
  });
});

describe('readBackgroundTasksSnapshot — background shell tasks (contract 1.41.0)', () => {
  let tmpDir: string;
  let sessionFile: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bg-shell-children-'));
    sessionFile = path.join(tmpDir, 'session.jsonl');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function shellEntry(tasks: unknown): string {
    return entry({ type: 'custom', customType: 'bg-shell-tasks', data: { tasks }, timestamp: TS });
  }

  it('projects the LATEST bg-shell-tasks entry as background_shell cards with exit codes', async () => {
    await fs.writeFile(sessionFile, [
      shellEntry([{ taskId: 'bg_old_shell', command: 'echo old', status: 'running' }]),
      shellEntry([
        { taskId: 'bg_sh1', command: 'npm test', cwd: '/repo', status: 'running', startedAt: '2026-09-10T12:00:00.000Z', priority: 'normal', kind: 'bounded' },
        { taskId: 'bg_sh2', command: 'npm run build', status: 'completed', exitCode: 0, startedAt: 's', endedAt: '2026-09-10T12:01:00.000Z' },
        { taskId: 'bg_sh3', command: 'flaky-check', status: 'failed', exitCode: 3, errorMessage: 'exit 3' },
        { taskId: 'bg_sh4', command: 'sleep 600', status: 'timed_out' },
        { taskId: 'bg_sh5', command: 'sleep 600', status: 'aborted' },
        { taskId: 'bg_sh6', command: 'sleep 600', status: 'lost' },
        { taskId: 'bg_sh7', command: 'sleep 600', status: 'orphaned' },
        { taskId: 'bg_sh8', command: 'watcher', status: 'running', label: 'repo watcher' },
      ]),
    ].join('\n'));

    const children = await readBackgroundTasksSnapshot(sessionFile);
    expect(children).toHaveLength(8);

    const running = mustFind(children, 'bg_sh1');
    expect(running).toMatchObject({
      kind: 'background_shell',
      status: 'running',
      cwd: '/repo',
      startedAt: Date.parse('2026-09-10T12:00:00.000Z'),
    });
    expect(running.label).toBe('npm test');
    expect(running.task).toBe('npm test');

    const completed = mustFind(children, 'bg_sh2');
    expect(completed.status).toBe('completed');
    expect(completed.exitCode).toBe(0);
    expect(completed.endedAt).toBe(Date.parse('2026-09-10T12:01:00.000Z'));

    const failed = mustFind(children, 'bg_sh3');
    expect(failed.status).toBe('failed');
    expect(failed.exitCode).toBe(3);
    expect(failed.error).toBe('exit 3');

    expect(mustFind(children, 'bg_sh4').status).toBe('failed');
    expect(mustFind(children, 'bg_sh4').timedOut).toBe(true);
    expect(mustFind(children, 'bg_sh5').status).toBe('cancelled');
    expect(mustFind(children, 'bg_sh6').status).toBe('failed');
    expect(mustFind(children, 'bg_sh6').error).toBe('lost');
    expect(mustFind(children, 'bg_sh7').status).toBe('failed');
    expect(mustFind(children, 'bg_sh7').error).toBe('orphaned');

    expect(mustFind(children, 'bg_sh8').label).toBe('repo watcher');
  });

  it('merges subagent and shell entries from the same session (latest of each type)', async () => {
    await fs.writeFile(sessionFile, [
      backgroundEntry([{ taskId: 'bg_sub1', agent: 'scout', status: 'running' }]),
      shellEntry([{ taskId: 'bg_shell1', command: 'npm test', status: 'running' }]),
      backgroundEntry([{ taskId: 'bg_sub2', agent: 'fixer', status: 'completed' }]),
    ].join('\n'));

    const children = await readBackgroundTasksSnapshot(sessionFile);
    expect(children.map((c) => c.id).sort()).toEqual(['bg_shell1', 'bg_sub2']);
    expect(mustFind(children, 'bg_sub2').kind).toBe('background_subagent');
    expect(mustFind(children, 'bg_shell1').kind).toBe('background_shell');
  });

  it('returns [] for a shell-only session file without entries', async () => {
    await fs.writeFile(sessionFile, entry({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }));
    expect(await readBackgroundTasksSnapshot(sessionFile)).toEqual([]);
  });
});

describe('createPiBackgroundChildBridge — shell triggers (contract 1.41.0)', () => {
  function shellStatusMessage(): unknown {
    return { type: 'extension_status', status: { key: BACKGROUND_SHELL_STATUS_KEY, text: '🐚 1 background shell task running' } };
  }

  it('triggers on the background-shell status key and widget keys', async () => {
    const published: unknown[] = [];
    const broadcasts: unknown[] = [];
    let count = 1;
    const bridge = createPiBackgroundChildBridge({
      sessionId: 'sess-1',
      readChildren: async () => [{ id: `bg_sh${count}`, kind: 'background_shell' as const, status: 'running' as const, label: 'npm test' }],
      publish: (e) => published.push(e),
      broadcast: (m) => broadcasts.push(m),
    });

    await bridge(shellStatusMessage());
    count += 1;
    await bridge({ type: 'widget_content', key: BACKGROUND_SHELL_STATUS_WIDGET_KEY, content: ['x'] });
    count += 1;
    await bridge({ type: 'widget_cleared', key: BACKGROUND_SHELL_STATUS_WIDGET_KEY });
    expect(published).toHaveLength(3);
    expect(broadcasts).toHaveLength(3);
    expect((published[0] as { data: { children: Array<{ kind: string }> } }).data.children[0].kind).toBe('background_shell');
  });

  it('shell status messages do not trip the subagent-only dedup state', async () => {
    const published: unknown[] = [];
    let read = 0;
    const bridge = createPiBackgroundChildBridge({
      sessionId: 'sess-1',
      readChildren: async () => {
        read += 1;
        return [{ id: `bg_${read}`, kind: 'background_shell' as const, status: 'running' as const, label: 'x' }];
      },
      publish: (e) => published.push(e),
      broadcast: () => {},
    });
    await bridge({ type: 'extension_status', status: { key: BACKGROUND_STATUS_KEY, text: 'subagent status' } });
    await bridge(shellStatusMessage());
    expect(published).toHaveLength(2, 'both rails deliver through the same bridge');
  });
});
