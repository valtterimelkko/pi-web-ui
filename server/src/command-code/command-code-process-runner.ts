import path from 'node:path';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
} from 'node:fs';
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { buildCommandCodeArgs, type CommandCodePermissionProfile } from './command-code-config.js';
import type { CommandCodeEffort, CommandCodeRuntimeModel } from './command-code-model-catalog.js';
import { CommandCodeNdjsonParser, type ParsedCommandCodeEvent, type ParsedCommandCodeOutput } from './command-code-ndjson-parser.js';

export interface CommandCodeSpawnOptions extends SpawnOptions {
  detached: true;
  shell: false;
  cwd: string;
}

interface PinnedDirectory {
  path: string;
  fd: number;
  identity: CommandCodeFileIdentity;
}

interface PinnedFile {
  path: string;
  fd: number;
  identity: CommandCodeFileIdentity;
}

export interface CommandCodeFileIdentity {
  dev: number;
  ino: number;
}

interface CommandCodeLaunch {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdio?: SpawnOptions['stdio'];
  cleanup?: () => void;
}

export type CommandCodeSpawn = (command: string, args: string[], options: CommandCodeSpawnOptions) => ChildProcess;

export interface CommandCodeProcessRunInput {
  sessionId: string;
  cwd: string;
  model: CommandCodeRuntimeModel;
  maxTurns: number;
  permissionProfile: CommandCodePermissionProfile;
  prompt: string;
  nativeSessionId?: string;
  effort?: CommandCodeEffort;
  /** Pinned server-owned browser credential; required for contained launches. */
  browserAuthFd?: number;
  browserAuthIdentity?: CommandCodeFileIdentity;
  /** Receives accepted NDJSON event frames before the child exits. */
  onEvent?: (event: ParsedCommandCodeEvent) => void;
}

export interface CommandCodeProcessRunResult {
  parsed?: ParsedCommandCodeOutput;
  exitCode: number | null;
  signal?: NodeJS.Signals | null;
  stderrTail: string;
  terminationCause?: 'abort' | 'timeout' | 'shutdown';
  protocolError?: string;
  spawnError?: string;
}

interface ActiveProcess {
  child: ChildProcess;
  resultPromise: Promise<CommandCodeProcessRunResult>;
  terminate: (cause: 'abort' | 'timeout' | 'shutdown') => void;
}

const SAFE_ENV_KEYS = new Set([
  'HOME', 'PATH', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'XDG_CONFIG_HOME',
  'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'TERM', 'NO_COLOR',
]);

/** Owns Command Code child processes and their process-group lifecycle. */
export class CommandCodeProcessRunner {
  private readonly executablePath: string;
  private readonly spawn: CommandCodeSpawn;
  private readonly processGraceMs: number;
  private readonly maxWallTimeMs: number;
  private readonly maxStdoutLineBytes: number;
  private readonly maxStdoutBytes: number;
  private readonly maxPromptBytes: number;
  private readonly maxStderrBytes: number;
  private readonly nativeHomeDir?: string;
  private readonly browserSandboxExecutablePath?: string;
  private browserAllowedCwdRoots: string[] = [];
  private browserRuntimeRoots: string[] = [];
  private browserAllowedCwdBindings: PinnedDirectory[] = [];
  private browserRuntimeRootBindings: PinnedDirectory[] = [];
  private browserNativeHomeBinding?: PinnedDirectory;
  private executableBinding?: PinnedFile;
  private browserSandboxBinding?: PinnedFile;
  private readonly active = new Map<string, ActiveProcess>();

  constructor(options: {
    executablePath: string;
    spawn?: CommandCodeSpawn;
    processGraceMs?: number;
    maxWallTimeMs?: number;
    maxStdoutLineBytes?: number;
    maxStdoutBytes?: number;
    maxPromptBytes?: number;
    maxStderrBytes?: number;
    nativeHomeDir?: string;
    browserSandboxExecutablePath?: string;
    browserAllowedCwdRoots?: string[];
    browserRuntimeRoots?: string[];
  }) {
    if (!options.executablePath.startsWith('/')) throw new Error('Command Code executable path must be absolute');
    this.executablePath = options.executablePath;
    this.spawn = options.spawn ?? ((command, args, spawnOptions) => nodeSpawn(command, args, spawnOptions));
    this.processGraceMs = options.processGraceMs ?? 2_000;
    this.maxWallTimeMs = options.maxWallTimeMs ?? 15 * 60_000;
    this.maxStdoutLineBytes = options.maxStdoutLineBytes ?? 512 * 1024;
    this.maxStdoutBytes = options.maxStdoutBytes ?? 8 * 1024 * 1024;
    this.maxPromptBytes = options.maxPromptBytes ?? 100_000;
    this.maxStderrBytes = options.maxStderrBytes ?? 64 * 1024;
    this.nativeHomeDir = options.nativeHomeDir;
    this.browserSandboxExecutablePath = options.browserSandboxExecutablePath;
  }

