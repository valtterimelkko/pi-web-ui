import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
  it('spawns the absolute executable without a shell and writes then closes stdin', async () => {
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
      permissionProfile: 'agent-os-7f-root-readonly',
      prompt: 'say ok',
    });
    await new Promise((resolve) => setImmediate(resolve));
    child.stdout.write('{"type":"result","subtype":"success","sessionId":"native-1","finalText":"ok"}\n');
    await new Promise((resolve) => setImmediate(resolve));
    child.emit('close', 0, null);
    const result = await resultPromise;

    expect(spawn).toHaveBeenCalledWith('/opt/bin/cmd', expect.any(Array), expect.objectContaining({ shell: false, detached: true, cwd: '/tmp/worktree', env: expect.objectContaining({ HOME: '/tmp/private-command-code-home/s1' }) }));
    expect(spawn.mock.calls[0]?.[1]).not.toContain('--continue');
    expect(child.stdin.writableEnded).toBe(true);
    expect(result.parsed?.terminal.subtype).toBe('success');
  });

  it('turns an asynchronous stdin EPIPE into a bounded run error', async () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    const runner = new CommandCodeProcessRunner({ executablePath: '/opt/bin/cmd', spawn, maxWallTimeMs: 1000 });
    const resultPromise = runner.run({
      sessionId: 's-epipe', cwd: '/tmp', model: 'qwen/qwen3.8-max', maxTurns: 1,
      permissionProfile: 'agent-os-7f-root-readonly', prompt: 'say ok',
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
      permissionProfile: 'agent-os-7f-root-readonly', prompt: 'say ok',
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
      permissionProfile: 'agent-os-7f-root-readonly', prompt: 'toolong',
    })).toThrow(/prompt exceeds/i);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('uses the server-owned browser sandbox profile and does not expose raw yolo flags', async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'command-code-browser-root-'));
    const workspace = path.join(workspaceRoot, 'project');
    const nativeHome = await mkdtemp(path.join(os.tmpdir(), 'command-code-browser-home-'));
    const executablePath = path.join(nativeHome, 'cmd');
    await (await import('node:fs/promises')).writeFile(executablePath, '#!/bin/sh\n', { mode: 0o700 });
    await mkdir(workspace);
    await mkdir(path.join(nativeHome, 'browser-1', '.commandcode'), { recursive: true });
    const authPath = path.join(nativeHome, 'browser-1', '.commandcode', 'auth.json');
    await (await import('node:fs/promises')).writeFile(authPath, '{}', { mode: 0o400 });
    const authHandle = await (await import('node:fs/promises')).open(authPath, 'r');
    const authStat = await authHandle.stat();
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    const runner = new CommandCodeProcessRunner({
      executablePath,
      nativeHomeDir: nativeHome,
      browserSandboxExecutablePath: '/usr/bin/bwrap',
      spawn,
      maxWallTimeMs: 1000,
    });
    runner.setBrowserPolicyRoots([workspaceRoot], ['/usr/bin', '/usr/lib', '/usr/lib64'], nativeHome);
    runner.pinExecutable();
    runner.pinBrowserSandbox();
    const resultPromise = runner.run({
      sessionId: 'browser-1',
      cwd: workspace,
      model: 'qwen/qwen3.8-max',
      maxTurns: 1,
      permissionProfile: 'browser-contained',
      prompt: 'say ok',
      browserAuthFd: authHandle.fd,
      browserAuthIdentity: { dev: authStat.dev, ino: authStat.ino },
    });
    await new Promise((resolve) => setImmediate(resolve));
    child.stdout.write('{"type":"result","subtype":"success","sessionId":"native-browser","finalText":"ok"}\\n');
    child.emit('close', 0, null);
    await resultPromise;

    const [command, args, options] = spawn.mock.calls[0] ?? [];
    expect(command).toMatch(/(?:\/usr\/bin\/bwrap|\/proc\/self\/fd\/[34])$/);
    expect(args).toContain('--unshare-net');
    expect(args).not.toContain('--share-net');
    expect(args.some((value) => value.startsWith('/proc/self/fd/'))).toBe(true);
    expect(args).toContain('--ro-bind');
    const workspaceMount = args.findIndex((value, index) => value === '/workspace' && args[index - 2] === '--ro-bind');
    expect(workspaceMount).toBeGreaterThan(1);
    expect(args).not.toContain('--yolo');
    expect(options).toMatchObject({ cwd: '/', shell: false, detached: true });
    await authHandle.close();
    await Promise.all([rm(workspaceRoot, { recursive: true, force: true }), rm(nativeHome, { recursive: true, force: true })]);
  });

  it('rejects browser launches with a filesystem-root runtime mount', () => {
    const spawn = vi.fn();
    const runner = new CommandCodeProcessRunner({
      executablePath: '/opt/bin/cmd',
      nativeHomeDir: '/tmp/private-command-code-home',
      browserSandboxExecutablePath: '/usr/bin/bwrap',
      spawn,
    });
    expect(() => runner.setBrowserPolicyRoots(['/tmp/workspaces'], ['/'], '/tmp/private-command-code-home')).toThrow(/too broad/i);
    expect(() => runner.run({
      sessionId: 'browser-broad', cwd: '/tmp/workspaces/project', model: 'qwen/qwen3.8-max', maxTurns: 1,
      permissionProfile: 'browser-contained', prompt: 'say ok',
    })).toThrow(/browser roots|sandbox/i);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('rejects browser launches outside the configured workspace roots', async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'command-code-browser-root-'));
    const nativeHome = await mkdtemp(path.join(os.tmpdir(), 'command-code-browser-home-'));
    const executablePath = path.join(nativeHome, 'cmd');
    await (await import('node:fs/promises')).writeFile(executablePath, '#!/bin/sh\n', { mode: 0o700 });
    await mkdir(path.join(nativeHome, 'browser-escape', '.commandcode'), { recursive: true });
    await (await import('node:fs/promises')).writeFile(path.join(nativeHome, 'browser-escape', '.commandcode', 'auth.json'), '{}');
    const spawn = vi.fn();
    const runner = new CommandCodeProcessRunner({
      executablePath,
      nativeHomeDir: nativeHome,
      browserSandboxExecutablePath: '/usr/bin/bwrap',
      spawn,
    });
    runner.setBrowserPolicyRoots([workspaceRoot], ['/usr/bin'], nativeHome);
    runner.pinExecutable();
    runner.pinBrowserSandbox();
    expect(() => runner.run({
      sessionId: 'browser-escape', cwd: '/tmp/other', model: 'qwen/qwen3.8-max', maxTurns: 1,
      permissionProfile: 'browser-contained', prompt: 'say ok',
    })).toThrow(/outside.*browser roots/i);
    expect(spawn).not.toHaveBeenCalled();
    await Promise.all([rm(workspaceRoot, { recursive: true, force: true }), rm(nativeHome, { recursive: true, force: true })]);
  });

  it('terminates the whole process group and escalates after the grace period', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const runner = new CommandCodeProcessRunner({ executablePath: '/opt/bin/cmd', spawn, processGraceMs: 25 });
    const promise = runner.run({
      sessionId: 's1', cwd: '/tmp', model: 'qwen/qwen3.8-max', maxTurns: 1,
      permissionProfile: 'agent-os-7f-root-readonly', prompt: 'wait',
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
});
