/**
 * Integration test for the screen-view endpoint: exercises the REAL per-runtime
 * replay loaders (not mocked getReplayEvents) → the shared projection, to prove
 * the full file/native-format → events → screen-view pipeline is faithful for
 * every runtime, plus the route end-to-end for Pi against a real registry.
 *
 * See SCREEN-VIEW-OBSERVABILITY-PLAN.md §4 Stage 2.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import type { ServerResponse } from 'http';
import { Writable } from 'stream';
import { ClaudeSessionStore } from '../../src/claude/claude-session-store.js';
import { historyToReplayEvents } from '../../src/claude/claude-history-replay.js';
import { opencodeMessagesToReplayEvents } from '../../src/opencode/opencode-history-replay.js';
import { turnsToReplayEvents } from '../../src/antigravity/antigravity-history-replay.js';
import { projectDefaultViewFromEvents } from '@pi-web-ui/shared';
import { createSessionRoutes } from '../../src/internal-api/routes/sessions.js';
import { SessionRegistryManager } from '../../src/session-registry.js';

const cleanupPaths: string[] = [];
afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((target) => fs.rm(target, { recursive: true, force: true })));
});

function createMockRes(): ServerResponse & { body: string; statusCode: number } {
  const chunks: Buffer[] = [];
  const res = new Writable({
    write(chunk: Buffer, _e: BufferEncoding, cb: (error?: Error | null) => void) {
      chunks.push(chunk);
      cb();
    },
  }) as unknown as ServerResponse & { body: string; statusCode: number };
  res.statusCode = 200;
  res.setHeader = vi.fn();
  res.writeHead = vi.fn(function (this: typeof res, code: number) {
    res.statusCode = code;
    return this;
  });
  res.end = vi.fn(function (this: typeof res, data?: string | Buffer) {
    if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
    res.body = Buffer.concat(chunks).toString();
    return this;
  }) as any;
  res.getHeader = vi.fn();
  res.on = vi.fn();
  return res;
}

describe('screen-view: real loader → projection pipeline', () => {
  it('Claude: real JSONL → historyToReplayEvents → projection (coalesced + tool paired)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sv-claude-'));
    cleanupPaths.push(dir);
    const sid = 'claude-sess-1';
    const file = path.join(dir, `${sid}.jsonl`);
    await fs.writeFile(
      file,
      [
        JSON.stringify({ type: 'meta', sessionId: sid, claudeSessionId: 'c-native', cwd: '/x', model: 'sonnet', createdAt: '2026-06-01T00:00:00.000Z', timestamp: 1000 }),
        JSON.stringify({ type: 'user', sessionId: sid, content: 'List the files', timestamp: 1100 }),
        JSON.stringify({ type: 'tool', sessionId: sid, toolCallId: 'tc_1', toolName: 'Bash', toolInput: { command: 'ls -la' }, timestamp: 1200 }),
        JSON.stringify({ type: 'tool_result', sessionId: sid, toolCallId: 'tc_1', toolOutput: 'file-a\nfile-b', isError: false, timestamp: 1300 }),
        JSON.stringify({ type: 'assistant', sessionId: sid, content: 'There are two files.', timestamp: 1400 }),
      ].join('\n') + '\n',
      'utf-8',
    );

    const store = new ClaudeSessionStore(dir);
    const entries = await store.loadHistory(sid);
    const events = historyToReplayEvents(entries);
    const view = projectDefaultViewFromEvents(events);

    const kinds = view.items.map((i) => i.kind);
    expect(kinds).toEqual(['user', 'tool', 'assistant']);
    const tool = view.items.find((i) => i.kind === 'tool')!;
    expect(tool.toolName).toBe('Bash'); // PascalCase Claude name, still visible
    expect(tool.toolPrimaryArg).toBe('ls -la');
    expect(tool.collapsedByDefault).toBe(true);
    expect(tool.expandedText).toBeUndefined(); // collapsed by default
    expect(view.items.find((i) => i.kind === 'assistant')!.text).toBe('There are two files.');
  });

  it('OpenCode: real messages → opencodeMessagesToReplayEvents → projection', async () => {
    const messages = [
      {
        info: { id: 'u1', sessionID: 'oc-s', role: 'user', time: { created: 1000 }, path: { cwd: '/x', root: '/x' } },
        parts: [{ type: 'text', id: 'p1', sessionID: 'oc-s', messageID: 'u1', text: 'Hello OC' }],
      },
      {
        info: { id: 'a1', sessionID: 'oc-s', role: 'assistant', time: { created: 2000 } },
        parts: [
          { type: 'tool-invocation', id: 'p2', sessionID: 'oc-s', messageID: 'a1', toolInvocationId: 'ti1', toolName: 'Bash', args: { command: 'pwd' }, state: { status: 'completed', output: '/root' } },
          { type: 'text', id: 'p3', sessionID: 'oc-s', messageID: 'a1', text: 'OC done' },
        ],
      },
    ];
    const events = opencodeMessagesToReplayEvents(messages as any, 'oc-s');
    const view = projectDefaultViewFromEvents(events);
    const kinds = view.items.map((i) => i.kind);
    expect(kinds).toEqual(['user', 'tool', 'assistant']);
    expect(view.items.find((i) => i.kind === 'tool')!.toolName).toBe('Bash');
    expect(view.items.find((i) => i.kind === 'assistant')!.text).toBe('OC done');
  });

  it('Antigravity: real turns → turnsToReplayEvents → projection (valid thin view)', async () => {
    const turns = [
      { turnId: 't1', prompt: 'Hi agy', response: 'Hello from Gemini.', model: 'gemini', conversationId: null, timestamp: 1000 },
    ];
    const events = turnsToReplayEvents(turns as any, 'ag-s');
    const view = projectDefaultViewFromEvents(events);
    expect(view.items.map((i) => i.kind)).toEqual(['user', 'assistant']);
    expect(view.items.find((i) => i.kind === 'user')!.text).toBe('Hi agy');
    expect(view.items.find((i) => i.kind === 'assistant')!.text).toBe('Hello from Gemini.');
  });

  it('Pi: route end-to-end against a real registry + real session file', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sv-pi-route-'));
    cleanupPaths.push(dir);
    const piFile = path.join(dir, 'pi-session.jsonl');
    await fs.writeFile(
      piFile,
      [
        JSON.stringify({ type: 'session', id: 'pi-1', timestamp: '2026-06-01T00:00:00.000Z', cwd: '/root/proj' }),
        JSON.stringify({ type: 'message', id: 'm1', timestamp: '2026-06-01T00:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'summarize' }], timestamp: 1000 } }),
        JSON.stringify({ type: 'tool_execution_start', toolCallId: 'pt1', toolName: 'bash', args: { command: 'cat x' }, timestamp: 1500 }),
        JSON.stringify({ type: 'tool_execution_end', toolCallId: 'pt1', result: { content: [{ type: 'text', text: 'x contents' }] }, isError: false, timestamp: 1600 }),
        JSON.stringify({ type: 'message', id: 'm2', timestamp: '2026-06-01T00:00:02.000Z', message: { role: 'assistant', content: [
          { type: 'thinking', thinking: 'I should summarise the file first. Then answer.' },
          { type: 'text', text: 'Here is the summary.' },
        ], timestamp: 2000 } }),
      ].join('\n') + '\n',
      'utf-8',
    );

    const registry = new SessionRegistryManager(path.join(dir, 'registry.json'));
    await registry.upsert({
      id: 'pi-1',
      sdkType: 'pi',
      path: piFile,
      cwd: '/root/proj',
      firstMessage: 'summarize',
      messageCount: 3,
      createdAt: '2026-06-01T00:00:00.000Z',
      lastActivity: '2026-06-01T00:00:02.000Z',
      status: 'idle',
    } as any);

    const routes = createSessionRoutes({
      claudeService: {} as any,
      opencodeService: {} as any,
      antigravityService: {} as any,
      multiSessionManager: {} as any,
      sessionRegistry: registry,
      piService: {} as any,
      internalClientId: 'integ-test',
      watchDir: path.join(dir, 'watches'),
    } as any);

    const res = createMockRes();
    await routes.handleSessionTranscript(
      {} as any,
      res,
      'pi-1',
      new URLSearchParams('view=screen&expand=tools'),
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.view).toBe('screen');
    expect(body.runtime).toBe('pi');
    expect(body.screenView.items.map((i: any) => i.kind)).toEqual(['user', 'tool', 'thinking', 'assistant']);
    expect(body.markdown).toContain('I should summarise the file first');
    expect(body.markdown).toContain('Here is the summary.');
    // expand=tools surfaced the tool output
    expect(body.markdown).toContain('x contents');
    expect(body.expanded.tools).toBe(true);
  });
});
