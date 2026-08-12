import { describe, expect, it } from 'vitest';
import {
  assertSameIdentity,
  assertSecureSocketPath,
  assertSecureTokenPath,
  loadConfig,
  readSecureToken,
  type McpConfig,
} from '../src/config.js';
import { chmod, mkdir, mkdtemp, open, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'pi-web-ui-mcp-config-'));
}

async function makeSocket(socketPath: string): Promise<net.Server> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });
  return server;
}

async function writeToken(filePath: string, token = 'sentinel-token'): Promise<void> {
  await writeFile(filePath, token, { mode: 0o600 });
  await chmod(filePath, 0o600);
}

describe('MCP process configuration', () => {
  it('expands default paths from an injected home directory', () => {
    const config = loadConfig({}, '/home/operator');

    expect(config.socketPath).toBe('/home/operator/.pi-web-ui/internal-api.sock');
    expect(config.tokenPath).toBe('/home/operator/.pi-web-ui/internal-api-token');
    expect(path.isAbsolute(config.socketPath)).toBe(true);
    expect(path.isAbsolute(config.tokenPath)).toBe(true);
  });

  it('accepts explicit disposable paths and fixed process defaults', () => {
    const config = loadConfig({
      PI_WEB_UI_MCP_SOCKET_PATH: '/tmp/mcp.sock',
      PI_WEB_UI_MCP_TOKEN_PATH: '/tmp/mcp.token',
      PI_WEB_UI_MCP_DEFAULT_CWD: '/tmp/worktree',
      PI_WEB_UI_MCP_TIMEOUT_MS: '7000',
      PI_WEB_UI_MCP_MAX_RESPONSE_BYTES: '4096',
      PI_WEB_UI_MCP_MAX_TOOL_OUTPUT_BYTES: '2048',
    }, '/home/operator');

    expect(config).toMatchObject<McpConfig>({
      socketPath: '/tmp/mcp.sock',
      tokenPath: '/tmp/mcp.token',
      defaultCwd: '/tmp/worktree',
      timeoutMs: 7000,
      maxResponseBytes: 4096,
      maxToolOutputBytes: 2048,
    });
  });

  it.each([
    ['PI_WEB_UI_MCP_SOCKET_PATH', 'relative.sock'],
    ['PI_WEB_UI_MCP_TOKEN_PATH', 'token'],
    ['PI_WEB_UI_MCP_DEFAULT_CWD', 'relative-cwd'],
  ])('rejects a relative %s value', (name, value) => {
    expect(() => loadConfig({ [name]: value }, '/home/operator')).toThrow(/absolute/i);
  });

  it.each([
    ['PI_WEB_UI_MCP_TIMEOUT_MS', ''],
    ['PI_WEB_UI_MCP_TIMEOUT_MS', '0'],
    ['PI_WEB_UI_MCP_TIMEOUT_MS', '999999'],
    ['PI_WEB_UI_MCP_MAX_RESPONSE_BYTES', '0'],
    ['PI_WEB_UI_MCP_MAX_RESPONSE_BYTES', '999999999'],
    ['PI_WEB_UI_MCP_MAX_TOOL_OUTPUT_BYTES', '0'],
    ['PI_WEB_UI_MCP_MAX_TOOL_OUTPUT_BYTES', '999999999'],
  ])('rejects empty or out-of-range %s', (name, value) => {
    expect(() => loadConfig({ [name]: value }, '/home/operator')).toThrow(/range|positive|bounded|invalid/i);
  });

  describe('secure token path', () => {
    it('accepts an owner-only regular token file and reads its contents', async () => {
      const dir = await tempDir();
      try {
        const tokenPath = path.join(dir, 'token');
        await writeToken(tokenPath);
        await assertSecureTokenPath(tokenPath);
        await expect(readSecureToken(tokenPath)).resolves.toBe('sentinel-token');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('rejects a token path whose containing directory is not owner-only', async () => {
      const dir = await tempDir();
      try {
        const unsafeDir = path.join(dir, 'unsafe-parent');
        await mkdir(unsafeDir, { mode: 0o755 });
        await chmod(unsafeDir, 0o755);
        const tokenPath = path.join(unsafeDir, 'token');
        await writeToken(tokenPath);
        await expect(assertSecureTokenPath(tokenPath)).rejects.toThrow(/directory|permission|unsafe/i);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('rejects a token symlink, non-regular file, or group/world-readable file', async () => {
      const dir = await tempDir();
      try {
        const target = path.join(dir, 'target');
        const symlinkPath = path.join(dir, 'token-link');
        await writeToken(target);
        await symlink(target, symlinkPath);
        await expect(assertSecureTokenPath(symlinkPath)).rejects.toThrow(/symlink|regular|unsafe/i);

        const directoryPath = path.join(dir, 'token-dir');
        await mkdir(directoryPath);
        await expect(assertSecureTokenPath(directoryPath)).rejects.toThrow(/regular|directory|unsafe/i);

        const readablePath = path.join(dir, 'token-readable');
        await writeToken(readablePath);
        await chmod(readablePath, 0o644);
        await expect(assertSecureTokenPath(readablePath)).rejects.toThrow(/permission|mode|unsafe/i);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('rejects a token owned by a different uid', async () => {
      const dir = await tempDir();
      try {
        const tokenPath = path.join(dir, 'token');
        await writeToken(tokenPath);
        const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
        await expect(assertSecureTokenPath(tokenPath, { expectedUid: uid + 1 })).rejects.toThrow(/owner|uid|unsafe/i);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('rejects an oversized token before reading its contents', async () => {
      const dir = await tempDir();
      try {
        const tokenPath = path.join(dir, 'token');
        await writeToken(tokenPath, 'x'.repeat(8 * 1024 + 1));
        await expect(readSecureToken(tokenPath)).rejects.toThrow(/large|bytes|size/i);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('detects token inode replacement between validation and use', async () => {
      const dir = await tempDir();
      try {
        const tokenPath = path.join(dir, 'token');
        await writeToken(tokenPath, 'first-token');
        const replacementPath = path.join(dir, 'replacement');
        await writeToken(replacementPath, 'replacement-token');
        const first = await assertSecureTokenPath(tokenPath);
        const originalHandle = await open(tokenPath, 'r');
        await rm(tokenPath);
        await rename(replacementPath, tokenPath);
        await expect(readSecureToken(tokenPath, first)).rejects.toThrow(/replaced|identity|inode/i);
        await originalHandle.close();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('secure socket path', () => {
    it('accepts an owner-only Unix socket and rejects replacement', async () => {
      const dir = await tempDir();
      let server: net.Server | undefined;
      try {
        const socketPath = path.join(dir, 'internal-api.sock');
        server = await makeSocket(socketPath);
        await chmod(socketPath, 0o600);
        const identity = await assertSecureSocketPath(socketPath);
        expect(identity.mode & 0o777).toBe(0o600);
        await server.close();
        server = undefined;
        await expect(assertSecureSocketPath(socketPath)).rejects.toThrow(/socket|missing|unsafe/i);
      } finally {
        await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('rejects a socket symlink, non-socket, group/world-readable socket, or wrong owner', async () => {
      const dir = await tempDir();
      let server: net.Server | undefined;
      try {
        const socketPath = path.join(dir, 'internal-api.sock');
        server = await makeSocket(socketPath);
        await chmod(socketPath, 0o600);
        const linkPath = path.join(dir, 'link.sock');
        await symlink(socketPath, linkPath);
        await expect(assertSecureSocketPath(linkPath)).rejects.toThrow(/symlink|socket|unsafe/i);

        const filePath = path.join(dir, 'not-socket');
        await writeFile(filePath, 'not a socket', { mode: 0o600 });
        await expect(assertSecureSocketPath(filePath)).rejects.toThrow(/socket|unsafe/i);

        await chmod(socketPath, 0o660);
        await expect(assertSecureSocketPath(socketPath)).rejects.toThrow(/permission|mode|unsafe/i);
        await chmod(socketPath, 0o600);
        const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
        await expect(assertSecureSocketPath(socketPath, { expectedUid: uid + 1 })).rejects.toThrow(/owner|uid|unsafe/i);
      } finally {
        await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('detects socket inode replacement after the request', async () => {
      const dir = await tempDir();
      let firstServer: net.Server | undefined;
      let secondServer: net.Server | undefined;
      try {
        const socketPath = path.join(dir, 'internal-api.sock');
        firstServer = await makeSocket(socketPath);
        await chmod(socketPath, 0o600);
        const identity = await assertSecureSocketPath(socketPath);
        const movedSocketPath = path.join(dir, 'old-internal-api.sock');
        await rename(socketPath, movedSocketPath);
        secondServer = await makeSocket(socketPath);
        await chmod(socketPath, 0o600);
        const replacement = await assertSecureSocketPath(socketPath);
        expect(() => assertSameIdentity(identity, replacement, 'Socket path')).toThrow(/replaced|identity|inode/i);
      } finally {
        await new Promise<void>((resolve) => firstServer?.close(() => resolve()) ?? resolve());
        await new Promise<void>((resolve) => secondServer?.close(() => resolve()) ?? resolve());
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
