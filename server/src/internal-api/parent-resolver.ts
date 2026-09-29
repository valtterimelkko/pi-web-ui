/**
 * C5 (contract 1.54.0) — "lineage always recorded": peer-credential caller
 * resolution for Internal-API create paths.
 *
 * Header-first linkage (X-Parent-Session / body parentSessionId) and the
 * in-flight bash correlator (child-linkage.ts) leave a gap: a managed session
 * whose tool subprocesses carry no correlator-visible pi events (e.g. a Claude
 * runtime subprocess creating a child via bash) creates silently unlinked
 * children. This module closes that gap from the server side.
 *
 * Node exposes no SO_PEERCRED on this runtime (net.Socket has no
 * getPeerCredentials), so peer credentials are reconstructed read-only:
 *
 *   1. The accepted connection's server-side socket inode comes from
 *      /proc/self/fd/<fd>.
 *   2. `ss -xp` (unix_diag) maps that inode to the peer socket. The first
 *      snapshot is NARROWED to the Internal API socket path (`src <path>`
 *      filter) so output stays small; if that misses (older iproute2 or a
 *      race), the full established table is read with an explicit 8 MiB
 *      maxBuffer. Output above maxBuffer → no linkage plus a rate-limited
 *      warning (never a partial parse).
 *   3. The peer end's owners come from a bounded /proc/<pid>/fd scan (the
 *      users: column is not needed). More owners than the safe bound → the
 *      set is truncated → NO linkage.
 *   4. A bounded walk up /proc/<pid> ancestry reads each process environment
 *      for the session identity the server itself sets on managed runtime
 *      subprocesses: PI_WEB_UI_SESSION_ID (contract 1.47.0; Claude,
 *      Antigravity, Command Code) or PI_SESSION_ID (pi tool subprocesses).
 *
 * Trust rationale: the identity variables are values the server (or the pi
 * harness) placed on its own subprocesses. A hostile client could set them
 * itself — exactly as it could lie via X-Parent-Session, the trust level the
 * existing linkage already accepts (display-only metadata on a local,
 * same-user socket). Safeguards beyond the header (correction 01, fail-closed
 * ambiguity): EVERY peer owner is resolved; a truncated owner set, any
 * identity-less owner, or divergent owners give NO linkage — never a guess.
 * The server's own environment is never consulted.
 */

import { execFile } from 'node:child_process';
import { readlink, readdir } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import type { LinkageRegistry } from './child-linkage.js';

/** Session identity variables, in preference order. */
export const CALLER_IDENTITY_ENV_KEYS = ['PI_WEB_UI_SESSION_ID', 'PI_SESSION_ID'] as const;

/** Depth cap for the /proc ancestry walk (defence against cycles). */
const MAX_ANCESTRY_DEPTH = 32;

/** Safe bound on peer owners per connection; a larger set gives no linkage. */
const MAX_PEER_OWNERS = 8;

/** Cap on /proc directories scanned per owners lookup (fail closed beyond it). */
const MAX_PROC_DIRS = 16384;

/** maxBuffer for the ss snapshot narrowed to the Internal API socket path.
 *  A handful of concurrent API connections at ~200 bytes per line is orders
 *  of magnitude below this; overflow is handled, never partially parsed. */
const SS_NARROW_MAX_BUFFER = 256 * 1024;

/** maxBuffer for the full established-table fallback (8 MiB: on this host the
 *  table is ~0.3 MB; five heads of headroom before we refuse rather than parse
 *  a truncated snapshot). */
const SS_FULL_MAX_BUFFER = 8 * 1024 * 1024;

/** Minimum interval between two overflow warnings. */
const WARN_INTERVAL_MS = 60_000;

/** One established AF_UNIX socket from `ss -xp`. */
export interface SocketPeerEntry {
  localInode: number;
  peerInode: number;
  /** Historical users: column — owner attribution now uses the /proc scan. */
  pids: number[];
}

