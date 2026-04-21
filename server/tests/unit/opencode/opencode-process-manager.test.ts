import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

vi.mock('node:child_process', async () => {
  const { EventEmitter } = await import('events');
  const { PassThrough } = await import('stream');

  function makeMockProcess(pid = 12345) {
    const proc = new EventEmitter() as unknown as import('node:child_process').ChildProcess;
    (proc as unknown as Record<string, unknown>).stdout = new PassThrough();
    (proc as unknown as Record<string, unknown>).stderr = new PassThrough();
    (proc as unknown as Record<string, unknown>).pid = pid;
    const killFn = vi.fn((signal?: NodeJS.Signals | number) => {
      proc.emit('exit', null, signal ?? 'SIGTERM');
      return true;
    });
    (proc as unknown as Record<string, unknown>).kill = killFn;
    return proc;
  }

  const spawnMock = vi.fn().mockImplementation(() => makeMockProcess());

  return {
    spawn: spawnMock,
    default: { spawn: spawnMock },
    execSync: vi.fn().mockImplementation(() => Buffer.from('/usr/local/bin/opencode')),
  };
});

import { OpenCodeProcessManager } from '../../../src/opencode/opencode-process-manager.js';
import { spawn } from 'node:child_process';

const spawnMock = spawn as unknown as ReturnType<typeof vi.fn>;

import type { OpenCodeConfig } from '../../../src/opencode/opencode-types.js';

function makeConfig(overrides: Partial<OpenCodeConfig> = {}): OpenCodeConfig {
  return {
    host: '127.0.0.1',
    port: 4096,
    password: '',
    workingDir: '/tmp',
    enabled: true,
    ...overrides,
  };
}

function makeDeferredProcess(pid = 12345) {
  const proc = new EventEmitter();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.pid = pid;
  proc.kill = vi.fn(() => true);
  return proc;
}

describe('OpenCodeProcessManager', () => {
  let manager: OpenCodeProcessManager;

  beforeEach(() => {
    manager = new OpenCodeProcessManager(makeConfig());
    spawnMock.mockClear();
    spawnMock.mockImplementation(() => {
      const proc = makeDeferredProcess();
      return proc;
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('isAvailable', () => {
    it('returns false when which opencode fails', async () => {
      const { execSync } = await import('node:child_process');
      (execSync as ReturnType<typeof vi>).mockImplementationOnce(() => {
        throw new Error('not found');
      });
      const result = await manager.isAvailable();
      expect(result).toBe(false);
    });

    it('returns true when opencode is found', async () => {
      const result = await manager.isAvailable();
      expect(result).toBe(true);
    });
  });

  describe('start', () => {
    it('spawns process with correct args', async () => {
      const config = makeConfig({ host: '0.0.0.0', port: 5000, password: 'secret' });
      manager = new OpenCodeProcessManager(config);

      spawnMock.mockImplementationOnce(() => {
        const proc = makeDeferredProcess();
        return proc;
      });

      await manager.start();

      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(spawnMock).toHaveBeenCalledWith(
        'opencode',
        ['serve', '--hostname', '0.0.0.0', '--port', '5000'],
        expect.objectContaining({
          cwd: '/tmp',
          env: expect.objectContaining({
            OPENCODE_SERVER_PASSWORD: 'secret',
          }),
        }),
      );
    });

    it('is idempotent - calling twice does not spawn twice', async () => {
      spawnMock.mockImplementationOnce(() => makeDeferredProcess());

      await manager.start();
      await manager.start();

      expect(spawnMock).toHaveBeenCalledTimes(1);
    });

    it('throws when disabled', async () => {
      const config = makeConfig({ enabled: false });
      manager = new OpenCodeProcessManager(config);

      await expect(manager.start()).rejects.toThrow('OpenCode integration is disabled');
    });
  });

  describe('stop', () => {
    it('sends SIGTERM to the process', async () => {
      let capturedProc: ReturnType<typeof makeDeferredProcess> | null = null;
      spawnMock.mockImplementationOnce(() => {
        capturedProc = makeDeferredProcess();
        return capturedProc;
      });

      await manager.start();
      expect(capturedProc).not.toBeNull();

      const stopPromise = manager.stop();

      capturedProc!.emit('exit', null, 'SIGTERM');
      await stopPromise;

      expect(capturedProc!.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('resolves immediately when no process is running', async () => {
      await expect(manager.stop()).resolves.toBeUndefined();
    });
  });

  describe('getBaseUrl', () => {
    it('returns correct URL', () => {
      const config = makeConfig({ host: 'localhost', port: 8888 });
      manager = new OpenCodeProcessManager(config);
      expect(manager.getBaseUrl()).toBe('http://localhost:8888');
    });
  });

  describe('getAuthHeaders', () => {
    it('returns basic auth when password is set', () => {
      const config = makeConfig({ password: 'mypassword' });
      manager = new OpenCodeProcessManager(config);
      const headers = manager.getAuthHeaders();
      expect(headers).toEqual({
        Authorization: `Basic ${Buffer.from(':mypassword').toString('base64')}`,
      });
    });

    it('returns empty object when no password', () => {
      const config = makeConfig({ password: '' });
      manager = new OpenCodeProcessManager(config);
      const headers = manager.getAuthHeaders();
      expect(headers).toEqual({});
    });
  });

  describe('isHealthy', () => {
    it('returns false when no process is running', async () => {
      const result = await manager.isHealthy();
      expect(result).toBe(false);
    });

    it('returns true when fetch succeeds', async () => {
      spawnMock.mockImplementationOnce(() => makeDeferredProcess());
      await manager.start();

      const result = await manager.isHealthy();
      expect(result).toBe(true);
    });

    it('returns false when fetch fails', async () => {
      spawnMock.mockImplementationOnce(() => makeDeferredProcess());
      await manager.start();

      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('connection refused'));
      const result = await manager.isHealthy();
      expect(result).toBe(false);
    });
  });
});
