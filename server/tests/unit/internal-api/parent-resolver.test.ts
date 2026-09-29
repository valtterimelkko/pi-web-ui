// C5 (contract 1.54.0) — "lineage always recorded": peer-credential caller
// resolution. Node exposes no SO_PEERCRED on this runtime (net.Socket has no
// getPeerCredentials), so the resolver maps the accepted connection's socket
// inode to client pid(s) via `ss -xp` (unix_diag), then walks /proc ancestry
// reading the session identity variables the server itself sets on managed
// runtime subprocesses (contract 1.47.0: PI_WEB_UI_SESSION_ID; Pi keeps
// PI_SESSION_ID). Fail safe: any ambiguity → no linkage, never a wrong link.
import { describe, it, expect } from 'vitest';
import {
  parseSsEstablishedLines,
  candidateClientPids,
  walkAncestryForSession,
  firstIdentityValue,
  createPeerParentResolver,
  type SocketPeerEntry,
  type ParentResolverIo,
} from '../../../src/internal-api/parent-resolver.js';

// Real `ss -xp state established` shapes observed on this host (trimmed to the
// relevant lines). Column layout: netid [state] recvq sendq localPath localInode
// peerPath peerInode users:(...) — the State column disappears when ss is
// invoked with a state filter, so parsing must be right-anchored.
const SS_FIXTURE = [
  'u_str 18     0   /run/api/internal-api.sock 120401527  * 120406157 users:(("MainThread",pid=3128361,fd=23))',
  'u_str 0      768 * 120406157  * 120401527 users:(("curl",pid=3128373,fd=3))',
  'u_str ESTAB 0 0 /tmp/other.sock 111  * 222 users:(("bash",pid=500,fd=4))',
  'u_str ESTAB 0 0 * 222  * 111 users:(("node",pid=600,fd=9))',
  'u_str LISTEN 0 128 /run/api/internal-api.sock 999  * 0 users:(("node",pid=3128361,fd=40))',
  'u_str 0      0   * 555  * 0', // unconnected, no users section
  'u_seq ESTAB 0 0 * 777  * 888 users:(("mystery",pid=700,fd=1))', // non-stream: ignored
  '',
].join('\n');

describe('parseSsEstablishedLines', () => {
  it('parses established u_str pairs from both column layouts (with and without the State column)', () => {
    const entries = parseSsEstablishedLines(SS_FIXTURE);
    const get = (inode: number) => entries.find((e) => e.localInode === inode) ?? entries.find((e) => e.peerInode === inode);
    expect(get(120401527)).toEqual({ localInode: 120401527, peerInode: 120406157, pids: [3128361] });
    expect(get(120406157)).toEqual({ localInode: 120406157, peerInode: 120401527, pids: [3128373] });
    expect(get(111)).toEqual({ localInode: 111, peerInode: 222, pids: [500] });
  });

  it('ignores listening, unconnected and non-stream sockets', () => {
    const entries = parseSsEstablishedLines(SS_FIXTURE);
    expect(entries.find((e) => e.localInode === 999)).toBeUndefined(); // LISTEN
    expect(entries.find((e) => e.localInode === 555)).toBeUndefined(); // peer inode 0
    expect(entries.find((e) => e.localInode === 777)).toBeUndefined(); // u_seq
  });

  it('keeps entries without a users section (unreadable owner) with an empty pid list', () => {
    const entries = parseSsEstablishedLines('u_str ESTAB 0 0 * 880  * 881');
    expect(entries).toEqual<SocketPeerEntry[]>([{ localInode: 880, peerInode: 881, pids: [] }]);
  });

  it('returns [] for empty or unparseable output', () => {
    expect(parseSsEstablishedLines('')).toEqual([]);
    expect(parseSsEstablishedLines('garbage that is not ss output')).toEqual([]);
  });
});

