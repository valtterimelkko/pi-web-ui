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

  it('coalesces ten notifications per controlled debounce burst and preserves complete metadata', async () => {
    vi.useFakeTimers();
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'session-watcher-coalesce-'));
    const filePath = path.join(tempDir, 'timestamp_session.jsonl');
    await writeFile(filePath, sessionContent('canonical-session', 'complete prompt'));

    const watcher = new SessionWatcher(tempDir);
    const invoke = watcher as unknown as { handleChange(type: 'change', filePath: string): void };
    const originalRead = watcher.readSessionInfo.bind(watcher);
    const oracle = await originalRead(filePath);
    const gates = Array.from({ length: 20 }, () => deferred<void>());
    let readCalls = 0;
    watcher.readSessionInfo = async (file) => {
      const gate = gates[readCalls];
      readCalls += 1;
      if (!gate) throw new Error(`unexpected read ${readCalls}`);
      await gate.promise;
      // The complete-file oracle is computed by the production parser above;
      // the latch controls only when each coalesced read is allowed to finish.
      return oracle;
    };

    const events: SessionChangeEvent[] = [];
    watcher.on('session_update', (event: SessionChangeEvent) => events.push(event));

    for (let burst = 0; burst < 10; burst += 1) {
      for (let notification = 0; notification < 10; notification += 1) {
        invoke.handleChange('change', filePath);
      }
      expect(readCalls).toBe(burst * 2 + 1);

      gates[burst * 2].resolve();
      await flushMicrotasks();
      expect(readCalls).toBe(burst * 2 + 2);

      gates[burst * 2 + 1].resolve();
      await vi.advanceTimersByTimeAsync(500);
      await flushMicrotasks();
    }

    const counters = watcher as unknown as DebugCounters;
    expect(counters.debugFullReadCount).toBe(20);
    expect(counters.debugBoundedHeaderReadCount).toBe(100);
    expect(events).toHaveLength(10);
    expect(events.at(-1)?.info).toEqual(oracle);
    expect(readCalls).toBe(20);

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
    expect(readCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(500);
    await flushMicrotasks();
    expect(readCalls).toBe(2);
    expect(events.at(-1)?.info).toEqual(oracle);

    await watcher.stop();
  });

  it('uses one trailing read for a change during an in-flight read and does not resurrect state after stop', async () => {
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
    await appendFile(filePath, JSON.stringify({
      type: 'message',
      id: 'message-2',
      timestamp: 4,
      message: { role: 'assistant', content: [{ type: 'text', text: 'after change' }] },
    }) + '\n');
    invoke.handleChange('change', filePath);
    expect(calls).toBe(1);

    const changedOracle = await originalRead(filePath);
    firstRead.resolve(changedOracle);
    await flushMicrotasks();
    expect(calls).toBe(2);
    secondRead.resolve(changedOracle);
    await vi.advanceTimersByTimeAsync(500);
    await flushMicrotasks();

    expect(events).toHaveLength(1);
    expect(events[0]?.info).toEqual(changedOracle);
    expect(events[0]?.info?.messageCount).toBe(changedOracle.messageCount);

    const beforeStopState = watcher as unknown as {
      sessionIdsByPath: Map<string, string>;
      readStateByPath: Map<string, unknown>;
      pendingInfoByPath: Map<string, Promise<unknown>>;
    };
    expect(beforeStopState.sessionIdsByPath.get(filePath)).toBe(changedOracle.id);

    const thirdRead = deferred<SessionInfo>();
    watcher.readSessionInfo = () => {
      calls += 1;
      return thirdRead.promise;
    };
    invoke.handleChange('change', filePath);
    expect(calls).toBe(3);
    await watcher.stop();
    thirdRead.resolve(changedOracle);
    await flushMicrotasks();

    expect(beforeStopState.sessionIdsByPath.size).toBe(0);
    expect(beforeStopState.readStateByPath.size).toBe(0);
    expect(beforeStopState.pendingInfoByPath.size).toBe(0);
  });

  it('keeps the bounded header identity for an add-unlink race while the full read is pending', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'session-watcher-unlink-'));
    const filePath = path.join(tempDir, 'filename-fallback.jsonl');
    await writeFile(filePath, sessionContent('unlink-canonical'));

    const watcher = new SessionWatcher(tempDir);
    const invoke = watcher as unknown as {
      handleChange(type: 'add' | 'unlink', filePath: string): void;
    };
    const pendingRead = deferred<SessionInfo>();
    watcher.readSessionInfo = () => pendingRead.promise;
    const events: SessionChangeEvent[] = [];
    watcher.on('session_update', (event: SessionChangeEvent) => events.push(event));

    invoke.handleChange('add', filePath);
    await rm(filePath);
    invoke.handleChange('unlink', filePath);
    pendingRead.resolve({
      id: 'unlink-canonical',
      path: filePath,
      cwd: '/tmp/session-workspace',
      firstMessage: 'hello',
      messageCount: 2,
      createdAt: new Date(1),
      lastActivity: new Date(2),
    });
    await flushMicrotasks();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'unlink', sessionId: 'unlink-canonical' });
    const counters = watcher as unknown as DebugCounters;
    expect(counters.debugBoundedHeaderReadCount).toBe(1);
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

  async function drainUntil(condition: () => boolean, rounds = 2000): Promise<void> {
    for (let spin = 0; spin < rounds && !condition(); spin++) {
      await new Promise((resolve) => setImmediate(resolve));
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
