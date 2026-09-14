/**
 * Owned-process handling for the lab capsule.
 *
 * Every child the lab starts is tracked by PID **and** its `/proc/<pid>/stat`
 * start time. That pair is what makes cleanup safe: a bare PID can be reused
 * by an unrelated process between "start" and "stop", and signalling a reused
 * PID would kill somebody else's work. Signals are therefore only ever sent
 * after re-reading the identity and confirming it still matches.
 *
 * There is deliberately no pattern-based killing anywhere in this module. A
 * `pkill -f <pattern>` (or `killall`) matches whatever the pattern happens to
 * hit — including the invoking shell, which happened during this lab's build —
 * and has no notion of ownership. Group teardown enumerates `/proc` for
 * members of the recorded process group and verifies identity before
 * signalling.
 */

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { closeSync, existsSync, openSync, readdirSync, readFileSync } from 'node:fs';

export interface ProcessIdentity {
  pid: number;
  /** Field 22 of /proc/<pid>/stat — start time in clock ticks since boot. */
  startTimeTicks: number;
  /** Field 4 of /proc/<pid>/stat, without the surrounding parentheses. */
  comm: string;
}

interface ParsedStat {
  comm: string;
  state: string;
  ppid: number;
  pgrp: number;
  startTimeTicks: number;
}

const ZOMBIE_STATES = new Set(['Z', 'X', 'x']);

function parseStat(stat: string): ParsedStat | null {
  // comm may contain spaces and parentheses; it is delimited by the FIRST '('
  // and the LAST ')' in the line.
  const open = stat.indexOf('(');
  const close = stat.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const rest = stat.slice(close + 2).trim().split(/\s+/);
  // rest[0] = state (field 3). starttime is field 22 => rest[19].
  if (rest.length < 20) return null;
  const startTimeTicks = Number.parseInt(rest[19], 10);
  if (!Number.isFinite(startTimeTicks)) return null;
  return {
    comm: stat.slice(open + 1, close),
    state: rest[0],
    ppid: Number.parseInt(rest[1], 10),
    pgrp: Number.parseInt(rest[2], 10),
    startTimeTicks,
  };
}

function readStat(pid: number): ParsedStat | null {
  try {
    return parseStat(readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return null;
  }
}

/** Read one process's identity, or null when it does not exist. */
export function readIdentity(pid: number): ProcessIdentity | null {
  const parsed = readStat(pid);
  if (!parsed) return null;
  return { pid, startTimeTicks: parsed.startTimeTicks, comm: parsed.comm };
}

/** True only when this exact process (same PID *and* start time) is alive.
 *  Zombies are not alive: they hold no resources and are about to be reaped,
 *  so treating one as "still running" would report a false orphan. */
export function identityMatches(identity: ProcessIdentity): boolean {
  const current = readStat(identity.pid);
  return (
    current !== null && current.startTimeTicks === identity.startTimeTicks && !ZOMBIE_STATES.has(current.state)
  );
}

/** Live (non-zombie) members of a process group. Used instead of a pattern
 *  match so teardown can only ever touch the lab's own group. */
export function groupMembers(pgid: number): ProcessIdentity[] {
  const members: ProcessIdentity[] = [];
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    return members;
  }
  for (const entry of entries) {
    const pid = Number.parseInt(entry, 10);
    if (!Number.isFinite(pid)) continue;
    const parsed = readStat(pid);
    if (!parsed || parsed.pgrp !== pgid) continue;
    if (ZOMBIE_STATES.has(parsed.state)) continue;
    members.push({ pid, startTimeTicks: parsed.startTimeTicks, comm: parsed.comm });
  }
  return members;
}

export interface OwnedProcessOptions {
  command: string;
  args: string[];
  /** Environment is ALWAYS explicit. Inheriting NODE_ENV=production from the
   *  shell silently changed what `npm ci` installed during this lab's build,
   *  and would equally change what a child server boots as. */
  env: NodeJS.ProcessEnv;
  cwd?: string;
  /** stderr (and stdout when no `stdoutPath` is given) is appended here. */
  logPath: string;
  /** When set, the child's stdout goes to this file instead of the log —
   *  required for `parec`, whose stdout IS the audio. */
  stdoutPath?: string;
  /** Start in a new process group so the whole tree can be addressed as one. */
  detached?: boolean;
}

export class OwnedProcess {
  readonly identity: ProcessIdentity;
  readonly command: string;
  readonly args: string[];
  readonly logPath: string;
  private exited = false;
  private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  private readonly tracked: ChildProcess;

  private constructor(child: ChildProcess, identity: ProcessIdentity, options: OwnedProcessOptions) {
    this.tracked = child;
    this.identity = identity;
    this.command = options.command;
    this.args = options.args;
    this.logPath = options.logPath;
    child.once('exit', (code, signal) => {
      this.exited = true;
      this.exitInfo = { code, signal };
    });
    child.on('error', () => {
      this.exited = true;
    });
  }

  private static async fromChild(
    child: ChildProcess,
    options: OwnedProcessOptions
  ): Promise<OwnedProcess> {
    const pid = child.pid;
    if (pid === undefined) throw new Error(`Failed to spawn ${options.command}: no pid`);
    // Reading /proc can race a very short-lived child; retry briefly.
    let identity = readIdentity(pid);
    for (let attempt = 0; attempt < 100 && identity === null; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      identity = readIdentity(pid);
    }
    if (!identity) {
      throw new Error(`Spawned ${options.command} (pid ${pid}) but could not read its identity`);
    }
    return new OwnedProcess(child, identity, options);
  }