  /**
   * Install browser policy roots only after the service has validated them.
   * Directory handles are retained so Bubblewrap can mount the validated
   * objects without re-resolving mutable pathnames at launch time.
   */
  setBrowserPolicyRoots(
    allowedCwdRoots: string[],
    runtimeRoots: string[],
    nativeHomeDir = this.nativeHomeDir,
    expected?: {
      allowed: CommandCodeFileIdentity[];
      runtime: CommandCodeFileIdentity[];
      nativeHome: CommandCodeFileIdentity;
    },
  ): void {
    const allowed = [...new Set(allowedCwdRoots.map((root) => path.resolve(root)))];
    const runtime = [...new Set(runtimeRoots.map((root) => path.resolve(root)))];
    if (!nativeHomeDir || allowed.length === 0 || runtime.length === 0) {
      this.closeBrowserPolicyRoots();
      return;
    }
    if (allowed.some(isBroadWorkspaceRoot) || runtime.some(isBroadRuntimeRoot)) {
      this.closeBrowserPolicyRoots();
      throw new Error('Command Code browser roots are too broad');
    }
    if (allowed.some((root) => overlapsRoot(root, nativeHomeDir)) || runtime.some((root) => overlapsRoot(root, nativeHomeDir))) {
      this.closeBrowserPolicyRoots();
      throw new Error('Command Code browser roots may not overlap the private native home');
    }
    if (allowed.some((root) => runtime.some((runtimeRoot) => overlapsRoot(root, runtimeRoot)))) {
      this.closeBrowserPolicyRoots();
      throw new Error('Command Code browser workspace and runtime roots may not overlap');
    }
    if (expected && (expected.allowed.length !== allowed.length || expected.runtime.length !== runtime.length)) {
      this.closeBrowserPolicyRoots();
      throw new Error('Command Code browser root identity count changed');
    }

    const nextAllowed: PinnedDirectory[] = [];
    const nextRuntime: PinnedDirectory[] = [];
    let nextNativeHome: PinnedDirectory | undefined;
    try {
      for (const [index, root] of allowed.entries()) nextAllowed.push(openPinnedDirectory(root, expected?.allowed[index]));
      for (const [index, root] of runtime.entries()) nextRuntime.push(openPinnedDirectory(root, expected?.runtime[index]));
      nextNativeHome = openPinnedDirectory(nativeHomeDir, expected?.nativeHome);
    } catch (error) {
      closePinnedDirectories([...nextAllowed, ...nextRuntime, ...(nextNativeHome ? [nextNativeHome] : [])]);
      throw error;
    }

    this.closeBrowserPolicyRoots();
    this.browserAllowedCwdRoots = allowed;
    this.browserRuntimeRoots = runtime;
    this.browserAllowedCwdBindings = nextAllowed;
    this.browserRuntimeRootBindings = nextRuntime;
    this.browserNativeHomeBinding = nextNativeHome;
  }

  /** Pin the server-owned executable after discovery and before any turn. */
  pinExecutable(executablePath = this.executablePath, expected?: CommandCodeFileIdentity): void {
    const next = openPinnedExecutable(executablePath, expected);
    closePinnedFile(this.executableBinding);
    this.executableBinding = next;
  }

  /** Pin Bubblewrap itself so a later pathname replacement cannot change the sandbox. */
  pinBrowserSandbox(sandboxExecutablePath = this.browserSandboxExecutablePath, expected?: CommandCodeFileIdentity): void {
    if (!sandboxExecutablePath) throw new Error('Command Code browser sandbox is unavailable');
    const next = openPinnedExecutable(sandboxExecutablePath, expected);
    closePinnedFile(this.browserSandboxBinding);
    this.browserSandboxBinding = next;
  }