describe('candidateClientPids', () => {
  const entries = parseSsEstablishedLines(SS_FIXTURE);

  it('maps the accepted socket inode to the client-side pids', () => {
    expect(candidateClientPids(entries, 120401527)).toEqual([3128373]);
  });

  it('works when our end appears as the peer (reverse enumeration direction)', () => {
    expect(candidateClientPids(entries, 120406157)).toEqual([3128361]);
    expect(candidateClientPids(entries, 222)).toEqual([500]);
    expect(candidateClientPids(entries, 111)).toEqual([600]);
  });

  it('returns null when our inode is not in the snapshot (fresh enumeration needed / race)', () => {
    expect(candidateClientPids(entries, 424242)).toBeNull();
  });

  it('returns [] when the peer end exists but its owner could not be read', () => {
    const own: SocketPeerEntry[] = [
      { localInode: 10, peerInode: 20, pids: [1] },
      { localInode: 20, peerInode: 10, pids: [] },
    ];
    expect(candidateClientPids(own, 10)).toEqual([]);
  });

  it('caps the candidate pid list (fd inheritance can attribute many processes)', () => {
    const many = Array.from({ length: 50 }, (_, i) => i + 1);
    const own: SocketPeerEntry[] = [
      { localInode: 10, peerInode: 20, pids: [1] },
      { localInode: 20, peerInode: 10, pids: many },
    ];
    expect(candidateClientPids(own, 10)!.length).toBeLessThanOrEqual(8);
  });
});

describe('firstIdentityValue', () => {
  it('prefers PI_WEB_UI_SESSION_ID when both identity variables are present', () => {
    expect(firstIdentityValue(['PI_SESSION_ID=pi-1', 'PI_WEB_UI_SESSION_ID=managed-1'])).toBe('managed-1');
  });

  it('falls back to PI_SESSION_ID (pi tool subprocesses carry the pi session id)', () => {
    expect(firstIdentityValue(['PI_SESSION_ID=pi-1', 'OTHER=x'])).toBe('pi-1');
  });

  it('ignores empty values and returns undefined when no identity variable is present', () => {
    expect(firstIdentityValue(['PI_WEB_UI_SESSION_ID=', 'PI_SESSION_ID=  '])).toBeUndefined();
    expect(firstIdentityValue(['HOME=/root'])).toBeUndefined();
  });
});

describe('walkAncestryForSession (injected /proc)', () => {
  function procIo(overrides: {
    environ?: Record<number, string[] | null>;
    ppid?: Record<number, number | null>;
    selfPid?: number;
  }): Pick<ParentResolverIo, 'environ' | 'ppid' | 'selfPid'> {
    return {
      environ: async (pid) => overrides.environ?.[pid] ?? null,
      ppid: async (pid) => overrides.ppid?.[pid] ?? null,
      selfPid: () => overrides.selfPid ?? 10,
    };
  }

  it('finds PI_WEB_UI_SESSION_ID on the nearest ancestor (curl → agent subprocess carrying the managed identity)', async () => {
    const value = await walkAncestryForSession(100, procIo({
      environ: { 100: ['PI_WEB_UI_SESSION_ID=managed-parent'], 50: ['PI_WEB_UI_SESSION_ID=server-env-stale'] },
      ppid: { 100: 50, 50: 10 },
    }));
    expect(value).toBe('managed-parent');
  });

  it('keeps walking when an intermediate process carries no identity variables', async () => {
    const value = await walkAncestryForSession(100, procIo({
      environ: { 50: ['PI_SESSION_ID=pi-parent'] },
      ppid: { 100: 50, 50: 10 },
    }));
    expect(value).toBe('pi-parent');
  });

  it('stops at selfPid without reading the server environment (a stale inherited value on the server must never link)', async () => {
    const value = await walkAncestryForSession(50, procIo({
      environ: { 10: ['PI_WEB_UI_SESSION_ID=stale-from-launch-shell'] },
      ppid: { 50: 10 },
    }));
    expect(value).toBeUndefined();
  });

  it('gives up at pid 1 and on unreadable ancestry', async () => {
    expect(await walkAncestryForSession(100, procIo({ ppid: { 100: 1 } }))).toBeUndefined();
    expect(await walkAncestryForSession(100, procIo({ ppid: { 100: null } }))).toBeUndefined();
  });

  it('is bounded: a pid cycle cannot loop forever', async () => {
    const value = await walkAncestryForSession(100, procIo({ ppid: { 100: 100 }, environ: {} }));
    expect(value).toBeUndefined();
  });
});

