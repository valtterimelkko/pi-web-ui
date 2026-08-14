import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import path from 'node:path';
import { buildCommandCodeArgs } from './command-code-config.js';
import type { CommandCodeEffort, CommandCodeRuntimeModel } from './command-code-model-catalog.js';
import { CommandCodeNdjsonParser, type ParsedCommandCodeEvent, type ParsedCommandCodeOutput } from './command-code-ndjson-parser.js';

export interface CommandCodeSpawnOptions extends SpawnOptions {
  detached: true;
  shell: false;
  cwd: string;
}

export type CommandCodeSpawn = (command: string, args: string[], options: CommandCodeSpawnOptions) => ChildProcess;

export interface CommandCodeProcessRunInput {
  sessionId: string;
  cwd: string;
  model: CommandCodeRuntimeModel;
  maxTurns: number;
  prompt: string;
  nativeSessionId?: string;
  effort?: CommandCodeEffort;
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
      nativeSessionId: input.nativeSessionId,
      effort: input.effort,
    });
    // One direct child process with ordinary host networking, exactly like the
    // other runtimes: validated absolute executable, private native home,
    // bounded stdio, process-group cleanup.
    const child = this.spawn(this.executablePath, args, {
      cwd: input.cwd,
      detached: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: controlledEnvironment(this.nativeHomeDir, input.sessionId),
    });
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
  }

  isRunning(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  activeSessionIds(): string[] {
    return [...this.active.keys()];
  }
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
    .replace(/((?:token|secret|password|api[_-]?key)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi, '$1=[REDACTED]')
    .replace(/(\b(?:token|secret|password|api[_-]?key)\b\s+)(?:"[^"]*"|'[^']*'|\S+)/gi, '$1[REDACTED]');
}

function boundedTail(value: string, maxBytes: number): string {
  let result = value;
  while (Buffer.byteLength(result, 'utf8') > maxBytes) result = result.slice(Math.ceil(result.length / 4));
  return result;
}
