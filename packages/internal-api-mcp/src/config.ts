import { constants as fsConstants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Stats } from 'node:fs';

export interface McpConfig {
  socketPath: string;
  tokenPath: string;
  defaultCwd?: string;
  timeoutMs: number;
  maxResponseBytes: number;
  maxToolOutputBytes: number;
}

export interface SecurePathIdentity {
  dev: number;
  ino: number;
  uid: number;
  mode: number;
  kind: 'token' | 'socket';
}

interface SecurePathOptions {
  expectedUid?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1 * 1024 * 1024;
const DEFAULT_MAX_TOOL_OUTPUT_BYTES = 128 * 1024;
const TOKEN_MAX_BYTES = 8 * 1024;
const UID_UNAVAILABLE = -1;

const LIMITS = {
  timeoutMs: { min: 100, max: 120_000 },
  maxResponseBytes: { min: 1024, max: 16 * 1024 * 1024 },
  maxToolOutputBytes: { min: 1024, max: 4 * 1024 * 1024 },
} as const;

function currentUid(): number {
  return typeof process.getuid === 'function' ? process.getuid() : UID_UNAVAILABLE;
}

function expandConfiguredPath(value: string, homeDir: string, name: string): string {
  const expanded = value === '~'
    ? homeDir
    : value.startsWith('~/')
      ? path.join(homeDir, value.slice(2))
      : value;
  if (!path.isAbsolute(expanded)) {
    throw new Error(`${name} must be an absolute path`);
  }
  return path.normalize(expanded);
}

function parseBoundedInteger(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a positive integer within range`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be within range ${min}..${max}`);
  }
  return parsed;
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  homeDir = os.homedir(),
): McpConfig {
  const socketPath = expandConfiguredPath(
    env.PI_WEB_UI_MCP_SOCKET_PATH ?? path.join(homeDir, '.pi-web-ui', 'internal-api.sock'),
    homeDir,
    'PI_WEB_UI_MCP_SOCKET_PATH',
  );
  const tokenPath = expandConfiguredPath(
    env.PI_WEB_UI_MCP_TOKEN_PATH ?? path.join(homeDir, '.pi-web-ui', 'internal-api-token'),
    homeDir,
    'PI_WEB_UI_MCP_TOKEN_PATH',
  );
  const defaultCwd = env.PI_WEB_UI_MCP_DEFAULT_CWD === undefined
    ? undefined
    : expandConfiguredPath(env.PI_WEB_UI_MCP_DEFAULT_CWD, homeDir, 'PI_WEB_UI_MCP_DEFAULT_CWD');

  return {
    socketPath,
    tokenPath,
    defaultCwd,
    timeoutMs: parseBoundedInteger(
      env,
      'PI_WEB_UI_MCP_TIMEOUT_MS',
      DEFAULT_TIMEOUT_MS,
      LIMITS.timeoutMs.min,
      LIMITS.timeoutMs.max,
    ),
    maxResponseBytes: parseBoundedInteger(
      env,
      'PI_WEB_UI_MCP_MAX_RESPONSE_BYTES',
      DEFAULT_MAX_RESPONSE_BYTES,
      LIMITS.maxResponseBytes.min,
      LIMITS.maxResponseBytes.max,
    ),
    maxToolOutputBytes: parseBoundedInteger(
      env,
      'PI_WEB_UI_MCP_MAX_TOOL_OUTPUT_BYTES',
      DEFAULT_MAX_TOOL_OUTPUT_BYTES,
      LIMITS.maxToolOutputBytes.min,
      LIMITS.maxToolOutputBytes.max,
    ),
  };
}

function identityFromStats(stats: Stats, kind: SecurePathIdentity['kind']): SecurePathIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    uid: stats.uid,
    mode: stats.mode,
    kind,
  };
}

function assertOwnerOnly(stats: Stats, filePath: string): void {
  if ((stats.mode & 0o077) !== 0) {
    throw new Error(`${filePath} has unsafe permissions; group/world bits must be unset`);
  }
  const uid = currentUid();
  if (uid !== UID_UNAVAILABLE && stats.uid !== uid) {
    throw new Error(`${filePath} has unsafe owner uid`);
  }
}