  /** Spawn a tracked child and return only once its identity is verified. */
  static async spawn(options: OwnedProcessOptions): Promise<OwnedProcess> {
    const stdoutFd = options.stdoutPath
      ? openSync(options.stdoutPath, 'w')
      : openSync(options.logPath, 'a');
    const stderrFd = stdoutFd === undefined ? undefined : openSync(options.logPath, 'a');
    const detached = options.detached ?? true;
    const spawnOptions: SpawnOptions = {
      cwd: options.cwd,
      env: options.env,
      detached,
      stdio: ['ignore', stdoutFd, stderrFd],
    };
    const child = spawn(options.command, options.args, spawnOptions);
    try {
      closeSync(stdoutFd);
      if (stderrFd !== undefined && stderrFd !== stdoutFd) closeSync(stderrFd);
    } catch {
      // The child holds its own descriptors.
    }
    try {
      return await OwnedProcess.fromChild(child, options);
    } catch (error) {
      try {
        child.kill('SIGKILL');
      } catch {
        // Best effort: the child may already be gone.
      }
      throw error;
    }
  }

  /** Wrap an already-spawned child (used when a caller needs a bespoke stdio
   *  setup, e.g. the recorder writing PCM directly to a file descriptor). */
  static async adopt(child: ChildProcess, options: OwnedProcessOptions): Promise<OwnedProcess> {
    return OwnedProcess.fromChild(child, options);
  }

  isAlive(): boolean {
    return !this.exited && identityMatches(this.identity);
  }

  liveGroupMembers(includeLeader = true): ProcessIdentity[] {
    return groupMembers(this.identity.pid).filter(
      (member) => includeLeader || member.pid !== this.identity.pid
    );
  }

  /** Signal every verified member of the owned process group. Only members
   *  whose `/proc` entry still matches the enumerated identity are touched. */
  signalGroup(signal: NodeJS.Signals): number {
    let signalled = 0;
    for (const member of groupMembers(this.identity.pid)) {
      const current = readStat(member.pid);
      if (!current || current.startTimeTicks !== member.startTimeTicks) continue;
      try {
        process.kill(member.pid, signal);
        signalled += 1;
      } catch {
        // Exited between enumeration and signal.
      }
    }
    return signalled;
  }

  async waitForExit(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.exited && this.liveGroupMembers().length === 0) return true;
      if (this.exited && groupMembers(this.identity.pid).length === 0) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return this.exited && groupMembers(this.identity.pid).length === 0;
  }

  /** Graceful stop, then forced. Returns what actually happened. */
  async stop(graceMs = 3000, forceMs = 3000): Promise<'exited' | 'killed' | 'timeout'> {
    if (this.exited && groupMembers(this.identity.pid).length === 0) return 'exited';
    this.signalGroup('SIGTERM');
    if (await this.waitForExit(graceMs)) return 'exited';
    this.signalGroup('SIGKILL');
    if (await this.waitForExit(forceMs)) return 'killed';
    return 'timeout';
  }

  get exit(): { code: number | null; signal: NodeJS.Signals | null } | null {
    return this.exitInfo;
  }
}

export interface CleanupReport {
  residuals: Array<{ kind: string; detail: string }>;
  ok: boolean;
}

/** Assert that nothing the capsule owned is still running or listening.
 *  Called on the normal path, the exception path and the SIGTERM path, so a
 *  crashed run cannot leave an orphaned browser, display or audio daemon. */
export function verifyNoResiduals(input: {
  identities: ProcessIdentity[];
  listeners: Array<{ pid: number; detail: string }>;
  extraPaths?: string[];
}): CleanupReport {
  const residuals: CleanupReport['residuals'] = [];
  for (const identity of input.identities) {
    const current = readStat(identity.pid);
    if (!current) continue;
    if (current.startTimeTicks !== identity.startTimeTicks) continue;
    if (ZOMBIE_STATES.has(current.state)) continue;
    residuals.push({
      kind: 'process',
      detail: `pid ${identity.pid} (${identity.comm}) still alive`,
    });
  }
  for (const listener of input.listeners) {
    residuals.push({ kind: 'listener', detail: `${listener.detail} (pid ${listener.pid})` });
  }
  for (const extra of input.extraPaths ?? []) {
    if (existsSync(extra)) residuals.push({ kind: 'path', detail: `${extra} still exists` });
  }
  return { residuals, ok: residuals.length === 0 };
}

/** Parse `ss` output for listening sockets owned by the given PIDs. */
export function parseListeners(
  ssOutput: string,
  pids: Set<number>
): Array<{ pid: number; detail: string }> {
  const found: Array<{ pid: number; detail: string }> = [];
  for (const line of ssOutput.split('\n')) {
    if (!line.trim()) continue;
    for (const match of line.matchAll(/pid=(\d+)/g)) {
      const pid = Number.parseInt(match[1], 10);
      if (!pids.has(pid)) continue;
      found.push({ pid, detail: line.trim().slice(0, 200) });
    }
  }
  return found;
}
