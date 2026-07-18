import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('child_process', async () => {
  const spawnMock = vi.fn();
  const execSyncMock = vi.fn(() => 'claude');
  return { spawn: spawnMock, execSync: execSyncMock, default: { spawn: spawnMock, execSync: execSyncMock } };
});

import { ClaudeProcessPool } from '../../../src/claude/claude-process-pool.js';
import { spawn } from 'child_process';

const spawnMock = spawn as unknown as ReturnType<typeof vi.fn>;

function makeProc() {
  const proc = new EventEmitter() as any;
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.stdin = new PassThrough();
  proc.pid = Math.floor(Math.random() * 100000);
  proc.kill = vi.fn(() => true);
  return proc;
}

const RESULT_OK = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'OK', usage: { input_tokens: 100, output_tokens: 5 }, session_id: 's' });
const ASSISTANT_TEXT = JSON.stringify({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'OK' }] } });

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

/**
 * L4: ClaudeProcessPool retry timers must be disposable — abort during a
 * transient-retry backoff cancels the pending respawn, no retry schedules after
 * abort, and completed turns leave no retry timers behind.
 */
describe('L4: ClaudeProcessPool disposable retry timers', () => {
  let tmpDir: string;
  let pool: ClaudeProcessPool;
  const savedEnv: Record<string, string | undefined> = {};

  function setEnv(vars: Record<string, string>) {
    for (const [k, v] of Object.entries(vars)) { savedEnv[k] = process.env[k]; process.env[k] = v; }
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'claude-pool-abort-'));
    pool = new ClaudeProcessPool(10, 0);
    spawnMock.mockReset();
  });

  afterEach(() => {
    pool.dispose();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const opts = (cwd: string) => ({
    sessionId: 'sess', claudeSessionId: 'claude-sess', cwd, model: 'opus', prompt: 'hi',
  });

  it('abort during a transient-retry backoff cancels the pending respawn and settles once', async () => {
    setEnv({ CLAUDE_TRANSIENT_MAX_RETRIES: '3', CLAUDE_TRANSIENT_BASE_DELAY_MS: '60', CLAUDE_TRANSIENT_MAX_DELAY_MS: '120' });
    const proc1 = makeProc();
    spawnMock.mockImplementation(() => proc1);
    const onComplete = vi.fn();

    pool.spawn(opts(tmpDir), () => {}, onComplete);

    await tick();
    proc1.stderr.write('API Error: 529 {"type":"overloaded_error","message":"Overloaded"}\n');
    await tick();
    proc1.emit('exit', 1, null); // schedules a transient retry (~60-120ms)
    await tick(10);               // let the retry timer register

    // Abort BEFORE the retry fires.
    pool.abort('sess');
    await tick(200);              // well past the original backoff

    expect(spawnMock).toHaveBeenCalledTimes(1); // no respawn
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect((pool as any).retryTimers.size).toBe(0);
  });

  it('abort after a retry timer fires but during exit grace prevents the respawn', async () => {
    pool = new ClaudeProcessPool(10, 100);
    setEnv({ CLAUDE_TRANSIENT_MAX_RETRIES: '2', CLAUDE_TRANSIENT_BASE_DELAY_MS: '1', CLAUDE_TRANSIENT_MAX_DELAY_MS: '1' });
    const proc1 = makeProc();
    const proc2 = makeProc();
    spawnMock.mockImplementationOnce(() => proc1).mockImplementationOnce(() => proc2);
    const onComplete = vi.fn();

    pool.spawn(opts(tmpDir), () => {}, onComplete);
    await tick();
    proc1.stderr.write('API Error: 529 {"type":"overloaded_error","message":"Overloaded"}\n');
    await tick();
    proc1.emit('exit', 1, null);
    await tick(20); // retry callback has fired and is waiting in post-exit grace

    pool.abort('sess');
    await tick(150);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('a fresh turn after abort can spawn again (abort does not poison the session)', async () => {
    setEnv({ CLAUDE_TRANSIENT_MAX_RETRIES: '3', CLAUDE_TRANSIENT_BASE_DELAY_MS: '60', CLAUDE_TRANSIENT_MAX_DELAY_MS: '120' });
    const proc1 = makeProc();
    spawnMock.mockImplementation(() => proc1);
    pool.spawn(opts(tmpDir), () => {}, () => {});
    await tick();
    proc1.stderr.write('API Error: 529 {"type":"overloaded_error","message":"Overloaded"}\n');
    await tick();
    proc1.emit('exit', 1, null);
    await tick(10);
    pool.abort('sess');
    await tick(100);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    // New turn clears the abort flag and spawns afresh.
    const proc2 = makeProc();
    spawnMock.mockImplementation(() => proc2);
    pool.spawn(opts(tmpDir), () => {}, () => {});
    await tick();
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('does not retain or re-settle a retry callback after its timer fires', async () => {
    vi.useFakeTimers();
    try {
      const firedFirst = vi.fn();
      const cancelledFirst = vi.fn();
      const cancelledSecond = vi.fn();
      const internals = pool as unknown as {
        scheduleRetry: (sessionId: string, delayMs: number, run: () => void, cancel: () => void) => void;
        retryCancelCallbacks: Map<string, Map<NodeJS.Timeout, () => void>>;
      };
      const scheduleRetry = internals.scheduleRetry.bind(pool);

      scheduleRetry('sess', 10, firedFirst, cancelledFirst);
      scheduleRetry('sess', 20, vi.fn(), cancelledSecond);
      await vi.advanceTimersByTimeAsync(10);

      expect(firedFirst).toHaveBeenCalledTimes(1);
      pool.abort('sess');

      expect(cancelledFirst).not.toHaveBeenCalled();
      expect(cancelledSecond).toHaveBeenCalledTimes(1);
      expect(internals.retryCancelCallbacks.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves no retry timers after a completed transient-retry turn', async () => {
    setEnv({ CLAUDE_TRANSIENT_MAX_RETRIES: '2', CLAUDE_TRANSIENT_BASE_DELAY_MS: '1', CLAUDE_TRANSIENT_MAX_DELAY_MS: '2' });
    const proc1 = makeProc();
    const proc2 = makeProc();
    const queue = [proc1, proc2];
    spawnMock.mockImplementation(() => queue.shift());

    let completed = false;
    pool.spawn(opts(tmpDir), () => {}, () => { completed = true; });
    await tick();
    proc1.stderr.write('API Error: 529 {"type":"overloaded_error","message":"Overloaded"}\n');
    await tick();
    proc1.emit('exit', 1, null);
    await tick(30); // retry fires
    proc2.stdout.write(ASSISTANT_TEXT + '\n');
    proc2.stdout.write(RESULT_OK + '\n');
    await tick();
    proc2.emit('exit', 0, null);
    await tick(20);

    expect(completed).toBe(true);
    expect((pool as any).retryTimers.size).toBe(0);
    expect((pool as any).aborted.size).toBe(0);
  });
});
