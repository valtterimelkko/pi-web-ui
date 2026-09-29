// C5 (contract 1.54.0) — "lineage always recorded": peer-credential caller
// resolution. Node exposes no SO_PEERCRED on this runtime (net.Socket has no
// getPeerCredentials), so the resolver maps the accepted connection's socket
// inode to the peer inode via an ss filter narrowed to the Internal API socket
// path (full-table fallback with an explicit maxBuffer; overflow → no linkage
// + rate-limited warning), attributes the peer end's owners with a bounded
// /proc fd scan, and walks /proc ancestry reading the session identity
// variables the server itself sets on managed runtime subprocesses (contract
// 1.47.0: PI_WEB_UI_SESSION_ID; Pi keeps PI_SESSION_ID).
//
// Correction 01: ambiguity is fail-CLOSED — every peer owner is resolved, a
// truncated owner set gives no linkage, and unanimity is required: any
// identity-less or divergent owner gives no linkage.
import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import { readdir as fsReaddir, readlink as fsReadlink } from 'node:fs/promises';
import {
  parseSsEstablishedLines,
  peerInodeOf,
  walkAncestryForSession,
  firstIdentityValue,
  createPeerParentResolver,
  runSs,
  scanPeerOwners,
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

  it('keeps entries without a users section (owner attribution no longer relies on users:)', () => {
    const entries = parseSsEstablishedLines('u_str ESTAB 0 0 * 880  * 881');
    expect(entries).toEqual<SocketPeerEntry[]>([{ localInode: 880, peerInode: 881, pids: [] }]);
  });

  it('returns [] for empty or unparseable output', () => {
    expect(parseSsEstablishedLines('')).toEqual([]);
    expect(parseSsEstablishedLines('garbage that is not ss output')).toEqual([]);
  });
});

describe('peerInodeOf', () => {
  const entries = parseSsEstablishedLines(SS_FIXTURE);

  it('returns the peer inode of the accepted (server-side) end', () => {
    expect(peerInodeOf(entries, 120401527)).toBe(120406157);
    expect(peerInodeOf(entries, 111)).toBe(222);
  });

  it('returns the peer inode when our end appears as the peer (reverse enumeration direction)', () => {
    expect(peerInodeOf(entries, 120406157)).toBe(120401527);
    expect(peerInodeOf(entries, 222)).toBe(111);
  });

  it('returns null when our inode is not in the snapshot', () => {
    expect(peerInodeOf(entries, 424242)).toBeNull();
  });
});

describe('runSs (explicit maxBuffer)', () => {
  it('collects small output intact', async () => {
    const result = await runSs('ss', ['-V'], 64 * 1024);
    expect(result.kind).toBe('ok');
  });

  it('reports overflow (not a crash) when output exceeds maxBuffer', async () => {
    const overflow = await runSs('sh', ['-c', 'yes | head -c 200000'], 1024);
    expect(overflow.kind).toBe('overflow');
  }, 15000);

  it('reports unavailable when the binary is missing', async () => {
    const result = await runSs('c5-definitely-not-a-binary', ['-V'], 64 * 1024);
    expect(result.kind).toBe('unavailable');
  });
});