  browserSandboxReady(): boolean {
    return Boolean(
      this.browserSandboxExecutablePath
      && this.browserSandboxBinding
      && this.browserAllowedCwdBindings.length > 0
      && this.browserRuntimeRootBindings.length > 0
      && this.browserNativeHomeBinding
      && this.nativeHomeDir,
    );
  }

  run(input: CommandCodeProcessRunInput): Promise<CommandCodeProcessRunResult> {
    if (this.active.has(input.sessionId)) throw new Error(`Command Code session is already running: ${input.sessionId}`);
    if (Buffer.byteLength(input.prompt, 'utf8') > this.maxPromptBytes) {
      throw new Error('Command Code prompt exceeds configured byte limit');
    }
    const args = buildCommandCodeArgs({
      executablePath: this.executablePath,
      model: input.model,
      maxTurns: input.maxTurns,
      permissionProfile: input.permissionProfile,
      nativeSessionId: input.nativeSessionId,
      effort: input.effort,
    });
    const launch = input.permissionProfile === 'browser-contained'
      ? buildBrowserLaunch({
          executablePath: this.executablePath,
          executableBinding: this.executableBinding,
          args,
          cwd: input.cwd,
          sessionId: input.sessionId,
          sandboxExecutablePath: this.browserSandboxExecutablePath,
          sandboxBinding: this.browserSandboxBinding,
          allowedCwdRoots: this.browserAllowedCwdRoots,
          runtimeRoots: this.browserRuntimeRoots,
          nativeHomeDir: this.nativeHomeDir,
          allowedCwdBindings: this.browserAllowedCwdBindings,
          runtimeRootBindings: this.browserRuntimeRootBindings,
          nativeHomeBinding: this.browserNativeHomeBinding,
          browserAuthFd: input.browserAuthFd,
          browserAuthIdentity: input.browserAuthIdentity,
        })
      : this.executableBinding
        ? { command: '/proc/self/fd/3', args, cwd: input.cwd, env: controlledEnvironment(this.nativeHomeDir, input.sessionId), stdio: ['pipe', 'pipe', 'pipe', this.executableBinding.fd] as SpawnOptions['stdio'] }
        : { command: this.executablePath, args, cwd: input.cwd, env: controlledEnvironment(this.nativeHomeDir, input.sessionId) };
    let child: ChildProcess;
    try {
      child = this.spawn(launch.command, launch.args, {
        cwd: launch.cwd,
        detached: true,
        shell: false,
        stdio: launch.stdio ?? ['pipe', 'pipe', 'pipe'],
        env: launch.env,
      });
    } catch (error) {
      launch.cleanup?.();
      throw error;
    }
    // The child has inherited the descriptor sources needed by Bubblewrap;
    // close the parent's copies after spawn so repeated turns cannot leak FDs.
    launch.cleanup?.();
    const parser = new CommandCodeNdjsonParser({
      maxLineBytes: this.maxStdoutLineBytes,
      maxAggregateBytes: this.maxStdoutBytes,
      onEvent: input.onEvent,
    });
    let stderrTail = '';
    let exitCode: number | null = null;
    let signal: NodeJS.Signals | null = null;
    let terminationCause: CommandCodeProcessRunResult['terminationCause'];
    let protocolError: string | undefined;
    let spawnError: string | undefined;
    let settled = false;
    let graceTimer: NodeJS.Timeout | undefined;
    let wallTimer: NodeJS.Timeout | undefined;
    let resolveResult!: (result: CommandCodeProcessRunResult) => void;

    const resultPromise = new Promise<CommandCodeProcessRunResult>((resolve) => { resolveResult = resolve; });
    const clearTimers = () => {
      if (graceTimer) clearTimeout(graceTimer);
      if (wallTimer) clearTimeout(wallTimer);
    };
    const killGroup = (signalToSend: NodeJS.Signals): void => {
      if (typeof child.pid !== 'number') return;
      try {
        process.kill(-child.pid, signalToSend);
      } catch {
        try { child.kill(signalToSend); } catch { /* already gone */ }
      }
    };
    const terminate = (cause: 'abort' | 'timeout' | 'shutdown'): void => {
      if (settled || terminationCause) return;
      terminationCause = cause;
      killGroup('SIGTERM');
      graceTimer = setTimeout(() => {
        if (!settled) killGroup('SIGKILL');
      }, this.processGraceMs);
      graceTimer.unref?.();
    };
    const active: ActiveProcess = { child, resultPromise, terminate };
    this.active.set(input.sessionId, active);
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      let parsed: ParsedCommandCodeOutput | undefined;
      if (!protocolError) {
        try {
          parsed = parser.finish(exitCode, signal);
        } catch (error) {
          protocolError = error instanceof Error ? error.message : String(error);
        }
      }
      this.active.delete(input.sessionId);
      resolveResult({
        ...(parsed ? { parsed } : {}),
        exitCode,
        signal,
        stderrTail,
        ...(terminationCause ? { terminationCause } : {}),
        ...(protocolError ? { protocolError } : {}),
        ...(spawnError ? { spawnError } : {}),
      });
    };

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (settled || protocolError) return;
      try { parser.push(chunk); }
      catch (error) {
        protocolError = error instanceof Error ? error.message : String(error);
        terminate('timeout');
      }
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderrTail = boundedTail(`${stderrTail}${redactSensitive(String(chunk))}`, this.maxStderrBytes);
    });
    child.once('error', (error) => {
      spawnError = redactSensitive(error.message);
      finish();
    });
    child.stdin?.once('error', (error) => {
      spawnError = redactSensitive(error instanceof Error ? error.message : String(error));
      terminate('abort');
    });
    // Wait for `close`, not `exit`: stdout/stderr pipes can flush after the
    // process exits and before their close events. Finishing at `exit` would
    // discard a valid terminal NDJSON frame.
    child.once('close', (code, childSignal) => {
      exitCode = code;
      signal = childSignal;
      finish();
    });

    try {
      child.stdin?.write(input.prompt, 'utf8');
      child.stdin?.end();
    } catch (error) {
      spawnError = redactSensitive(error instanceof Error ? error.message : String(error));
      terminate('abort');
    }
    wallTimer = setTimeout(() => terminate('timeout'), this.maxWallTimeMs);
    wallTimer.unref?.();

    return resultPromise;
  }

  async abort(sessionId: string): Promise<void> {
    const active = this.active.get(sessionId);
    if (!active) return;
    active.terminate('abort');
    await active.resultPromise;
  }

  async shutdown(): Promise<void> {
    const active = [...this.active.values()];
    for (const process of active) process.terminate('shutdown');
    await Promise.all(active.map((process) => process.resultPromise));
    this.closeBrowserPolicyRoots();
    closePinnedFile(this.executableBinding);
    closePinnedFile(this.browserSandboxBinding);
    this.executableBinding = undefined;
    this.browserSandboxBinding = undefined;
  }

  private closeBrowserPolicyRoots(): void {
    closePinnedDirectories([
      ...this.browserAllowedCwdBindings,
      ...this.browserRuntimeRootBindings,
      ...(this.browserNativeHomeBinding ? [this.browserNativeHomeBinding] : []),
    ]);
    this.browserAllowedCwdRoots = [];
    this.browserRuntimeRoots = [];
    this.browserAllowedCwdBindings = [];
    this.browserRuntimeRootBindings = [];
    this.browserNativeHomeBinding = undefined;
  }

  isRunning(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  activeSessionIds(): string[] {
    return [...this.active.keys()];
  }
}

