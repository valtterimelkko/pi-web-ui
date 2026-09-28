import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SessionWatcher, type SessionInfo, type SessionChangeEvent } from '../../../src/pi/session-watcher.js';

function sessionContent(id: string, messageText = 'hello', timestamp = 1): string {
  return [
    JSON.stringify({ type: 'session', id, cwd: '/tmp/session-workspace', timestamp }),
    JSON.stringify({
      type: 'message',
      id: 'message-1',
      timestamp: timestamp + 1,
      message: { role: 'user', content: [{ type: 'text', text: messageText }] },
    }),
  ].join('\n') + '\n';
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

type DebugCounters = {
  debugFullReadCount: number;
  debugBoundedHeaderReadCount: number;
};

describe('SessionWatcher read coalescing', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    vi.useRealTimers();
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it('starts exactly one complete read for N appends inside one quiet window', async () => {
    vi.useFakeTimers();
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'session-watcher-window-'));
    const filePath = path.join(tempDir, 'timestamp_session.jsonl');
    await writeFile(filePath, sessionContent('canonical-session', 'complete prompt'));

    const watcher = new SessionWatcher(tempDir);
    const invoke = watcher as unknown as { handleChange(type: 'change', filePath: string): void };
    const originalRead = watcher.readSessionInfo.bind(watcher);
    const oracle = await originalRead(filePath);
    let readCalls = 0;
    watcher.readSessionInfo = async () => {
      readCalls += 1;
      return oracle;
    };

    const events: SessionChangeEvent[] = [];
    watcher.on('session_update', (event: SessionChangeEvent) => events.push(event));

    for (let notification = 0; notification < 25; notification += 1) {
      invoke.handleChange('change', filePath);
    }
    // No complete-file read while the path is still changing.
    expect(readCalls).toBe(0);

    await vi.advanceTimersByTimeAsync(499); // window not yet closed
    expect(readCalls).toBe(0);

    await vi.advanceTimersByTimeAsync(1); // quiet period reached
    await flushMicrotasks();
    expect(readCalls).toBe(1);

    const counters = watcher as unknown as DebugCounters;
    expect(counters.debugFullReadCount).toBe(1);
    expect(counters.debugBoundedHeaderReadCount).toBe(25);
    expect(events).toHaveLength(1);
    expect(events.at(-1)?.info).toEqual(oracle);

    await watcher.stop();
  });

  it('defers fast repeated invalidations to the debounce window instead of re-reading each notification', async () => {
    vi.useFakeTimers();
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'session-watcher-fast-'));
    const filePath = path.join(tempDir, 'fast-session.jsonl');
    await writeFile(filePath, sessionContent('fast-session', 'fast prompt'));

    const watcher = new SessionWatcher(tempDir);
    const invoke = watcher as unknown as { handleChange(type: 'change', filePath: string): void };
    const oracle = await watcher.readSessionInfo(filePath);
    let readCalls = 0;
    watcher.readSessionInfo = async () => {
      readCalls += 1;
      return oracle;
    };
    const events: SessionChangeEvent[] = [];
    watcher.on('session_update', (event: SessionChangeEvent) => events.push(event));

    for (let notification = 0; notification < 10; notification += 1) {
      invoke.handleChange('change', filePath);
      await flushMicrotasks();
    }
    // Reads are coalesced to the window: none starts while changes still arrive.
    expect(readCalls).toBe(0);

    await vi.advanceTimersByTimeAsync(500);
    await flushMicrotasks();
    expect(readCalls).toBe(1);
    expect(events.at(-1)?.info).toEqual(oracle);

    await watcher.stop();
  });

  it('a change during the window read is covered by the next window, and stop() leaves no state', async () => {
    vi.useFakeTimers();
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'session-watcher-inflight-'));
    const filePath = path.join(tempDir, 'replaceable_session.jsonl');
    await writeFile(filePath, sessionContent('replace-session', 'before change'));

    const watcher = new SessionWatcher(tempDir);
    const invoke = watcher as unknown as {
      handleChange(type: 'add' | 'change' | 'unlink', filePath: string): void;
    };
    const originalRead = watcher.readSessionInfo.bind(watcher);
    const firstRead = deferred<SessionInfo>();
    const secondRead = deferred<SessionInfo>();
    let calls = 0;
    watcher.readSessionInfo = () => {
      calls += 1;
      return calls === 1 ? firstRead.promise : secondRead.promise;
    };
    const events: SessionChangeEvent[] = [];
    watcher.on('session_update', (event: SessionChangeEvent) => events.push(event));

    invoke.handleChange('add', filePath);
    // The read starts only when the window closes, not on the notification.
    expect(calls).toBe(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toBe(1);

    // A change during that read restarts the window; the next window performs
    // the next single read (no trailing read chained from finishRead).
    await appendFile(filePath, JSON.stringify({
      type: 'message',
      id: 'message-2',
      timestamp: 4,
      message: { role: 'assistant', content: [{ type: 'text', text: 'after change' }] },
    }) + '\n');
    invoke.handleChange('change', filePath);
    const changedOracle = await originalRead(filePath);
    firstRead.resolve(changedOracle);
    await flushMicrotasks();
    expect(events).toHaveLength(1);
    expect(events[0]?.info?.messageCount).toBe(changedOracle.messageCount);
    expect(calls).toBe(1);

    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toBe(2);
    secondRead.resolve(changedOracle);
    await flushMicrotasks();
    expect(events).toHaveLength(2);

    const beforeStopState = watcher as unknown as {
      sessionIdsByPath: Map<string, string>;
      readStateByPath: Map<string, unknown>;
      pendingInfoByPath: Map<string, Promise<unknown>>;
    };
    expect(beforeStopState.sessionIdsByPath.get(filePath)).toBe(changedOracle.id);

    // stop() must not let a late read resurrect per-path state.
    const thirdRead = deferred<SessionInfo>();
    watcher.readSessionInfo = () => {
      calls += 1;
      return thirdRead.promise;
    };
    invoke.handleChange('change', filePath);
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toBe(3);
    await watcher.stop();
    thirdRead.resolve(changedOracle);
    await flushMicrotasks();

    expect(beforeStopState.sessionIdsByPath.size).toBe(0);
    expect(beforeStopState.readStateByPath.size).toBe(0);
    expect(beforeStopState.pendingInfoByPath.size).toBe(0);
  });

  it('keeps the bounded header identity for an add-unlink race without ever starting a full read', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'session-watcher-unlink-'));
    const filePath = path.join(tempDir, 'filename-fallback.jsonl');
    await writeFile(filePath, sessionContent('unlink-canonical'));

    const watcher = new SessionWatcher(tempDir);
    const invoke = watcher as unknown as {
      handleChange(type: 'add' | 'unlink', filePath: string): void;
    };
    let readCalls = 0;
    watcher.readSessionInfo = async () => {
      readCalls += 1;
      throw new Error('a full read must not start for an add-unlink inside the window');
    };
    const events: SessionChangeEvent[] = [];
    watcher.on('session_update', (event: SessionChangeEvent) => events.push(event));

    invoke.handleChange('add', filePath);
    await rm(filePath);
    invoke.handleChange('unlink', filePath);
    await flushMicrotasks();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'unlink', sessionId: 'unlink-canonical' });
    expect(readCalls).toBe(0);
    const counters = watcher as unknown as DebugCounters;
    expect(counters.debugBoundedHeaderReadCount).toBe(1);
    await watcher.stop();
  });

  it('emits fresh metadata when a window closes while a slow read is still in flight', async () => {
    vi.useFakeTimers();
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'session-watcher-stale-'));
    const filePath = path.join(tempDir, 'stale_session.jsonl');
    await writeFile(filePath, sessionContent('stale-session', 'v1'));

    const watcher = new SessionWatcher(tempDir);
    const invoke = watcher as unknown as { handleChange(type: 'change', filePath: string): void };
    const originalRead = watcher.readSessionInfo.bind(watcher);
    const staleOracle = await originalRead(filePath);
    await appendFile(filePath, JSON.stringify({
      type: 'message',
      id: 'message-2',
      timestamp: 4,
      message: { role: 'assistant', content: [{ type: 'text', text: 'v2' }] },
    }) + '\n');
    const freshOracle = await originalRead(filePath);
    expect(freshOracle.messageCount).toBeGreaterThan(staleOracle.messageCount);

    const firstRead = deferred<SessionInfo>();
    const secondRead = deferred<SessionInfo>();
    let calls = 0;
    watcher.readSessionInfo = () => {
      calls += 1;
      return calls === 1 ? firstRead.promise : secondRead.promise;
    };
    const events: SessionChangeEvent[] = [];
    watcher.on('session_update', (event: SessionChangeEvent) => events.push(event));

    invoke.handleChange('change', filePath); // window #1
    await vi.advanceTimersByTimeAsync(500); // closes; read #1 starts and stays pending
    expect(calls).toBe(1);

    invoke.handleChange('change', filePath); // window #2 while read #1 is pending
    await vi.advanceTimersByTimeAsync(500); // window #2 closes and joins read #1
    expect(calls).toBe(1);

    firstRead.resolve(staleOracle);
    await flushMicrotasks();
    // The window that joined the stale read must not strand its invalidation.
    expect(calls).toBe(2);
    secondRead.resolve(freshOracle);
    await flushMicrotasks();

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.at(-1)?.info?.messageCount).toBe(freshOracle.messageCount);
    const state = (watcher as unknown as { readStateByPath: Map<string, { revalidateQueued: boolean }> })
      .readStateByPath.get(filePath);
    expect(state?.revalidateQueued).toBe(false);
    await watcher.stop();
  });

  it('uses the newest captured header id for a same-path replacement unlink', async () => {
    vi.useFakeTimers();
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'session-watcher-replace-'));
    const filePath = path.join(tempDir, 'replacement.jsonl');
    await writeFile(filePath, sessionContent('old-header-id', 'old'));

    const watcher = new SessionWatcher(tempDir);
    const invoke = watcher as unknown as {
      handleChange(type: 'add' | 'change' | 'unlink', filePath: string): void;
    };
    const firstRead = deferred<SessionInfo>();
    watcher.readSessionInfo = () => firstRead.promise;
    const events: SessionChangeEvent[] = [];
    watcher.on('session_update', (event: SessionChangeEvent) => events.push(event));

    invoke.handleChange('add', filePath);
    await vi.advanceTimersByTimeAsync(500); // read #1 starts and stays pending

    // A same-path replacement captures a new id while read #1 is still pending.
    await writeFile(filePath, sessionContent('new-header-id', 'new'));
    invoke.handleChange('change', filePath);

    // Read #1 resolves with the OLD id afterwards; it must not overwrite the
    // freshly captured identity (B1.1 correction 03).
    firstRead.resolve({
      id: 'old-header-id',
      path: filePath,
      cwd: '/tmp/session-workspace',
      firstMessage: 'old',
      messageCount: 1,
      createdAt: new Date(1),
      lastActivity: new Date(2),
    });
    await flushMicrotasks();

    await rm(filePath);
    invoke.handleChange('unlink', filePath);
    await flushMicrotasks();

    expect(events.find((event) => event.type === 'unlink')?.sessionId).toBe('new-header-id');
    await watcher.stop();
  });

  it('emits no sessionId for an unlink whose name is not a valid Pi session file', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'session-watcher-partial-'));
    // No `_<id>.jsonl` suffix: piSessionIdFromFilename cannot derive an id and
    // no header was captured, so the unlink deliberately carries no sessionId
    // (correction 04 — a valid `timestamp_<uuid>.jsonl` name does carry one).
    const filePath = path.join(tempDir, 'partial-header.jsonl');
    await writeFile(filePath, '{"type":"sess'); // truncated header, parse fails

    const watcher = new SessionWatcher(tempDir);
    const invoke = watcher as unknown as { handleChange(type: 'add' | 'unlink', filePath: string): void };
    const events: Array<{ type: string; sessionId?: string }> = [];
    watcher.on('session_update', (event) => events.push(event));

    invoke.handleChange('add', filePath);
    await rm(filePath);
    invoke.handleChange('unlink', filePath);
    await flushMicrotasks();

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('unlink');
    expect(events[0]?.sessionId).toBeUndefined();
    await watcher.stop();
  });

  it('emits unlink with the captured id immediately during an in-flight read and clears pendingInfoByPath', async () => {
    vi.useFakeTimers();
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'session-watcher-pending-unlink-'));
    const filePath = path.join(tempDir, 'pending-unlink.jsonl');
    await writeFile(filePath, sessionContent('pending-unlink-id', 'x'));

    const watcher = new SessionWatcher(tempDir);
    const invoke = watcher as unknown as { handleChange(type: 'add' | 'unlink', filePath: string): void };
    const pendingRead = deferred<SessionInfo>();
    let calls = 0;
    watcher.readSessionInfo = () => {
      calls += 1;
      return pendingRead.promise;
    };
    const events: SessionChangeEvent[] = [];
    watcher.on('session_update', (event: SessionChangeEvent) => events.push(event));

    invoke.handleChange('add', filePath);
    await vi.advanceTimersByTimeAsync(500); // window closes, read starts and stays pending
    expect(calls).toBe(1);
    const maps = watcher as unknown as {
      pendingInfoByPath: Map<string, unknown>;
      readStateByPath: Map<string, unknown>;
    };
    expect(maps.pendingInfoByPath.size).toBe(1);

    await rm(filePath);
    invoke.handleChange('unlink', filePath);
    await flushMicrotasks();

    // The obsolete read must not delay the unlink; the projection is dropped now.
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'unlink', sessionId: 'pending-unlink-id' });
    expect(maps.pendingInfoByPath.size).toBe(0);

    pendingRead.resolve({
      id: 'pending-unlink-id',
      path: filePath,
      cwd: '/tmp/session-workspace',
      firstMessage: 'x',
      messageCount: 1,
      createdAt: new Date(1),
      lastActivity: new Date(2),
    });
    await flushMicrotasks();
    expect(maps.readStateByPath.size).toBe(0);
    await watcher.stop();
  });
});

