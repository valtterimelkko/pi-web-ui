/**
 * Unit tests for the Internal API `view=screen` screen-view endpoint.
 *
 * Covers (per SCREEN-VIEW-OBSERVABILITY-PLAN.md §4 Stage 2):
 *  - returns a structured ScreenView + markdown for all four sdkTypes
 *    (Pi, Claude, OpenCode, Antigravity), incl. a valid thin Antigravity view
 *  - resolves by id AND by a runtime-specific id (claudeSessionId)
 *  - strictly read-only (never prompts / creates / upserts)
 *  - existing /transcript behaviour unchanged when `view` is absent
 */
import { describe, it, expect, vi } from 'vitest';
import type { ServerResponse } from 'http';
import { Writable } from 'stream';
import { createSessionRoutes } from '../../../src/internal-api/routes/sessions.js';
import type { RegistryEntry } from '../../../src/session-registry.js';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

// ─── Mock response helper (mirrors session-routes-orchestration.test.ts) ────────

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

function jsonBody(res: { body: string }): any {
  return JSON.parse(res.body);
}

// ─── Fixture events (flat replay-event shape) ──────────────────────────────────

const FIXTURE_EVENTS = [
  { type: 'message_start', message: { id: 'u1', role: 'user', content: 'List files' }, timestamp: 1000 },
  { type: 'message_end', message: { id: 'u1' }, timestamp: 1000 },
  { type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'ls' }, timestamp: 2000 },
  { type: 'tool_execution_end', toolCallId: 't1', result: { content: [{ type: 'text', text: 'file a\nfile b' }] }, isError: false, timestamp: 2000 },
  { type: 'message_start', message: { id: 'a1', role: 'assistant' }, timestamp: 3000 },
  { type: 'message_update', message: { id: 'a1' }, assistantMessageEvent: { type: 'text_delta', delta: 'Done.' }, timestamp: 3000 },
  { type: 'message_end', message: { id: 'a1' }, timestamp: 3000 },
];

// ─── Route builder ─────────────────────────────────────────────────────────────

function buildRoutes(entries: RegistryEntry[]) {
  const claudeService: any = {
    getReplayEvents: vi.fn().mockResolvedValue(FIXTURE_EVENTS),
    loadSessionHistory: vi.fn().mockResolvedValue([
      { type: 'user', content: 'List files', timestamp: 1000 },
      { type: 'assistant', content: 'Done.', timestamp: 3000 },
    ]),
    isRunning: vi.fn(() => false),
    isAvailable: vi.fn().mockResolvedValue(true),
    sendPrompt: vi.fn(),
    createSession: vi.fn(),
    setModel: vi.fn(),
  };
  const opencodeService: any = {
    getReplayEvents: vi.fn().mockResolvedValue(FIXTURE_EVENTS),
    isRunning: vi.fn(() => false),
    isAvailable: vi.fn().mockResolvedValue(true),
  };
  const antigravityService: any = {
    getReplayEvents: vi.fn().mockResolvedValue(FIXTURE_EVENTS),
    isRunning: vi.fn(() => false),
    isAvailable: vi.fn().mockResolvedValue(true),
  };
  const multiSessionManager: any = {
    prompt: vi.fn(),
    createAndSubscribe: vi.fn(),
    getAgentSession: vi.fn(),
    getAllSessionStatuses: vi.fn(() => []),
  };
  const registry: any = {
    get: vi.fn(async (id: string) => entries.find((e) => e.id === id)),
    listAll: vi.fn(async () => entries),
    getByPath: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
  };
  const piService: any = { setModel: vi.fn() };

  const routes = createSessionRoutes({
    claudeService,
    opencodeService,
    antigravityService,
    multiSessionManager,
    sessionRegistry: registry,
    piService,
    internalClientId: 'test-client',
    watchDir: '/tmp/watch',
  } as any);

  return { routes, claudeService, opencodeService, antigravityService, multiSessionManager, registry };
}

function makeEntry(over: Partial<RegistryEntry>): RegistryEntry {
  return {
    id: 's1',
    sdkType: 'claude',
    path: '/tmp/s.jsonl',
    cwd: '/root/proj',
    firstMessage: 'List files',
    messageCount: 3,
    createdAt: '2026-06-01T00:00:00.000Z',
    lastActivity: '2026-06-01T00:00:05.000Z',
    status: 'idle',
    ...over,
  } as RegistryEntry;
}