function buildBrowserLaunch(input: {
  executablePath: string;
  executableBinding?: PinnedFile;
  args: string[];
  cwd: string;
  sessionId: string;
  sandboxExecutablePath?: string;
  sandboxBinding?: PinnedFile;
  allowedCwdRoots: string[];
  runtimeRoots: string[];
  nativeHomeDir?: string;
  allowedCwdBindings: PinnedDirectory[];
  runtimeRootBindings: PinnedDirectory[];
  nativeHomeBinding?: PinnedDirectory;
  browserAuthFd?: number;
  browserAuthIdentity?: CommandCodeFileIdentity;
}): CommandCodeLaunch {
  if (!input.sandboxExecutablePath || !path.isAbsolute(input.sandboxExecutablePath) || !input.sandboxBinding) {
    throw new Error('Command Code browser sandbox is unavailable');
  }
  if (!input.executableBinding) throw new Error('Command Code executable is not pinned');
  const cwd = path.resolve(input.cwd);
  const allowedBinding = input.allowedCwdBindings.find((binding) => isWithinRoot(binding.path, cwd));
  if (!allowedBinding || !input.allowedCwdRoots.some((root) => isWithinRoot(root, cwd))) {
    throw new Error('Command Code browser cwd is outside the configured browser roots');
  }
  if (!input.nativeHomeDir || !input.nativeHomeBinding) throw new Error('Command Code browser native home is unavailable');
  if (!/^[-a-zA-Z0-9_]+$/.test(input.sessionId)) throw new Error('Command Code browser session id is invalid');
  const mountRoots = [...new Set(input.runtimeRoots.map((root) => path.resolve(root)))];
  if (mountRoots.length === 0) throw new Error('Command Code browser runtime roots are unavailable');
  if (mountRoots.some(isBroadRuntimeRoot)) throw new Error('Command Code browser runtime roots are too broad');
  if (input.runtimeRootBindings.length !== mountRoots.length) throw new Error('Command Code browser runtime roots are not pinned');

  const opened: number[] = [];
  try {
    const cwdRelative = path.relative(allowedBinding.path, cwd);
    const cwdFd = cwdRelative === ''
      ? allowedBinding.fd
      : openDirectoryBelowPinnedRoot(allowedBinding.fd, cwdRelative, opened);
    const sessionHomeFd = openDirectoryBelowPinnedRoot(input.nativeHomeBinding.fd, input.sessionId, opened);
    openDirectoryBelowPinnedRoot(sessionHomeFd, '.commandcode', opened);
    if (input.browserAuthFd === undefined || !input.browserAuthIdentity) {
      throw new Error('Command Code browser auth is not pinned');
    }
    if (!sameFileIdentity(input.browserAuthFd, input.browserAuthIdentity)) {
      throw new Error('Command Code browser auth binding changed');
    }
    if (!sameFileIdentity(input.sandboxBinding.fd, input.sandboxBinding.identity)) {
      throw new Error('Command Code browser sandbox binding changed');
    }
    if (!sameFileIdentity(input.executableBinding.fd, input.executableBinding.identity)) {
      throw new Error('Command Code executable binding changed');
    }
    if (input.runtimeRootBindings.some((binding, index) => binding.path !== mountRoots[index] || !sameFileIdentity(binding.fd, binding.identity))) {
      throw new Error('Command Code browser runtime roots changed after validation');
    }
    if (!sameFileIdentity(input.nativeHomeBinding.fd, input.nativeHomeBinding.identity)) throw new Error('Command Code browser native home changed after validation');
    if (!sameFileIdentity(allowedBinding.fd, allowedBinding.identity)) throw new Error('Command Code browser workspace root changed after validation');

    // Child fd 3 is the pinned Bubblewrap launcher and fd 4 is the pinned
    // Command Code executable. All later mount sources are allocated after
    // those fixed descriptors; never prepend them after constructing paths.
    const sourceFds: number[] = [input.sandboxBinding.fd, input.executableBinding.fd];
    const sourcePath = (fd: number): string => {
      const childFd = 3 + sourceFds.length;
      sourceFds.push(fd);
      return `/proc/self/fd/${childFd}`;
    };
    const args = [
      '--die-with-parent', '--new-session',
      '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup', '--unshare-net',
      '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', '/run',
      // The standard runtime roots are supplied by policy; the symlinks restore
      // the conventional loader paths without mounting the host /lib aliases.
      ...input.runtimeRootBindings.map((binding) => ['--ro-bind', sourcePath(binding.fd), binding.path]).flat(),
      '--symlink', 'usr/bin', '/bin',
      '--symlink', 'usr/lib', '/lib',
      '--symlink', 'usr/lib64', '/lib64',
      '--dir', '/home', '--bind', sourcePath(sessionHomeFd), '/home/commandcode',
      '--ro-bind', sourcePath(cwdFd), '/workspace', '--chdir', '/workspace',
      '--ro-bind', sourcePath(input.browserAuthFd), '/home/commandcode/.commandcode/auth.json',
      '--setenv', 'HOME', '/home/commandcode',
      '--setenv', 'XDG_CONFIG_HOME', '/home/commandcode/.config',
      '--setenv', 'XDG_DATA_HOME', '/home/commandcode/.local/share',
      '--setenv', 'XDG_CACHE_HOME', '/home/commandcode/.cache',
      '--setenv', 'PATH', '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      '--', '/proc/self/fd/4', ...input.args,
    ];
    return {
      command: '/proc/self/fd/3',
      args,
      cwd: '/',
      env: controlledEnvironment(undefined, undefined),
      stdio: ['pipe', 'pipe', 'pipe', ...sourceFds],
      cleanup: () => closePinnedDirectories(opened.map((fd) => ({ path: '', fd }))),
    };
  } catch (error) {
    closePinnedDirectories(opened.map((fd) => ({ path: '', fd })));
    throw error;
  }
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function isBroadWorkspaceRoot(root: string): boolean {
  const canonical = path.resolve(root);
  return new Set(['/','/home','/root','/tmp','/var','/etc','/usr','/bin','/sbin','/lib','/lib64']).has(canonical);
}

function isBroadRuntimeRoot(root: string): boolean {
  const canonical = path.resolve(root);
  // Require narrow, purpose-specific runtime directories. Even read-only
  // mounts can disclose host configuration, credentials, or source code.
  return new Set(['/','/home','/root','/tmp','/var','/usr','/usr/local','/etc','/bin','/sbin','/lib','/lib64']).has(canonical);
}

function overlapsRoot(left: string, right: string | undefined): boolean {
  if (!right) return false;
  return isWithinRoot(left, right) || isWithinRoot(right, left);
}

function openPinnedDirectory(directory: string, expected?: CommandCodeFileIdentity): PinnedDirectory {
  const metadata = lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`Command Code browser root is not a regular directory: ${directory}`);
  const fd = openSync(directory, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isDirectory()) throw new Error(`Command Code browser root is not a directory: ${directory}`);
    if (expected && (opened.dev !== expected.dev || opened.ino !== expected.ino)) throw new Error(`Command Code browser root changed during validation: ${directory}`);
    return { path: path.resolve(directory), fd, identity: { dev: opened.dev, ino: opened.ino } };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function openPinnedExecutable(file: string, expected?: CommandCodeFileIdentity): PinnedFile {
  const fd = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) throw new Error(`Command Code executable is not a regular file: ${file}`);
    if (expected && (opened.dev !== expected.dev || opened.ino !== expected.ino)) throw new Error(`Command Code executable changed during validation: ${file}`);
    return { path: path.resolve(file), fd, identity: { dev: opened.dev, ino: opened.ino } };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function closePinnedFile(binding: PinnedFile | undefined): void {
  if (!binding) return;
  try { closeSync(binding.fd); } catch { /* already closed */ }
}

function openDirectoryBelowPinnedRoot(rootFd: number, relative: string, opened: number[]): number {
  let currentFd = rootFd;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    if (component === '.' || component === '..') throw new Error('Command Code browser cwd has an invalid relative path');
    const nextFd = openSync(`/proc/self/fd/${currentFd}/${component}`, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0));
    const metadata = fstatSync(nextFd);
    if (!metadata.isDirectory()) {
      closeSync(nextFd);
      throw new Error('Command Code browser cwd is not a directory');
    }
    opened.push(nextFd);
    currentFd = nextFd;
  }
  return currentFd;
}

