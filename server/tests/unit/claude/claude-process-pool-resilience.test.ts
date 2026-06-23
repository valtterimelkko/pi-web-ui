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
const RESULT_EMPTY = JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: false, result: '', usage: { input_tokens: 0, output_tokens: 0 }, session_id: 's' });
const ASSISTANT_TEXT = JSON.stringify({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'OK' }] } });

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe('ClaudeProcessPool transient resilience', () => {
  let tmpDir: string;
  let pool: ClaudeProcessPool;
  const savedEnv: Record<string, string | undefined> = {};

  function setEnv(vars: Record<string, string>) {
    for (const [k, v] of Object.entries(vars)) { savedEnv[k] = process.env[k]; process.env[k] = v; }
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'claude-pool-resil-'));
    pool = new ClaudeProcessPool(10, 0); // postExitGraceMs=0 so retries are fast
    spawnMock.mockReset();
    setEnv({ CLAUDE_TRANSIENT_BASE_DELAY_MS: '1', CLAUDE_TRANSIENT_MAX_DELAY_MS: '2' });
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const opts = (cwd: string) => ({
    sessionId: 'sess', claudeSessionId: 'claude-sess', cwd, model: 'opus', prompt: 'hi',
  });

  it('surfaces a silent empty (0-token) result as an error', async () => {
    setEnv({ CLAUDE_TRANSIENT_MAX_RETRIES: '0' });
    const proc = makeProc();
    spawnMock.mockImplementation(() => proc);

    let completionError: Error | undefined;
    const events: any[] = [];
    pool.spawn(opts(tmpDir), (e) => events.push(e), (err) => { completionError = err; });

    await tick();
    proc.stdout.write(RESULT_EMPTY + '\n');
    await tick();
    proc.emit('exit', 0, null);
    await tick(20);

    expect(completionError).toBeDefined();
    expect(completionError?.message).toMatch(/empty response/i);
    expect(events.some((e) => e.type === 'agent_end')).toBe(false);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('retries on a transient stderr failure and then succeeds', async () => {
    setEnv({ CLAUDE_TRANSIENT_MAX_RETRIES: '2' });
    const proc1 = makeProc();
    const proc2 = makeProc();
    const queue = [proc1, proc2];
    spawnMock.mockImplementation(() => queue.shift());

    let completionError: Error | undefined;
    let completed = false;
    const events: any[] = [];
    pool.spawn(opts(tmpDir), (e) => events.push(e), (err) => { completionError = err; completed = true; });

    await tick();
    // First attempt: overloaded, non-zero exit
    proc1.stderr.write('API Error: 529 {"type":"overloaded_error","message":"Overloaded"}\n');
    await tick();
    proc1.emit('exit', 1, null);

    // Wait for backoff + retry spawn
    await tick(30);
    expect(spawnMock).toHaveBeenCalledTimes(2);

    // Second attempt: success
    proc2.stdout.write(ASSISTANT_TEXT + '\n');
    proc2.stdout.write(RESULT_OK + '\n');
    await tick();
    proc2.emit('exit', 0, null);
    await tick(20);

    expect(completed).toBe(true);
    expect(completionError).toBeUndefined();
    expect(events.some((e) => e.type === 'agent_end')).toBe(true);
  });

  it('does NOT retry a permanent error', async () => {
    setEnv({ CLAUDE_TRANSIENT_MAX_RETRIES: '2' });
    const proc = makeProc();
    spawnMock.mockImplementation(() => proc);

    let completionError: Error | undefined;
    pool.spawn(opts(tmpDir), () => {}, (err) => { completionError = err; });

    await tick();
    proc.stderr.write('Invalid API key\n');
    await tick();
    proc.emit('exit', 1, null);
    await tick(30);

    expect(completionError).toBeDefined();
    expect(completionError?.message).toMatch(/code=1/);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('completes cleanly on a normal result with content', async () => {
    setEnv({ CLAUDE_TRANSIENT_MAX_RETRIES: '2' });
    const proc = makeProc();
    spawnMock.mockImplementation(() => proc);

    let completionError: Error | undefined;
    let completed = false;
    const events: any[] = [];
    pool.spawn(opts(tmpDir), (e) => events.push(e), (err) => { completionError = err; completed = true; });

    await tick();
    proc.stdout.write(ASSISTANT_TEXT + '\n');
    proc.stdout.write(RESULT_OK + '\n');
    await tick();
    proc.emit('exit', 0, null);
    await tick(20);

    expect(completed).toBe(true);
    expect(completionError).toBeUndefined();
    expect(events.some((e) => e.type === 'agent_end')).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});