export type SsResult =
  | { kind: 'ok'; output: string }
  | { kind: 'overflow' }
  | { kind: 'unavailable' };

/**
 * Parse `ss -xp state established` output. With a state filter ss drops the
 * State column, so parsing is right-anchored: [..., localPath, localInode,
 * peerPath, peerInode, users:(...)]. Only established stream sockets (u_str)
 * with a non-zero peer are relevant; everything else is ignored.
 */
export function parseSsEstablishedLines(output: string): SocketPeerEntry[] {
  const entries: SocketPeerEntry[] = [];
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('u_str ')) continue;
    const usersStart = line.indexOf('users:((');
    const pids: number[] = [];
    let addressPart = line;
    if (usersStart >= 0) {
      const usersPart = line.slice(usersStart);
      addressPart = line.slice(0, usersStart).trimEnd();
      for (const match of usersPart.matchAll(/pid=(\d+)/g)) {
        const pid = Number(match[1]);
        if (!pids.includes(pid)) pids.push(pid);
      }
    }
    const tokens = addressPart.split(/\s+/);
    if (tokens.length < 4) continue;
    const peerInode = Number(tokens[tokens.length - 1]);
    const localInode = Number(tokens[tokens.length - 3]);
    if (!Number.isInteger(peerInode) || !Number.isInteger(localInode)) continue;
    if (localInode <= 0 || peerInode <= 0) continue; // listening / unconnected
    entries.push({ localInode, peerInode, pids });
  }
  return entries;
}

/**
 * The peer inode of the connection whose end is `ownInode`; null when
 * `ownInode` is absent from the snapshot.
 */
export function peerInodeOf(entries: SocketPeerEntry[], ownInode: number): number | null {
  const own = entries.find((e) => e.localInode === ownInode) ?? entries.find((e) => e.peerInode === ownInode);
  if (!own) return null;
  return own.localInode === ownInode ? own.peerInode : own.localInode;
}

/** First session identity value in a parsed environment, by key preference. */
export function firstIdentityValue(env: string[]): string | undefined {
  for (const key of CALLER_IDENTITY_ENV_KEYS) {
    for (const entry of env) {
      if (entry.startsWith(`${key}=`)) {
        const value = entry.slice(key.length + 1).trim();
        if (value) return value;
      }
    }
  }
  return undefined;
}

/**
 * Run a command with an EXPLICIT maxBuffer and classify the outcome. A
 * maxBuffer abort is reported as `overflow` — never as missing output — so a
 * truncated snapshot can never be parsed as if it were whole.
 */
export function runSs(command: string, args: string[], maxBuffer: number): Promise<SsResult> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 2000, maxBuffer }, (err, stdout) => {
      if (!err) {
        resolve({ kind: 'ok', output: stdout });
        return;
      }
      const overflow = err.code === 'ENOBUFS'
        || err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
        || /maxbuffer/i.test(String(err.message));
      resolve(overflow ? { kind: 'overflow' } : { kind: 'unavailable' });
    });
  });
}

/**
 * Default owners lookup: a bounded /proc/<pid>/fd scan for processes holding
 * `socket:[peerInode]`. Returns null when the scan is truncated (more owners
 * than the safe bound, or more /proc directories than the scan cap) — the
 * caller must give no linkage. An empty array means the peer end holds no
 * readable owner (e.g. it already exited): also no linkage, but a distinct
 * case for tests.
 */
