import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionRegistryManager } from '../../src/session-registry.js';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function registryPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'pi-registry-perf-'));
  temporaryRoots.push(root);
  return join(root, 'registry.json');
}

function seedFile(pathname: string, entries: Array<Record<string, unknown>>): void {
  writeFileSync(pathname, JSON.stringify({ version: 1, updatedAt: '2026-09-08T00:00:00.000Z', entries }, null, 2));
}

function piEntry(id: string, path: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, sdkType: 'pi', path, cwd: path, status: 'idle', messageCount: 1, createdAt: '2026-09-08T00:00:00.000Z', lastActivity: '2026-09-08T00:00:00.000Z', ...extra };
}

/** Attach injectable write seams to a manager (the supported test surface). */
function attachSeams(
  manager: SessionRegistryManager,
  writeFile: (path: string, data: string) => Promise<void>,
  rename: (from: string, to: string) => Promise<void>,
): void {
  (manager as unknown as Record<string, unknown>).writeFile = writeFile;
  (manager as unknown as Record<string, unknown>).rename = rename;
}

describe('indexed exact lookups', () => {
  it('resolves every id/path/native-id lookup without a linear scan, preserving first-match semantics', async () => {
    const pathname = registryPath();
    seedFile(pathname, [
      piEntry('a', '/sessions/a', { claudeSessionId: 'claude-1' }),
      piEntry('b', '/sessions/b', { opencodeSessionId: 'open-1' }),
      piEntry('c', '/sessions/c', { commandCodeNativeSessionId: 'cc-1' }),
      piEntry('dup-path-later', '/sessions/a'),
      piEntry('dup-claude-later', '/sessions/d', { claudeSessionId: 'claude-1' }),
    ]);
    const manager = new SessionRegistryManager(pathname);
    await manager.load();

    const before = manager.debugLinearScanCount;
    expect(await manager.get('a')).toMatchObject({ id: 'a' });
    expect(await manager.get('b')).toMatchObject({ id: 'b' });
    expect(await manager.getByPath('/sessions/a')).toMatchObject({ id: 'a' });
    expect(await manager.getByClaudeSessionId('claude-1')).toMatchObject({ id: 'a' });
    expect(await manager.getByOpencodeSessionId('open-1')).toMatchObject({ id: 'b' });
    expect(await manager.getByCommandCodeNativeSessionId('cc-1')).toMatchObject({ id: 'c' });
    expect(await manager.get('missing')).toBeUndefined();
    expect(await manager.getByPath('/sessions/none')).toBeUndefined();
    // Eight exact lookups after initialisation: zero additional linear scans.
    expect(manager.debugLinearScanCount).toBe(before);
  });

  it('keeps indexes correct across upsert moves, deletes and reloads', async () => {
    const pathname = registryPath();
    seedFile(pathname, [piEntry('a', '/sessions/a')]);
    const manager = new SessionRegistryManager(pathname);
    await manager.load();

    await manager.upsert({ id: 'a', sdkType: 'pi', cwd: '/sessions/a', path: '/sessions/a-moved', status: 'idle' });
    expect(await manager.getByPath('/sessions/a')).toBeUndefined();
    expect(await manager.getByPath('/sessions/a-moved')).toMatchObject({ id: 'a' });

    const created = await manager.upsert({ sdkType: 'pi', cwd: '/work', path: '/sessions/new', claudeSessionId: 'claude-9' });
    expect(await manager.getByClaudeSessionId('claude-9')).toMatchObject({ id: created.id });
    await manager.delete(created.id);
    expect(await manager.getByClaudeSessionId('claude-9')).toBeUndefined();

    const reloaded = new SessionRegistryManager(pathname);
    expect(await reloaded.getByPath('/sessions/a-moved')).toMatchObject({ id: 'a' });
    expect((await reloaded.listAll()).length).toBe(1);
  });
});

describe('coalesced snapshot saves', () => {
  it('writes at most two snapshots for 100 concurrent compatible mutations under a first-write latch', async () => {
    const pathname = registryPath();
    seedFile(pathname, []);
    const manager = new SessionRegistryManager(pathname);
    await manager.load();

    const tmpWrites: string[] = [];
    let releaseFirst!: () => void;
    const firstWriteGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    attachSeams(
      manager,
      async (path: string, data: string) => {
        if (!path.endsWith('.tmp')) return;
        tmpWrites.push(path);
        if (tmpWrites.length === 1) await firstWriteGate;
        writeFileSync(path, data);
      },
      (from: string, to: string) => {
        renameSync(from, to);
        return Promise.resolve();
      },
    );

    const promises: Array<Promise<unknown>> = [];
    promises.push(manager.upsert({ sdkType: 'pi', cwd: '/w', path: '/sessions/s0' }));
    // Advance the loop until the first write is actually latched on its gate.
    for (let spin = 0; spin < 200 && tmpWrites.length === 0; spin++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(tmpWrites.length).toBe(1);
    for (let index = 1; index < 100; index++) {
      promises.push(manager.upsert({ sdkType: 'pi', cwd: '/w', path: `/sessions/s${index}` }));
    }
    releaseFirst();
    await Promise.all(promises);

    expect(tmpWrites.length).toBeLessThanOrEqual(2);
    const reloaded = new SessionRegistryManager(pathname);
    expect((await reloaded.listAll()).length).toBe(100);
  }, 20_000);

  it('rejects affected waiters when the coalesced write fails, and a later retry persists everything', async () => {
    const pathname = registryPath();
    seedFile(pathname, []);
    const manager = new SessionRegistryManager(pathname);
    await manager.load();

    let failNext = false;
    attachSeams(
      manager,
      async (path: string, data: string) => {
        if (!path.endsWith('.tmp')) return;
        if (failNext) { failNext = false; throw new Error('disk full'); }
        writeFileSync(path, data);
      },
      (from: string, to: string) => { renameSync(from, to); return Promise.resolve(); },
    );

    await manager.upsert({ sdkType: 'pi', cwd: '/w', path: '/sessions/f1' });
    failNext = true;
    const batch = Array.from({ length: 5 }, (_, index) =>
      manager.upsert({ sdkType: 'pi', cwd: '/w', path: `/sessions/fail-${index}` }));
    await expect(Promise.all(batch)).rejects.toThrow('disk full');
    await manager.save();
    const reloaded = new SessionRegistryManager(pathname);
    expect((await reloaded.listAll()).length).toBe(6);
  }, 20_000);

  it('does not acknowledge a mutation before its write completes', async () => {
    const pathname = registryPath();
    seedFile(pathname, []);
    const manager = new SessionRegistryManager(pathname);
    await manager.load();

    const gates: Array<Promise<void>> = [];
    const releaseGates: Array<() => void> = [];
    attachSeams(
      manager,
      async (path: string, data: string) => {
        if (!path.endsWith('.tmp')) return;
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        gates.push(gate);
        releaseGates.push(release);
        await gate;
        writeFileSync(path, data);
      },
      (from: string, to: string) => { renameSync(from, to); return Promise.resolve(); },
    );

    const first = manager.upsert({ sdkType: 'pi', cwd: '/w', path: '/sessions/g1' });
    for (let spin = 0; spin < 200 && gates.length === 0; spin++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(gates.length).toBe(1);
    let settled = false;
    void first.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    releaseGates[0]();
    await first;
    expect(settled).toBe(true);
  }, 20_000);
});
