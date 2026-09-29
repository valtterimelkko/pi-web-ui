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
 *   2. `ss -xp state established` (unix_diag) maps that inode to the peer
 *      socket and its owning client pid(s).
 *   3. A bounded walk up /proc/<pid> ancestry reads each process environment
 *      for the session identity the server itself sets on managed runtime
 *      subprocesses: PI_WEB_UI_SESSION_ID (contract 1.47.0; Claude,
 *      Antigravity, Command Code) or PI_SESSION_ID (pi tool subprocesses).
 *
 * Trust rationale: the identity variables are values the server (or the pi
 * harness) placed on its own subprocesses. A hostile client could set them
 * itself — exactly as it could lie via X-Parent-Session, the trust level the
 * existing linkage already accepts (display-only metadata on a local,
 * same-user socket). Two safeguards go beyond the header: every resolved value
 * must name a session in the registry, and disagreeing candidate walks yield
 * NO linkage rather than a guess. Every failure mode below returns null —
 * unlinked, never wrongly linked.
 */

import { execFile } from 'node:child_process';
import { readlink } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import type { LinkageRegistry } from './child-linkage.js';

/** Session identity variables, in preference order. */
export const CALLER_IDENTITY_ENV_KEYS = ['PI_WEB_UI_SESSION_ID', 'PI_SESSION_ID'] as const;

/** Depth cap for the /proc ancestry walk (defence against cycles). */
const MAX_ANCESTRY_DEPTH = 32;

/** Cap on candidate client pids per connection (fd inheritance can share fds widely). */
const MAX_CANDIDATE_PIDS = 8;

/** One established AF_UNIX socket from `ss -xp`. */
export interface SocketPeerEntry {
  localInode: number;
  peerInode: number;
  /** Pids owning this end (empty when the owner could not be read). */
  pids: number[];
}

/**
 * Parse `ss -xp state established` output. With a state filter ss drops the
 * State column, so parsing is right-anchored: [..., localPath, localInode,
 * peerPath, peerInode, users:(...)]. Only established stream sockets
 * (u_str) with a non-zero peer are relevant; everything else is ignored.
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
 * The client-side pids for the connection whose server-side end is
 * `ownInode`. Returns null when `ownInode` is absent from the snapshot (the
 * caller may retry with a fresh enumeration); [] when the peer end's owner
 * could not be attributed.
 */
export function candidateClientPids(entries: SocketPeerEntry[], ownInode: number): number[] | null {
  // Our end is normally enumerated itself: the client end is the entry whose
  // LOCAL inode is our peer inode.
  const ownAsLocal = entries.find((e) => e.localInode === ownInode);
  if (ownAsLocal) {
    const peer = entries.find((e) => e.localInode === ownAsLocal.peerInode);
    return peer ? peer.pids.slice(0, MAX_CANDIDATE_PIDS) : [];
  }
  // Our line may be missing from the snapshot while the client's line (whose
  // peer is us) is present; that line is then itself the client end.
  const ownAsPeer = entries.find((e) => e.peerInode === ownInode);
  if (ownAsPeer) return ownAsPeer.pids.slice(0, MAX_CANDIDATE_PIDS);
  return null;
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

/** Injectable IO for deterministic tests. */
export interface ParentResolverIo {
  /** readlink of /proc/self/fd/<fd> (null when unavailable). */
  readlinkFd(fd: number): Promise<string | null>;
  /** `ss -xp state established` output (null when ss is unavailable). */
  ssEstablished(): Promise<string | null>;
  /** Parsed environment entries of a pid (null when unreadable). */
  environ(pid: number): Promise<string[] | null>;
  /** Parent pid of a pid (null when unreadable or none). */
  ppid(pid: number): Promise<number | null>;
  /** This server process's pid — the walk terminator. */
  selfPid(): number;
  registry: LinkageRegistry;
}

export interface PeerParentResolution {
  sessionId: string;
  source: 'peer';
}

async function defaultSsEstablished(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('ss', ['-xp', 'state', 'established'], { timeout: 2000 }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

/** Injectable IO for deterministic tests. */
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
 * Create the resolver. The single public entry point is `resolve(req)`: given
 * an Internal API request over the unix socket, return the caller's registry
 * session when it can be attributed with confidence, else null.
 */
export function createPeerParentResolver(overrides: Partial<ParentResolverIo> = {}) {
  const io: ParentResolverIo = {
    readlinkFd: (fd) => readlink(`/proc/self/fd/${String(fd)}`).catch(() => null),
    ssEstablished: defaultSsEstablished,
    environ: defaultProcEnviron,
    ppid: defaultPpid,
    selfPid: () => process.pid,
    registry: { get: async () => undefined, getByPath: async () => undefined },
    ...overrides,
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

      // 2. Client pids via the ss snapshot.
      const output = await io.ssEstablished();
      if (output === null) return null;
      const pids = candidateClientPids(parseSsEstablishedLines(output), ownInode);
      if (!pids || pids.length === 0) return null;

      // 3. Ancestry identity walk per candidate; ambiguous walks fail safe.
      const values = new Set<string>();
      for (const pid of pids) {
        const value = await walkAncestryForSession(pid, io);
        if (value) values.add(value);
        if (values.size > 1) return null;
      }
      if (values.size !== 1) return null;
      const claimed = [...values][0];

      // 4. The identity must name a session in the registry.
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