describe('SessionWatcher real chokidar path', () => {
  let tempDir: string | undefined;
  let watcher: SessionWatcher | undefined;

  afterEach(async () => {
    if (watcher) await watcher.stop();
    watcher = undefined;
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it('observes a real temp-file append with complete metadata and bounded full reads', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'session-watcher-real-'));
    watcher = new SessionWatcher(tempDir);
    const events: SessionChangeEvent[] = [];
    const nextEvent = (): Promise<SessionChangeEvent> => new Promise((resolve) => {
      const listener = (event: SessionChangeEvent) => {
        events.push(event);
        watcher?.off('session_update', listener);
        resolve(event);
      };
      watcher?.on('session_update', listener);
    });

    watcher.start();
    const nativeWatcher = (watcher as unknown as { watcher: { once(event: string, listener: () => void): void } | null }).watcher;
    await new Promise<void>((resolve) => nativeWatcher?.once('ready', resolve));
    const filePath = path.join(tempDir, 'real-session.jsonl');
    const addEvent = nextEvent();
    await writeFile(filePath, sessionContent('real-session', 'real initial prompt'));
    const added = await addEvent;

    const changeEvent = nextEvent();
    await appendFile(filePath, JSON.stringify({
      type: 'message',
      id: 'real-message-2',
      timestamp: 4,
      message: { role: 'assistant', content: [{ type: 'text', text: 'real append' }] },
    }) + '\n');
    const changed = await changeEvent;

    const oracle = await new SessionWatcher(tempDir).readSessionInfo(filePath);
    const counters = watcher as unknown as DebugCounters;
    expect(added.info).toBeTruthy();
    expect(changed.info).toEqual(oracle);
    expect(changed.info?.messageCount).toBe(2);
    expect(counters.debugFullReadCount).toBeLessThanOrEqual(2);
    expect(counters.debugBoundedHeaderReadCount).toBeGreaterThanOrEqual(2);
    expect(events).toHaveLength(2);
  });
});