function closePinnedDirectories(bindings: Array<{ fd: number }>): void {
  for (const binding of bindings) {
    try { closeSync(binding.fd); } catch { /* already closed */ }
  }
}

function sameFileIdentity(fd: number, expected: CommandCodeFileIdentity): boolean {
  const actual = fstatSync(fd);
  return actual.dev === expected.dev && actual.ino === expected.ino;
}

function controlledEnvironment(nativeHomeDir?: string, sessionId?: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENV_KEYS) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  if (nativeHomeDir) {
    const sessionHome = sessionId && /^[-a-zA-Z0-9_]+$/.test(sessionId)
      ? path.join(nativeHomeDir, sessionId)
      : nativeHomeDir;
    environment.HOME = sessionHome;
    environment.XDG_CONFIG_HOME = `${sessionHome}/.config`;
    environment.XDG_DATA_HOME = `${sessionHome}/.local/share`;
    environment.XDG_CACHE_HOME = `${sessionHome}/.cache`;
  }
  return environment;
}

function redactSensitive(value: string): string {
  return value
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/((?:token|secret|password|api[_-]?key)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi, '$1[REDACTED]')
    .replace(/(\b(?:token|secret|password|api[_-]?key)\b\s+)(?:"[^"]*"|'[^']*'|\S+)/gi, '$1[REDACTED]');
}

function boundedTail(value: string, maxBytes: number): string {
  let result = value;
  while (Buffer.byteLength(result, 'utf8') > maxBytes) result = result.slice(Math.ceil(result.length / 4));
  return result;
}