export async function defaultPeerOwners(peerInode: number): Promise<number[] | null> {
  let dirents: string[];
  try {
    dirents = await readdir('/proc');
  } catch {
    return null;
  }
  const want = `socket:[${String(peerInode)}]`;
  const owners: number[] = [];
  let scanned = 0;
  for (const name of dirents) {
    const pid = Number(name);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (scanned >= MAX_PROC_DIRS) return null; // truncated scan → fail closed
    scanned += 1;
    let fds: string[];
    try {
      fds = await readdir(`/proc/${name}/fd`);
    } catch {
      continue; // vanished or not ours to read; not an owner we can see
    }
    for (const fd of fds) {
      try {
        const link = await readlink(`/proc/${name}/fd/${fd}`);
        if (link === want) {
          if (!owners.includes(pid)) owners.push(pid);
          break;
        }
      } catch {
        continue; // fd vanished mid-scan
      }
    }
  }
  if (owners.length > MAX_PEER_OWNERS) return null; // truncated owner set → no linkage
  return owners;
}

/** Injectable IO for deterministic tests. */
export interface ParentResolverIo {
  /** readlink of /proc/self/fd/<fd> (null when unavailable). */
  readlinkFd(fd: number): Promise<string | null>;
  /**
   * ss snapshot: 'narrow' filters to the Internal API socket path (small
   * output); 'full' is the whole established table. Overflow and
   * unavailability are explicit — a truncated snapshot is never returned.
   */
  ssEstablished(mode: 'narrow' | 'full'): Promise<SsResult>;
  /** Owners of the peer socket end; null = truncated set (no linkage). */
  peerOwners(peerInode: number): Promise<number[] | null>;
  /** Parsed environment entries of a pid (null when unreadable). */
  environ(pid: number): Promise<string[] | null>;
  /** Parent pid of a pid (null when unreadable or none). */
  ppid(pid: number): Promise<number | null>;
  /** This server process's pid — the walk terminator. */
  selfPid(): number;
  /** Rate-limited warning sink (overflow and other degradations). */
  warn(message: string): void;
  now(): number;
  registry: LinkageRegistry;
}

export interface PeerParentResolution {
  sessionId: string;
  source: 'peer';
}

async function defaultSsEstablished(
  mode: 'narrow' | 'full',
  socketPath: string | undefined,
): Promise<SsResult> {
  if (mode === 'narrow' && socketPath) {
    return runSs('ss', ['-xp', 'state', 'established', 'src', socketPath], SS_NARROW_MAX_BUFFER);
  }
  return runSs('ss', ['-xp', 'state', 'established'], SS_FULL_MAX_BUFFER);
}

/**
 * Walk up from `startPid`, returning the first session identity value found on
 * any ancestor. Stops at selfPid (the server's own environment is never
 * consulted — a stale inherited value there must never link), pid 1, unreadable
 * ancestry, or the depth cap.
 */
export async function walkAncestryForSession(
  startPid: number,
  io: Pick<ParentResolverIo, 'environ' | 'ppid' | 'selfPid'>,
): Promise<string | undefined> {
  let pid = startPid;
  for (let depth = 0; depth < MAX_ANCESTRY_DEPTH; depth += 1) {
    if (!Number.isInteger(pid) || pid <= 1 || pid === io.selfPid()) return undefined;
    const env = await io.environ(pid).catch(() => null);
    if (env) {
      const value = firstIdentityValue(env);
      if (value) return value;
    }
    const parent = await io.ppid(pid).catch(() => null);
    if (!parent || parent === pid) return undefined;
    pid = parent;
  }
  return undefined;
}

/**
 * Create the resolver. `socketPath` narrows the ss snapshot to this server's
 * Internal API socket; io entries are injectable for tests. The single public
 * entry point is `resolve(req)`: given an Internal API request over the unix
 * socket, return the caller's registry session when it can be attributed with
 * confidence — unanimous, untruncated owners only — else null.
 */