describe('coalesced reads across malformed lines and file replacement', () => {
  let malformedDir: string;
  afterEach(async () => {
    if (malformedDir) await rm(malformedDir, { recursive: true, force: true });
  });

  async function drainUntil(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
    // Time-bounded drain: setImmediate rounds alone can outrun pending fs
    // I/O on loaded CI runners (thousands of immediates pass while one disk
    // read is still in flight), so interleave real timer turns and use a
    // wall-clock deadline rather than a spin count.
    const deadline = Date.now() + timeoutMs;
    let spin = 0;
    while (!condition() && Date.now() < deadline) {
      await new Promise((resolve) => {
        spin += 1;
        if (spin % 10 === 0) setTimeout(resolve, 10);
        else setImmediate(resolve);
      });
    }
  }

  it('keeps oracle-equal metadata for a partial last line, then a full replacement', async () => {
    malformedDir = await mkdtemp(path.join(os.tmpdir(), 'session-watcher-malformed-'));
    const filePath = path.join(malformedDir, 'malformed_session.jsonl');
    await writeFile(filePath, `${sessionContent('malformed-session', 'first turn').trimEnd()}\n{"type":"mess`);

    const watcher = new SessionWatcher(malformedDir, undefined, { debounceDelay: 5 });
    const invoke = watcher as unknown as {
      handleChange(type: 'add' | 'change', filePath: string): void;
    };
    const events: SessionChangeEvent[] = [];
    watcher.on('session_update', (event: SessionChangeEvent) => events.push(event));

    invoke.handleChange('add', filePath);
    // Drain on the OBSERVABLE FACT (an emit with the parsed session id), not
    // on an event count that can race the debounce timer on slow runners.
    await drainUntil(() => events.some((event) => event.info?.id === 'malformed-session'));
    expect(events.some((event) => event.info?.id === 'malformed-session')).toBe(true);

    await writeFile(filePath, sessionContent('malformed-session', 'replaced content'));
    invoke.handleChange('change', filePath);
    await drainUntil(() => events.some((event) => event.info?.firstMessage?.includes('replaced content')));
    const replacedInfo = events.filter((event) => event.info?.firstMessage?.includes('replaced content')).at(-1)?.info;
    expect(replacedInfo?.id).toBe('malformed-session');
    expect(replacedInfo?.firstMessage).toContain('replaced content');
    // Two notification windows: one initial read plus at most one trailing
    // re-read each, matching the coalescing bound.
    expect(watcher.debugFullReadCount).toBeLessThanOrEqual(4);
    await watcher.stop();
  }, 10_000);
});
