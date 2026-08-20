import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { CommandCodeProcessRunner } from '../../../src/command-code/command-code-process-runner.js';

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  child.pid = 4242;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  return child;
}

describe('Command Code process runner', () => {
  it('spawns exactly one absolute-executable process without a shell and writes then closes stdin', async () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    const runner = new CommandCodeProcessRunner({
      executablePath: '/opt/bin/cmd',
      nativeHomeDir: '/tmp/private-command-code-home',
      spawn,
      maxWallTimeMs: 1000,
    });
    const resultPromise = runner.run({
      sessionId: 's1',
      cwd: '/tmp/worktree',
      model: 'qwen/qwen3.8-max',
      maxTurns: 1,
      prompt: 'say ok',
    });
    await new Promise((resolve) => setImmediate(resolve));
    child.stdout.write('{"type":"result","subtype":"success","sessionId":"native-1","finalText":"ok"}\n');
    await new Promise((resolve) => setImmediate(resolve));
    child.emit('close', 0, null);
    const result = await resultPromise;

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith('/opt/bin/cmd', expect.any(Array), expect.objectContaining({ shell: false, detached: true, cwd: '/tmp/worktree', env: expect.objectContaining({ HOME: '/tmp/private-command-code-home/s1' }) }));
    const argv = spawn.mock.calls[0]?.[1] ?? [];
    expect(argv).toEqual([
      '-p', '--output-format', 'json', '--model', 'qwen/qwen3.8-max',
      '--max-turns', '1', '--trust', '--skip-onboarding', '--no-auto-update', '--yolo',
    ]);
    expect(argv).not.toContain('--continue');
    expect(child.stdin.writableEnded).toBe(true);
    expect(result.parsed?.terminal.subtype).toBe('success');
  });

  it('turns an asynchronous stdin EPIPE into a bounded run error', async () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    const runner = new CommandCodeProcessRunner({ executablePath: '/opt/bin/cmd', spawn, maxWallTimeMs: 1000 });
    const resultPromise = runner.run({
      sessionId: 's-epipe', cwd: '/tmp', model: 'qwen/qwen3.8-max', maxTurns: 1,
      prompt: 'say ok',
    });
    child.stdin.emit('error', new Error('write EPIPE'));
    child.emit('close', null, 'SIGTERM');
    await expect(resultPromise).resolves.toMatchObject({ spawnError: 'write EPIPE' });
  });

  it('waits for close so stdout delivered after exit is still parsed', async () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    const runner = new CommandCodeProcessRunner({ executablePath: '/opt/bin/cmd', spawn, maxWallTimeMs: 1000 });
    const resultPromise = runner.run({
      sessionId: 's-close', cwd: '/tmp', model: 'qwen/qwen3.8-max', maxTurns: 1,
      prompt: 'say ok',
    });
    child.emit('exit', 0, null);
    child.stdout.write('{"type":"result","subtype":"success","sessionId":"native-close","finalText":"ok"}\n');
    await new Promise((resolve) => setImmediate(resolve));
    child.emit('close', 0, null);
    await expect(resultPromise).resolves.toMatchObject({ parsed: { terminal: { subtype: 'success', sessionId: 'native-close' } } });
  });

  it('rejects oversized prompt bytes before spawning', () => {
    const spawn = vi.fn();
    const runner = new CommandCodeProcessRunner({ executablePath: '/opt/bin/cmd', spawn, maxPromptBytes: 3 });
    expect(() => runner.run({
      sessionId: 's1', cwd: '/tmp', model: 'qwen/qwen3.8-max', maxTurns: 1,
      prompt: 'toolong',
    })).toThrow(/prompt exceeds/i);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('terminates the whole process group and escalates after the grace period', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const runner = new CommandCodeProcessRunner({ executablePath: '/opt/bin/cmd', spawn, processGraceMs: 25 });
    const promise = runner.run({
      sessionId: 's1', cwd: '/tmp', model: 'qwen/qwen3.8-max', maxTurns: 1,
      prompt: 'wait',
    });
    await Promise.resolve();
    const abortPromise = runner.abort('s1');
    expect(kill).toHaveBeenCalledWith(-4242, 'SIGTERM');
    vi.advanceTimersByTime(25);
    expect(kill).toHaveBeenCalledWith(-4242, 'SIGKILL');
    child.emit('close', null, 'SIGKILL');
    await abortPromise;
    await promise;
    kill.mockRestore();
    vi.useRealTimers();
  });

  it('keeps an actively streaming child alive past the wall-time limit (inactivity semantics)', async () => {
    // A long-running turn that keeps producing output must not be killed by a
    // total-duration cap; the wall clock is an inactivity bound, resetting on
    // every stdout chunk.
    vi.useFakeTimers();
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const runner = new CommandCodeProcessRunner({ executablePath: '/opt/bin/cmd', spawn, maxWallTimeMs: 1_000 });
    const promise = runner.run({
      sessionId: 's-active', cwd: '/tmp', model: 'qwen/qwen3.8-max', maxTurns: 1,
      prompt: 'stream for a long time',
    });
    await Promise.resolve();
    const line = (delta: string) => JSON.stringify({ type: 'event', event: { type: 'text_delta', messageId: 'm', delta } }) + '\n';
    // 5 seconds of wall time (5x the limit) with output every 200ms.
    for (let elapsed = 0; elapsed <= 5_000; elapsed += 200) {
      vi.advanceTimersByTime(200);
      child.stdout.write(line('x'));
      await Promise.resolve();
    }
    expect(kill).not.toHaveBeenCalled();
    child.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', sessionId: 'native-1', finalText: 'done' }) + '\n');
    child.emit('close', 0, null);
    const result = await promise;
    expect(result.terminationCause).toBeUndefined();
    expect(result.parsed?.terminal.subtype).toBe('success');
    kill.mockRestore();
    vi.useRealTimers();
  });

  it('terminates a child that falls silent for the full wall-time limit', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const runner = new CommandCodeProcessRunner({ executablePath: '/opt/bin/cmd', spawn, maxWallTimeMs: 1_000 });
    const promise = runner.run({
      sessionId: 's-silent', cwd: '/tmp', model: 'qwen/qwen3.8-max', maxTurns: 1,
      prompt: 'hang',
    });
    await Promise.resolve();
    // One early chunk, then silence well past the limit.
    child.stdout.write(JSON.stringify({ type: 'event', event: { type: 'text_delta', messageId: 'm', delta: 'x' } }) + '\n');
    await Promise.resolve();
    vi.advanceTimersByTime(2_000);
    expect(kill).toHaveBeenCalledWith(-4242, 'SIGTERM');
    child.emit('close', null, 'SIGTERM');
    const result = await promise;
    expect(result.terminationCause).toBe('timeout');
    kill.mockRestore();
    vi.useRealTimers();
  });
});