async function assertSecureParentDirectory(filePath: string, options: SecurePathOptions): Promise<void> {
  const parentPath = path.dirname(filePath);
  let parent: Stats;
  try {
    parent = await lstat(parentPath);
  } catch (error) {
    throw new Error(`${parentPath} is unavailable or unsafe`, { cause: error });
  }
  if (parent.isSymbolicLink() || !parent.isDirectory()) {
    throw new Error(`${parentPath} must be a regular owner-only directory`);
  }
  if (options.expectedUid !== undefined && parent.uid !== options.expectedUid) {
    throw new Error(`${parentPath} has unexpected owner uid`);
  }
  assertOwnerOnly(parent, parentPath);
}

async function lstatSecurePath(
  filePath: string,
  kind: SecurePathIdentity['kind'],
  options: SecurePathOptions = {},
): Promise<SecurePathIdentity> {
  await assertSecureParentDirectory(filePath, options);
  let stats: Stats;
  try {
    stats = await lstat(filePath);
  } catch (error) {
    throw new Error(`${filePath} is unavailable or unsafe`, { cause: error });
  }
  if (stats.isSymbolicLink()) {
    throw new Error(`${filePath} must not be a symlink`);
  }
  if (options.expectedUid !== undefined && stats.uid !== options.expectedUid) {
    throw new Error(`${filePath} has unexpected owner uid`);
  }
  assertOwnerOnly(stats, filePath);
  if (kind === 'token' && !stats.isFile()) {
    throw new Error(`${filePath} must be a regular token file`);
  }
  if (kind === 'socket' && !stats.isSocket()) {
    throw new Error(`${filePath} must be a Unix socket`);
  }
  return identityFromStats(stats, kind);
}

export function assertSameIdentity(
  expected: SecurePathIdentity,
  actual: SecurePathIdentity,
  label: string,
): void {
  if (
    expected.kind !== actual.kind ||
    expected.dev !== actual.dev ||
    expected.ino !== actual.ino ||
    expected.uid !== actual.uid ||
    (expected.mode & 0o777) !== (actual.mode & 0o777)
  ) {
    throw new Error(`${label} identity was replaced during use`);
  }
}

export async function assertSecureTokenPath(
  filePath: string,
  options: SecurePathOptions = {},
): Promise<SecurePathIdentity> {
  return lstatSecurePath(filePath, 'token', options);
}

export async function assertSecureSocketPath(
  socketPath: string,
  options: SecurePathOptions = {},
): Promise<SecurePathIdentity> {
  return lstatSecurePath(socketPath, 'socket', options);
}

export async function readSecureToken(
  filePath: string,
  expectedIdentity?: SecurePathIdentity,
): Promise<string> {
  const beforeOpen = await assertSecureTokenPath(filePath);
  if (expectedIdentity) assertSameIdentity(expectedIdentity, beforeOpen, 'Token path');

  const handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const descriptorStats = await handle.stat();
    const descriptorIdentity = identityFromStats(descriptorStats, 'token');
    assertSameIdentity(beforeOpen, descriptorIdentity, 'Token file');
    if (descriptorStats.size > TOKEN_MAX_BYTES) {
      throw new Error(`Internal API token is too large (maximum ${TOKEN_MAX_BYTES} bytes)`);
    }
    const afterOpen = await assertSecureTokenPath(filePath);
    assertSameIdentity(descriptorIdentity, afterOpen, 'Token path');

    const content = await handle.readFile({ encoding: 'utf8' });
    if (Buffer.byteLength(content, 'utf8') > TOKEN_MAX_BYTES) {
      throw new Error('Internal API token is too large');
    }
    const token = content.trim();
    if (!token) throw new Error('Internal API token is empty');

    const afterRead = await assertSecureTokenPath(filePath);
    assertSameIdentity(descriptorIdentity, afterRead, 'Token path');
    return token;
  } finally {
    await handle.close();
  }
}

export const configLimits = LIMITS;