describe('createPeerParentResolver (injected io, end to end)', () => {
  type ResolveReq = Parameters<ReturnType<typeof createPeerParentResolver>['resolve']>[0];
  const fakeReq = { socket: { _handle: { fd: 23 } } } as unknown as ResolveReq;

  function baseIo(overrides: Partial<ParentResolverIo>): ParentResolverIo {
    return {
      readlinkFd: async () => 'socket:[120401527]',
      ssEstablished: async () => SS_FIXTURE,
      environ: async (pid) => (pid === 3128373 ? ['PI_WEB_UI_SESSION_ID=managed-parent'] : null),
      ppid: async () => null,
      selfPid: () => 3128361,
      registry: {
        get: async (id: string) => (id === 'managed-parent' ? { id: 'managed-parent', sdkType: 'claude', path: 'claude/x.jsonl' } : undefined),
        getByPath: async () => undefined,
      },
      ...overrides,
    };
  }

  it('resolves the caller session from peer credentials and validates it against the registry', async () => {
    const resolver = createPeerParentResolver(baseIo({}));
    expect(await resolver.resolve(fakeReq)).toEqual({ sessionId: 'managed-parent', source: 'peer' });
  });

  it('returns null when the resolved identity does not name a registered session (fail safe)', async () => {
    const io = baseIo({});
    io.registry = { get: async () => undefined, getByPath: async () => undefined };
    expect(await createPeerParentResolver(io).resolve(fakeReq)).toBeNull();
  });

  it('returns null when two candidate pids resolve to different sessions (ambiguity → no linkage)', async () => {
    const io = baseIo({
      readlinkFd: async () => 'socket:[10]',
      ssEstablished: async () =>
        'u_str ESTAB 0 0 * 10 * 20 users:(("x",pid=1,fd=1))\n'
        + 'u_str ESTAB 0 0 * 20 * 10 users:(("a",pid=100,fd=1),("b",pid=200,fd=2))',
      environ: async (pid) => (pid === 100 ? ['PI_WEB_UI_SESSION_ID=sess-a'] : pid === 200 ? ['PI_WEB_UI_SESSION_ID=sess-b'] : null),
      ppid: async () => 1,
      selfPid: () => 1,
      registry: {
        get: async (id: string) => ({ id, sdkType: 'claude', path: 'x' }),
        getByPath: async () => undefined,
      },
    });
    expect(await createPeerParentResolver(io).resolve(fakeReq)).toBeNull();
  });

  it('accepts when multiple candidate pids agree on one session (fd inheritance)', async () => {
    const io = baseIo({
      readlinkFd: async () => 'socket:[10]',
      ssEstablished: async () =>
        'u_str ESTAB 0 0 * 10 * 20 users:(("x",pid=1,fd=1))\n'
        + 'u_str ESTAB 0 0 * 20 * 10 users:(("a",pid=100,fd=1),("b",pid=200,fd=2))',
      environ: async () => ['PI_WEB_UI_SESSION_ID=managed-parent'],
      ppid: async () => 1,
      selfPid: () => 1,
    });
    expect(await createPeerParentResolver(io).resolve(fakeReq)).toEqual({ sessionId: 'managed-parent', source: 'peer' });
  });

  it('returns null when ss is unavailable or the connection is not a real unix socket', async () => {
    expect(await createPeerParentResolver(baseIo({ ssEstablished: async () => null })).resolve(fakeReq)).toBeNull();
    expect(await createPeerParentResolver(baseIo({ readlinkFd: async () => null })).resolve(fakeReq)).toBeNull();
  });

  it('returns null for requests without a socket handle (unit-test fakes)', async () => {
    const resolver = createPeerParentResolver(baseIo({}));
    expect(await resolver.resolve({ socket: {} } as unknown as ResolveReq)).toBeNull();
    expect(await resolver.resolve({} as unknown as ResolveReq)).toBeNull();
  });

  it('returns null when the ancestry walk finds no identity variables (unmanaged caller)', async () => {
    const io = baseIo({ environ: async () => ['HOME=/root'] });
    expect(await createPeerParentResolver(io).resolve(fakeReq)).toBeNull();
  });

  // Note: the real /proc + ss + unix-socket mechanics are proven end-to-end on
  // a real disposable server in the C5 live validation (evidence bundle C5.md);
  // inside the vitest worker, curl-over-UDS delivery is blocked by the harness
  // (verified: even a plain echo server over a unix socket never reaches a
  // spawned curl child), so no in-vitest real-process test exists here.
});
