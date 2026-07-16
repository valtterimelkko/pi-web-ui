import { chmodSync, existsSync, lstatSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { bindOwnerOnlyUnixSocket, UnixSocketOwner } from '../../../src/internal-api/unix-socket-owner.js';

const cleanupPaths: string[] = [];

function tempSocket(): { dir: string; socketPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pi-internal-socket-'));
  cleanupPaths.push(dir);
  return { dir, socketPath: join(dir, 'api.sock') };
}

async function listen(socketPath: string) {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  return server;
}

afterEach(() => {
  for (const target of cleanupPaths.splice(0)) rmSync(target, { recursive: true, force: true });
});

describe('UnixSocketOwner', () => {
  it('does not report a bound socket ready until mode 0600 is applied', async () => {
    const { socketPath } = tempSocket();
    const server = createServer();

    await bindOwnerOnlyUnixSocket(server, socketPath);

    expect(lstatSync(socketPath).mode & 0o777).toBe(0o600);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('refuses to remove or steal a live Unix socket', async () => {
    const { socketPath } = tempSocket();
    const live = await listen(socketPath);
    const owner = new UnixSocketOwner(socketPath, 100);

    await expect(owner.prepareForBind()).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(lstatSync(socketPath).isSocket()).toBe(true);

    await new Promise<void>((resolve) => live.close(() => resolve()));
  });

  it('holds a lifecycle lock even before the socket is bound', async () => {
    const { socketPath } = tempSocket();
    const first = new UnixSocketOwner(socketPath, 100);
    const second = new UnixSocketOwner(socketPath, 100);

    await first.prepareForBind();
    await expect(second.prepareForBind()).rejects.toMatchObject({ code: 'EADDRINUSE' });

    await first.release();
    await second.prepareForBind();
    await second.release();
  });

  it('removes a verified stale Unix socket', async () => {
    const { socketPath } = tempSocket();
    const child = spawnSync(process.execPath, ['-e', [
      "const net=require('node:net');",
      `const s=net.createServer();s.listen(${JSON.stringify(socketPath)},()=>process.kill(process.pid,'SIGKILL'));`,
    ].join('')]);
    expect(child.signal).toBe('SIGKILL');
    expect(lstatSync(socketPath).isSocket()).toBe(true);

    const owner = new UnixSocketOwner(socketPath, 100);
    await owner.prepareForBind();

    expect(existsSync(socketPath)).toBe(false);
  });

  it('fails closed for regular files and symlinks', async () => {
    const first = tempSocket();
    writeFileSync(first.socketPath, 'do not delete');
    await expect(new UnixSocketOwner(first.socketPath).prepareForBind()).rejects.toThrow(/not a Unix socket/i);
    expect(existsSync(first.socketPath)).toBe(true);

    const second = tempSocket();
    const target = join(second.dir, 'target');
    writeFileSync(target, 'target');
    symlinkSync(target, second.socketPath);
    await expect(new UnixSocketOwner(second.socketPath).prepareForBind()).rejects.toThrow(/symbolic link/i);
    expect(existsSync(target)).toBe(true);
  });

  it('only unlinks the socket inode captured after this process binds', async () => {
    const { socketPath } = tempSocket();
    const owner = new UnixSocketOwner(socketPath);
    await owner.prepareForBind();
    const server = await listen(socketPath);
    await owner.captureOwnership();
    await new Promise<void>((resolve) => server.close(() => resolve()));

    writeFileSync(socketPath, 'replacement');
    await owner.release();

    expect(existsSync(socketPath)).toBe(true);
    expect(lstatSync(socketPath).isFile()).toBe(true);
  });

  it('does not treat a permission error as proof that a socket is stale', async () => {
    const { dir, socketPath } = tempSocket();
    const server = await listen(socketPath);
    chmodSync(dir, 0o000);
    try {
      const owner = new UnixSocketOwner(socketPath, 50);
      // Root may still connect despite directory mode; either outcome must preserve the live path.
      await owner.prepareForBind().catch(() => undefined);
      expect(existsSync(socketPath)).toBe(true);
    } finally {
      chmodSync(dir, 0o700);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