async function callScreenView(routes: ReturnType<typeof buildRoutes>['routes'], sid: string, query: string) {
  const res = createMockRes();
  await routes.handleSessionTranscript({} as any, res, sid, new URLSearchParams(query));
  return res;
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('handleSessionTranscript view=screen', () => {
  it('returns a structured ScreenView + markdown for Claude', async () => {
    const { routes } = buildRoutes([makeEntry({ sdkType: 'claude' })]);
    const res = await callScreenView(routes, 's1', 'view=screen');
    expect(res.statusCode).toBe(200);
    const body = jsonBody(res);
    expect(body.view).toBe('screen');
    expect(body.runtime).toBe('claude');
    expect(body.expanded).toEqual({ tools: false, thinking: false });
    expect(Array.isArray(body.screenView.items)).toBe(true);
    expect(body.screenView.itemCount).toBeGreaterThan(0);
    expect(typeof body.markdown).toBe('string');
    expect(body.markdown).toContain('# Screen view');
    expect(body.source.sdkType).toBe('claude');
  });

  it('returns a ScreenView for OpenCode', async () => {
    const { routes } = buildRoutes([makeEntry({ id: 's1', sdkType: 'opencode' })]);
    const res = await callScreenView(routes, 's1', 'view=screen');
    expect(res.statusCode).toBe(200);
    expect(jsonBody(res).runtime).toBe('opencode');
  });

  it('returns a ScreenView for Antigravity (valid, even when thin/empty)', async () => {
    const { routes, antigravityService } = buildRoutes([makeEntry({ id: 's1', sdkType: 'antigravity' })]);
    antigravityService.getReplayEvents.mockResolvedValueOnce([]); // thin session
    const res = await callScreenView(routes, 's1', 'view=screen');
    expect(res.statusCode).toBe(200);
    const body = jsonBody(res);
    expect(body.runtime).toBe('antigravity');
    expect(body.screenView.items).toEqual([]);
    expect(body.screenView.itemCount).toBe(0);
  });

  it('returns a ScreenView for Pi from a real Pi session file', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-screen-'));
    const file = path.join(dir, 'session.jsonl');
    // Pi-native entries: a message envelope + a tool_execution pair.
    await fs.writeFile(
      file,
      [
        JSON.stringify({ type: 'session', id: 'p1', timestamp: '2026-06-01T00:00:00.000Z', cwd: '/x' }),
        JSON.stringify({ type: 'message', id: 'm1', timestamp: '2026-06-01T00:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hello pi' }], timestamp: 1000 } }),
        JSON.stringify({ type: 'message', id: 'm2', timestamp: '2026-06-01T00:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'hi from pi' }], timestamp: 2000 } }),
        JSON.stringify({ type: 'tool_execution_start', toolCallId: 'pt1', toolName: 'read', args: { path: '/a.txt' }, timestamp: 1500 }),
        JSON.stringify({ type: 'tool_execution_end', toolCallId: 'pt1', result: { content: [{ type: 'text', text: 'contents' }] }, isError: false, timestamp: 1600 }),
      ].join('\n') + '\n',
      'utf-8',
    );
    const { routes } = buildRoutes([makeEntry({ id: 's1', sdkType: 'pi', path: file })]);
    const res = await callScreenView(routes, 's1', 'view=screen');
    expect(res.statusCode).toBe(200);
    const body = jsonBody(res);
    expect(body.runtime).toBe('pi');
    const kinds = body.screenView.items.map((i: any) => i.kind);
    expect(kinds).toEqual(expect.arrayContaining(['user', 'assistant', 'tool']));
    const tool = body.screenView.items.find((i: any) => i.kind === 'tool');
    expect(tool.toolName).toBe('read');
    expect(body.markdown).toContain('hello pi');
  });

  it('resolves by a runtime-specific id (claudeSessionId), not just the internal id', async () => {
    const { routes } = buildRoutes([makeEntry({ id: 's1', sdkType: 'claude', claudeSessionId: 'claude-native-xyz' })]);
    const res = await callScreenView(routes, 'claude-native-xyz', 'view=screen');
    expect(res.statusCode).toBe(200);
    expect(jsonBody(res).sessionId).toBe('s1');
  });

  it('404s when no id form matches', async () => {
    const { routes } = buildRoutes([makeEntry({ id: 's1' })]);
    const res = await callScreenView(routes, 'does-not-exist', 'view=screen');
    expect(res.statusCode).toBe(404);
  });

  it('is strictly read-only: never prompts, creates, or upserts', async () => {
    const { routes, claudeService, multiSessionManager, registry } = buildRoutes([makeEntry({ sdkType: 'claude' })]);
    await callScreenView(routes, 's1', 'view=screen&expand=tools,thinking');
    expect(claudeService.sendPrompt).not.toHaveBeenCalled();
    expect(claudeService.createSession).not.toHaveBeenCalled();
    expect(multiSessionManager.prompt).not.toHaveBeenCalled();
    expect(multiSessionManager.createAndSubscribe).not.toHaveBeenCalled();
    expect(registry.upsert).not.toHaveBeenCalled();
  });

  it('expand=tools surfaces tool output; expand=thinking surfaces thinking', async () => {
    const eventsWithThinking = [
      { type: 'message_start', message: { id: 'a1', role: 'assistant' }, timestamp: 1000 },
      { type: 'message_update', message: { id: 'a1' }, assistantMessageEvent: { type: 'thinking', thinking: 'I should list files. Then read them.' } },
      { type: 'message_update', message: { id: 'a1' }, assistantMessageEvent: { type: 'text_delta', delta: 'ok' } },
      { type: 'message_end', message: { id: 'a1' } },
      { type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'ls' } },
      { type: 'tool_execution_end', toolCallId: 't1', result: { content: [{ type: 'text', text: 'secret-output' }] }, isError: false },
    ];
    const { routes, claudeService } = buildRoutes([makeEntry({ sdkType: 'claude' })]);
    claudeService.getReplayEvents.mockResolvedValueOnce(eventsWithThinking);

    const res = await callScreenView(routes, 's1', 'view=screen&expand=tools,thinking');
    const body = jsonBody(res);
    expect(body.expanded).toEqual({ tools: true, thinking: true });
    expect(body.markdown).toContain('secret-output'); // tool output exposed
    const thinking = body.screenView.items.find((i: any) => i.kind === 'thinking');
    expect(thinking.expandedText).toContain('I should list files'); // thinking exposed
  });

  it('regression: with no view param, returns the existing transcript shape (not screenView)', async () => {
    const { routes } = buildRoutes([makeEntry({ sdkType: 'claude' })]);
    const res = await callScreenView(routes, 's1', 'scope=visible_full');
    expect(res.statusCode).toBe(200);
    const body = jsonBody(res);
    expect(body.view).toBeUndefined();
    expect(body.scope).toBe('visible_full');
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.screenView).toBeUndefined();
  });

  it('returns the canonical session id when transcript is requested with a runtime-specific id', async () => {
    const { routes } = buildRoutes([makeEntry({ id: 's1', sdkType: 'claude', claudeSessionId: 'claude-native-xyz' })]);
    const res = await callScreenView(routes, 'claude-native-xyz', 'scope=visible_full');
    expect(res.statusCode).toBe(200);
    expect(jsonBody(res).sessionId).toBe('s1');
  });

  // ─── Pi session-file resolution (directory → .jsonl) ──────────────────────

  it('resolves Pi screen view from a directory by picking the newest .jsonl', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-dir-'));
    // Two .jsonl files with different content — newest should win.
    const olderFile = path.join(dir, 'older.jsonl');
    const newerFile = path.join(dir, 'newer.jsonl');
    await fs.writeFile(
      olderFile,
      JSON.stringify({ type: 'message', id: 'old', timestamp: 1, message: { role: 'user', content: [{ type: 'text', text: 'from older file' }], timestamp: 1 } }) + '\n',
      'utf-8',
    );
    await fs.writeFile(
      newerFile,
      JSON.stringify({ type: 'message', id: 'new', timestamp: 2, message: { role: 'assistant', content: [{ type: 'text', text: 'from newer file' }], timestamp: 2 } }) + '\n',
      'utf-8',
    );
    // Touch newerFile to guarantee it has a higher mtime.
    const newerStat = await fs.stat(newerFile);
    const olderStat = await fs.stat(olderFile);
    // Just in case mtime resolution isn't fine-grained, ensure newer > older
    // by explicitly setting mtimes.
    const now = Date.now();
    await fs.utimes(olderFile, new Date(now - 60000), new Date(now - 60000));
    await fs.utimes(newerFile, new Date(now), new Date(now));

    const { routes } = buildRoutes([makeEntry({ id: 's1', sdkType: 'pi', path: dir })]);
    const res = await callScreenView(routes, 's1', 'view=screen');
    expect(res.statusCode).toBe(200);
    const body = jsonBody(res);
    expect(body.runtime).toBe('pi');
    expect(body.markdown).toContain('from newer file');
    expect(body.markdown).not.toContain('from older file');
  });

  it('returns an empty/thin Pi view when the directory has no .jsonl files', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-empty-'));
    // Directory exists but has no .jsonl files.
    await fs.writeFile(path.join(dir, 'README.txt'), 'not a session', 'utf-8');

    const { routes } = buildRoutes([makeEntry({ id: 's1', sdkType: 'pi', path: dir })]);
    const res = await callScreenView(routes, 's1', 'view=screen');
    expect(res.statusCode).toBe(200);
    const body = jsonBody(res);
    expect(body.runtime).toBe('pi');
    expect(body.screenView.items).toEqual([]);
    expect(body.screenView.itemCount).toBe(0);
  });

  it('returns an empty/thin Pi view when the entry path does not exist', async () => {
    const { routes } = buildRoutes([makeEntry({ id: 's1', sdkType: 'pi', path: '/nonexistent/path/xyz' })]);
    const res = await callScreenView(routes, 's1', 'view=screen');
    expect(res.statusCode).toBe(200);
    const body = jsonBody(res);
    expect(body.runtime).toBe('pi');
    expect(body.screenView.items).toEqual([]);
  });

  it('prefers the active Pi session file when one exists under the entry directory', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-active-'));
    const activeFile = path.join(dir, 'active-session.jsonl');
    const olderFile = path.join(dir, 'older.jsonl');
    await fs.writeFile(
      activeFile,
      JSON.stringify({ type: 'message', id: 'a', message: { role: 'user', content: [{ type: 'text', text: 'from active session' }], timestamp: 1 } }) + '\n',
      'utf-8',
    );
    await fs.writeFile(
      olderFile,
      JSON.stringify({ type: 'message', id: 'o', message: { role: 'user', content: [{ type: 'text', text: 'from older scan' }], timestamp: 1 } }) + '\n',
      'utf-8',
    );
    // Make olderFile newer on disk — but the active session should STILL win.
    const now = Date.now();
    await fs.utimes(olderFile, new Date(now), new Date(now));
    await fs.utimes(activeFile, new Date(now - 60000), new Date(now - 60000));

    const { routes, multiSessionManager } = buildRoutes([makeEntry({ id: 's1', sdkType: 'pi', path: dir })]);
    multiSessionManager.getAllSessionStatuses.mockReturnValue([
      { sessionPath: activeFile, sessionId: 'active-id', status: 'idle', subscriberCount: 0 },
    ]);

    const res = await callScreenView(routes, 's1', 'view=screen');
    expect(res.statusCode).toBe(200);
    const body = jsonBody(res);
    expect(body.runtime).toBe('pi');
    expect(body.markdown).toContain('from active session');
    expect(body.markdown).not.toContain('from older scan');
  });

  it('still works when entry.path is already a .jsonl (direct file, not directory)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-file-'));
    const file = path.join(dir, 'direct.jsonl');
    await fs.writeFile(
      file,
      JSON.stringify({ type: 'message', id: 'd', message: { role: 'assistant', content: [{ type: 'text', text: 'direct file' }], timestamp: 1 } }) + '\n',
      'utf-8',
    );
    // Pass the .jsonl file directly as path (mirrors existing test but confirms
    // the fast path in the resolver).
    const { routes } = buildRoutes([makeEntry({ id: 's1', sdkType: 'pi', path: file })]);
    const res = await callScreenView(routes, 's1', 'view=screen');
    expect(res.statusCode).toBe(200);
    const body = jsonBody(res);
    expect(body.runtime).toBe('pi');
    expect(body.markdown).toContain('direct file');
  });
});