describe('default peerOwners (bounded /proc fd scan)', () => {
  it('finds this process as the owner of a socket inode it holds', async () => {
    const server = net.createServer(() => {});
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const client = net.connect(typeof address === 'object' && address ? address.port : 0, '127.0.0.1');
    await new Promise<void>((resolve) => client.on('connect', resolve));
    const link = await fsReadlink(`/proc/self/fd/${(client as unknown as { _handle: { fd: number } })._handle.fd}`);
    const inode = Number(link!.match(/socket:\[(\d+)\]/)![1]);
    const owners = await scanPeerOwners(inode, { readdir: fsReaddir, readlink: fsReadlink });
    client.destroy();
    server.close();
    expect(owners).toContain(process.pid);
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

describe('scanPeerOwners (correction 02: vanish vs incomplete)', () => {
  const INODE = 4242;
  const WANT = `socket:[${INODE}]`;

  function scanIo(overrides: {
    /** pid -> readdir result for /proc/<pid>/fd */
    fds?: Record<number, string[]>;
    /** pid -> error thrown by the /proc/<pid>/fd readdir */
    fdsError?: Record<number, NodeJS.ErrnoException>;
    /** "<pid>/<fd>" -> readlink result */
    links?: Record<string, string>;
    /** "<pid>/<fd>" -> error thrown by the fd readlink */
    linkError?: Record<string, NodeJS.ErrnoException>;
  }) {
    return {
      readdir: async (p: string) => {
        if (p === '/proc') {
          const pids = [...new Set([...Object.keys(overrides.fds ?? {}), ...Object.keys(overrides.fdsError ?? {})])];
          return ['1', 'non-numeric', ...pids];
        }
        const pid = Number(p.split('/')[2]);
        if (overrides.fdsError?.[pid]) throw overrides.fdsError[pid];
        return overrides.fds?.[pid] ?? [];
      },
      readlink: async (p: string) => {
        const parts = p.split('/');
        const key = `${parts[2]}/${parts[4]}`; // '<pid>/<fd>'
        if (overrides.linkError?.[key]) throw overrides.linkError[key];
        return overrides.links?.[key] ?? 'socket:[1]';
      },
    };
  }

  it('returns the owners whose fds hold the peer inode', async () => {
    const owners = await scanPeerOwners(INODE, scanIo({
      fds: { 100: ['3'], 200: ['9'] },
      links: { '100/3': WANT, '200/9': 'socket:[777]' },
    }));
    expect(owners).toEqual([100]);
  });

  it('skips a vanished process (ENOENT on the fd directory) and still returns the visible owner', async () => {
    const owners = await scanPeerOwners(INODE, scanIo({
      fds: { 100: ['3'] },
      fdsError: { 200: Object.assign(new Error('gone'), { code: 'ENOENT' }) },
      links: { '100/3': WANT },
    }));
    expect(owners).toEqual([100]);
  });

  it('skips a vanished fd (ENOENT on the fd readlink) and still returns the visible owner', async () => {
    const owners = await scanPeerOwners(INODE, scanIo({
      fds: { 100: ['3', '4'], 200: ['9'] },
      linkError: { '100/4': Object.assign(new Error('gone'), { code: 'ENOENT' }) },
      links: { '100/3': WANT },
    }));
    expect(owners).toEqual([100]);
  });

  it('treats EACCES on a process fd directory as an incomplete set (null), never a partial answer', async () => {
    const owners = await scanPeerOwners(INODE, scanIo({
      fds: { 100: ['3'] },
      fdsError: { 200: Object.assign(new Error('denied'), { code: 'EACCES' }) },
      links: { '100/3': WANT },
    }));
    expect(owners).toBeNull();
  });

  it('treats EPERM on a process fd directory as incomplete', async () => {
    const owners = await scanPeerOwners(INODE, scanIo({
      fds: { 100: ['3'] },
      fdsError: { 200: Object.assign(new Error('denied'), { code: 'EPERM' }) },
      links: { '100/3': WANT },
    }));
    expect(owners).toBeNull();
  });

  it('treats EACCES on an fd readlink as incomplete', async () => {
    const owners = await scanPeerOwners(INODE, scanIo({
      fds: { 100: ['3'], 200: ['9'] },
      linkError: { '200/9': Object.assign(new Error('denied'), { code: 'EACCES' }) },
      links: { '100/3': WANT },
    }));
    expect(owners).toBeNull();
  });

  it('treats an unreadable /proc root as incomplete', async () => {
    const owners = await scanPeerOwners(INODE, {
      readdir: async (p: string) => {
        if (p === '/proc') throw Object.assign(new Error('denied'), { code: 'EACCES' });
        return [];
      },
      readlink: async () => 'socket:[1]',
    });
    expect(owners).toBeNull();
  });

  it('gives null when the owners exceed the safe bound (truncation is incomplete)', async () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ fds: { [i + 10]: ['3'] }, links: { [`${i + 10}/3`]: WANT } }));
    const merged = many.reduce((acc, m) => ({ fds: { ...acc.fds, ...m.fds }, links: { ...acc.links, ...m.links } }), { fds: {} as Record<number, string[]>, links: {} as Record<string, string> });
    const owners = await scanPeerOwners(INODE, scanIo(merged));
    expect(owners).toBeNull();
  });
});