export function createPeerParentResolver(
  overrides: Partial<ParentResolverIo> & { socketPath?: string } = {},
) {
  const socketPath = overrides.socketPath;
  const io: ParentResolverIo = {
    readlinkFd: (fd) => readlink(`/proc/self/fd/${String(fd)}`).catch(() => null),
    ssEstablished: (mode) => defaultSsEstablished(mode, socketPath),
    peerOwners: defaultPeerOwners,
    environ: defaultProcEnviron,
    ppid: defaultPpid,
    selfPid: () => process.pid,
    warn: () => { /* default: silent; the routes factory injects the server logger */ },
    now: () => Date.now(),
    registry: { get: async () => undefined, getByPath: async () => undefined },
    ...overrides,
  };

  let lastWarnAt = -Infinity;
  const warnRateLimited = (message: string): void => {
    const t = io.now();
    if (t - lastWarnAt >= WARN_INTERVAL_MS) {
      lastWarnAt = t;
      try { io.warn(message); } catch { /* never fatal */ }
    }
  };

  async function resolve(req: IncomingMessage): Promise<PeerParentResolution | null> {
    try {
      // 1. The accepted connection's server-side socket inode.
      const socket = (req as { socket?: unknown } | undefined)?.socket as { _handle?: { fd?: unknown } } | undefined;
      const fd = socket?._handle?.fd;
      if (typeof fd !== 'number' || fd < 0) return null;
      const link = await io.readlinkFd(fd);
      if (!link) return null;
      const inodeMatch = link.match(/^socket:\[(\d+)\]$/);
      if (!inodeMatch) return null;
      const ownInode = Number(inodeMatch[1]);

      // 2. Peer inode. Narrow first; fall back to the full table when the
      // narrow snapshot is unavailable (older iproute2) or misses us.
      let snapshot = socketPath ? await io.ssEstablished('narrow') : ({ kind: 'unavailable' } as SsResult);
      if (snapshot.kind === 'unavailable'
        || (snapshot.kind === 'ok' && peerInodeOf(parseSsEstablishedLines(snapshot.output), ownInode) === null)) {
        snapshot = await io.ssEstablished('full');
      }
      if (snapshot.kind === 'overflow') {
        warnRateLimited('parent-resolver: ss snapshot exceeded maxBuffer; skipping peer linkage this request (fail closed)');
        return null;
      }
      if (snapshot.kind !== 'ok') return null;
      const peerInode = peerInodeOf(parseSsEstablishedLines(snapshot.output), ownInode);
      if (peerInode === null) return null;

      // 3. Owners of the peer end. A truncated set gives no linkage
      // (correction 01: never resolve a partial owner list).
      const owners = await io.peerOwners(peerInode);
      if (!owners || owners.length === 0) return null;

      // 4. Ancestry identity walk for EVERY owner; unanimity is required —
      // any identity-less or divergent owner gives no linkage.
      const values = new Set<string>();
      for (const pid of owners) {
        const value = await walkAncestryForSession(pid, io);
        if (value === undefined) return null;
        values.add(value);
        if (values.size > 1) return null;
      }
      if (values.size !== 1) return null;
      const claimed = [...values][0];

      // 5. The identity must name a session in the registry.
      const entry = (await io.registry.get(claimed).catch(() => undefined))
        ?? (await io.registry.getByPath(claimed).catch(() => undefined));
      if (!entry) return null;
      return { sessionId: entry.id, source: 'peer' };
    } catch {
      return null;
    }
  }

  return { resolve };
}

async function defaultProcEnviron(pid: number): Promise<string[] | null> {
  const { readFile } = await import('node:fs/promises');
  try {
    const raw = await readFile(`/proc/${String(pid)}/environ`, 'utf-8');
    return raw.split('\0').filter((s) => s.length > 0);
  } catch {
    return null;
  }
}

async function defaultPpid(pid: number): Promise<number | null> {
  const { readFile } = await import('node:fs/promises');
  try {
    const stat = await readFile(`/proc/${String(pid)}/stat`, 'utf-8');
    // comm may contain spaces and parentheses: parse after the last ')'.
    const afterComm = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
    const ppid = Number(afterComm[1]); // [0] is state; ppid is field 4 overall
    return Number.isInteger(ppid) && ppid > 0 ? ppid : null;
  } catch {
    return null;
  }
}
