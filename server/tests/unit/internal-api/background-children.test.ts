import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {
  readBackgroundTasksSnapshot,
  createPiBackgroundChildBridge,
  BACKGROUND_STATUS_KEY,
  BACKGROUND_STATUS_WIDGET_KEY,
} from '../../../src/internal-api/background-children.js';

const TS = 1700000000000;

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