describe('createPeerParentResolver (correction 02: an inaccessible owner gives no linkage, end to end)', () => {
  type ResolveReq = Parameters<ReturnType<typeof createPeerParentResolver>['resolve']>[0];
  const fakeReq = { socket: { _handle: { fd: 23 } } } as unknown as ResolveReq;
  const SS_OUT = 'u_str ESTAB 0 0 /run/api/internal-api.sock 10 * 20';
  const PEER_INODE = 20;

  /** Resolver whose owners scan is the REAL scanPeerOwners over injected fs IO;
   *  both owners walk to the same identity (sess-a), so only scan failures can
   *  change the outcome. */
  function resolverWithScan(failures: { fdsError?: Record<number, NodeJS.ErrnoException>; linkError?: Record<string, NodeJS.ErrnoException> }) {
    return createPeerParentResolver({
      readlinkFd: async () => 'socket:[10]',
      ssEstablished: async () => ({ kind: 'ok', output: SS_OUT }),
      peerOwners: (inode) => scanPeerOwners(inode, {
        readdir: async (p: string) => {
          if (p === '/proc') return ['100', '200'];
          const pid = Number(p.split('/')[2]);
          if (failures.fdsError?.[pid]) throw failures.fdsError[pid];
          return ['3'];
        },
        readlink: async (p: string) => {
          const parts = p.split('/');
          const pid = parts[2];
          if (failures.linkError?.[`${pid}/${parts[4]}`]) throw failures.linkError[`${pid}/${parts[4]}`];
          return pid === '100' || pid === '200' ? `socket:[${PEER_INODE}]` : 'socket:[1]';
        },
      }),
      environ: async () => ['PI_WEB_UI_SESSION_ID=sess-a'],
      ppid: async () => null,
      selfPid: () => 1,
      warn: () => {},
      now: () => 1_000_000,
      registry: {
        get: async (id: string) => ({ id, sdkType: 'claude', path: 'x' }),
        getByPath: async () => undefined,
      },
    });
  }

  it('baseline: two readable owners agreeing on A still links', async () => {
    expect(await resolverWithScan({}).resolve(fakeReq)).toEqual({ sessionId: 'sess-a', source: 'peer' });
  });

  it("one owner resolving to A plus one owner whose fd read fails EACCES → no link (Luna's case)", async () => {
    expect(await resolverWithScan({ fdsError: { 200: Object.assign(new Error('denied'), { code: 'EACCES' }) } }).resolve(fakeReq)).toBeNull();
  });

  it('the same with ENOENT → the vanished owner is skipped and A is linked', async () => {
    expect(await resolverWithScan({ fdsError: { 200: Object.assign(new Error('gone'), { code: 'ENOENT' }) } }).resolve(fakeReq)).toEqual({ sessionId: 'sess-a', source: 'peer' });
  });

  it('an fd-level readlink EACCES → no link', async () => {
    expect(await resolverWithScan({ linkError: { '200/3': Object.assign(new Error('denied'), { code: 'EACCES' }) } }).resolve(fakeReq)).toBeNull();
  });
});

describe('createPeerParentResolver (correction 01: ambiguity is fail-closed)', () => {
  type ResolveReq = Parameters<ReturnType<typeof createPeerParentResolver>['resolve']>[0];
  const fakeReq = { socket: { _handle: { fd: 23 } } } as unknown as ResolveReq;

  interface OwnerScenario {
    /** owners reported by the (injected) /proc scan, in order; null = truncated set */
    owners: number[] | null;
    /** identity each owner's ancestry walk resolves to; undefined = identity-less */
    identityOf?: Record<number, string | undefined>;
  }

  function scenarioIo(s: OwnerScenario, overrides: Partial<ParentResolverIo> = {}): ParentResolverIo {
    return {
      readlinkFd: async () => 'socket:[120401527]',
      ssEstablished: async () => ({ kind: 'ok', output: SS_FIXTURE }),
      peerOwners: async () => s.owners,
      environ: async (pid) => {
        const identity = s.identityOf?.[pid];
        return identity === undefined ? ['HOME=/root'] : [`PI_WEB_UI_SESSION_ID=${identity}`];
      },
      ppid: async () => null,
      selfPid: () => 3128361,
      warn: () => {},
      now: () => 1_000_000,
      registry: {
        get: async (id: string) => ({ id, sdkType: 'claude', path: 'x' }),
        getByPath: async () => undefined,
      },
      ...overrides,
    };
  }

  it('links when every peer owner resolves to the same parent (unanimity)', async () => {
    const io = scenarioIo({ owners: [100, 200, 300], identityOf: { 100: 'sess-a', 200: 'sess-a', 300: 'sess-a' } });
    expect(await createPeerParentResolver(io).resolve(fakeReq)).toEqual({ sessionId: 'sess-a', source: 'peer' });
  });

  it("gives no linkage when one owner diverges (Luna's case: several A plus one B)", async () => {
    const io = scenarioIo({ owners: [100, 200, 300], identityOf: { 100: 'sess-a', 200: 'sess-b', 300: 'sess-a' } });
    expect(await createPeerParentResolver(io).resolve(fakeReq)).toBeNull();
  });

  it("gives no linkage when one owner has no identity at all (Luna's case: A plus identity-less)", async () => {
    const io = scenarioIo({ owners: [100, 200], identityOf: { 100: 'sess-a' } }); // 200 → identity-less
    expect(await createPeerParentResolver(io).resolve(fakeReq)).toBeNull();
  });

  it('gives no linkage when ALL owners are identity-less', async () => {
    const io = scenarioIo({ owners: [100, 200] });
    expect(await createPeerParentResolver(io).resolve(fakeReq)).toBeNull();
  });

  it('gives no linkage when the owner set is truncated above the safe bound (cap case)', async () => {
    const io = scenarioIo({ owners: null });
    expect(await createPeerParentResolver(io).resolve(fakeReq)).toBeNull();
  });

  it('gives no linkage when there are no owners at all', async () => {
    const io = scenarioIo({ owners: [] });
    expect(await createPeerParentResolver(io).resolve(fakeReq)).toBeNull();
  });

  it('falls back to the full ss table when the narrowed snapshot misses the connection', async () => {
    let calls = 0;
    const io = scenarioIo(
      { owners: [100], identityOf: { 100: 'sess-a' } },
      {
        ssEstablished: async (mode) => {
          calls += 1;
          if (mode === 'narrow') {
            // Narrow filter returned a snapshot without our inode (e.g. an
            // older iproute2 that ignored the filter differently).
            return { kind: 'ok', output: 'u_str ESTAB 0 0 * 999  * 998' };
          }
          return { kind: 'ok', output: SS_FIXTURE };
        },
      },
    );
    expect(await createPeerParentResolver({ ...io, socketPath: '/run/api/internal-api.sock' }).resolve(fakeReq)).toEqual({ sessionId: 'sess-a', source: 'peer' });
    expect(calls).toBe(2);
  });

  it('gives no linkage and warns rate-limited when the ss output overflows maxBuffer', async () => {
    const warnings: string[] = [];
    let clock = 1_000_000;
    const io = scenarioIo({ owners: [100] }, {
      ssEstablished: async () => ({ kind: 'overflow' }),
      warn: (m) => warnings.push(m),
      now: () => clock,
    });
    const resolver = createPeerParentResolver(io);
    expect(await resolver.resolve(fakeReq)).toBeNull();
    expect(await resolver.resolve(fakeReq)).toBeNull();
    expect(warnings).toHaveLength(1); // rate-limited within the window
    clock += 61_000;
    expect(await resolver.resolve(fakeReq)).toBeNull();
    expect(warnings).toHaveLength(2); // window elapsed → warns again
  });

  it('gives no linkage when ss is unavailable', async () => {
    const io = scenarioIo({ owners: [100] }, { ssEstablished: async () => ({ kind: 'unavailable' }) });
    expect(await createPeerParentResolver(io).resolve(fakeReq)).toBeNull();
  });

  it('returns null for requests without a socket handle (unit-test fakes)', async () => {
    const resolver = createPeerParentResolver(scenarioIo({ owners: [100], identityOf: { 100: 'sess-a' } }));
    expect(await resolver.resolve({ socket: {} } as unknown as ResolveReq)).toBeNull();
    expect(await resolver.resolve({} as unknown as ResolveReq)).toBeNull();
  });

  it('returns null when the resolved identity does not name a registered session (fail safe)', async () => {
    const io = scenarioIo({ owners: [100], identityOf: { 100: 'sess-a' } });
    io.registry = { get: async () => undefined, getByPath: async () => undefined };
    expect(await createPeerParentResolver(io).resolve(fakeReq)).toBeNull();
  });

  // Note: the real /proc + ss + unix-socket mechanics are proven end-to-end on
  // a real disposable server in the C5 live validation (evidence bundle C5.md);
  // inside the vitest worker, curl-over-UDS delivery is blocked by the harness
  // (verified: even a plain echo server over a unix socket never reaches a
  // spawned curl child), so no in-vitest real-process test exists here.
});
