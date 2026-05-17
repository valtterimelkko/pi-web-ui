import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionRegistryManager } from '../../src/session-registry.js';

let tempDir: string;
let registryPath: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'session-registry-test-'));
  registryPath = join(tempDir, 'registry.json');
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('SessionRegistryManager', () => {
  it('creates empty registry if file does not exist', async () => {
    const manager = new SessionRegistryManager(registryPath);
    const registry = await manager.load();
    expect(registry.entries).toEqual([]);
    expect(registry.version).toBe(1);
  });

  it('upserts an entry and retrieves it by id', async () => {
    const manager = new SessionRegistryManager(registryPath);

    const entry = await manager.upsert({
      sdkType: 'pi',
      path: '/some/path',
      cwd: '/home/user',
      firstMessage: 'Hello',
      messageCount: 3,
    });

    expect(entry.id).toBeTruthy();
    expect(entry.sdkType).toBe('pi');
    expect(entry.firstMessage).toBe('Hello');

    const fetched = await manager.get(entry.id);
    expect(fetched).toBeDefined();
    expect(fetched!.id).toBe(entry.id);
    expect(fetched!.path).toBe('/some/path');
  });

  it('upserts an entry and retrieves it by path', async () => {
    const manager = new SessionRegistryManager(registryPath);

    await manager.upsert({
      sdkType: 'pi',
      path: '/unique/session/path',
      cwd: '/home/user',
      firstMessage: 'hi',
      messageCount: 1,
    });

    const found = await manager.getByPath('/unique/session/path');
    expect(found).toBeDefined();
    expect(found!.path).toBe('/unique/session/path');
  });

  it('lists all entries', async () => {
    const manager = new SessionRegistryManager(registryPath);

    await manager.upsert({ sdkType: 'pi', path: '/a', cwd: '/a', firstMessage: 'a', messageCount: 1 });
    await manager.upsert({ sdkType: 'claude', path: '/b', cwd: '/b', firstMessage: 'b', messageCount: 2 });

    const all = await manager.listAll();
    expect(all).toHaveLength(2);
  });

  it('lists entries by sdkType', async () => {
    const manager = new SessionRegistryManager(registryPath);

    await manager.upsert({ sdkType: 'pi', path: '/pi1', cwd: '/pi1', firstMessage: 'p1', messageCount: 1 });
    await manager.upsert({ sdkType: 'pi', path: '/pi2', cwd: '/pi2', firstMessage: 'p2', messageCount: 1 });
    await manager.upsert({ sdkType: 'claude', path: '/c1', cwd: '/c1', firstMessage: 'c1', messageCount: 1 });

    const piEntries = await manager.listBySdkType('pi');
    expect(piEntries).toHaveLength(2);
    expect(piEntries.every((e) => e.sdkType === 'pi')).toBe(true);

    const claudeEntries = await manager.listBySdkType('claude');
    expect(claudeEntries).toHaveLength(1);
    expect(claudeEntries[0].sdkType).toBe('claude');
  });

  it('deletes an entry', async () => {
    const manager = new SessionRegistryManager(registryPath);

    const entry = await manager.upsert({
      sdkType: 'pi',
      path: '/to-delete',
      cwd: '/cwd',
      firstMessage: 'bye',
      messageCount: 0,
    });

    await manager.delete(entry.id);

    const all = await manager.listAll();
    expect(all).toHaveLength(0);
    const fetched = await manager.get(entry.id);
    expect(fetched).toBeUndefined();
  });

  it('handles corrupted JSON file gracefully (rebuilds empty)', async () => {
    // Write invalid JSON
    await writeFile(registryPath, 'NOT VALID JSON {{{{', 'utf-8');

    const manager = new SessionRegistryManager(registryPath);
    const registry = await manager.load();

    expect(registry.entries).toEqual([]);
    expect(registry.version).toBe(1);
  });

  it('saves atomically (writes to tmp then renames)', async () => {
    const manager = new SessionRegistryManager(registryPath);

    await manager.upsert({
      sdkType: 'claude',
      path: '/atomic-test',
      cwd: '/cwd',
      firstMessage: 'atomic',
      messageCount: 1,
    });

    // After save, no .tmp file should remain
    const { existsSync } = await import('fs');
    expect(existsSync(registryPath + '.tmp')).toBe(false);
    // But the real file should exist and be valid JSON
    expect(existsSync(registryPath)).toBe(true);

    // Create a fresh manager instance to read back from disk
    const manager2 = new SessionRegistryManager(registryPath);
    const all = await manager2.listAll();
    expect(all).toHaveLength(1);
    expect(all[0].path).toBe('/atomic-test');
  });

  it('updates existing entry on upsert by path', async () => {
    const manager = new SessionRegistryManager(registryPath);

    const first = await manager.upsert({
      sdkType: 'pi',
      path: '/same-path',
      cwd: '/cwd',
      firstMessage: 'original',
      messageCount: 1,
    });

    const updated = await manager.upsert({
      sdkType: 'pi',
      path: '/same-path',
      cwd: '/cwd',
      firstMessage: 'updated',
      messageCount: 5,
    });

    // Should preserve original id
    expect(updated.id).toBe(first.id);
    expect(updated.firstMessage).toBe('updated');
    expect(updated.messageCount).toBe(5);

    const all = await manager.listAll();
    expect(all).toHaveLength(1);
  });

  it('serializes concurrent saves (write queue)', async () => {
    const manager = new SessionRegistryManager(registryPath);

    const results = await Promise.all([
      manager.upsert({ sdkType: 'pi', path: '/a', cwd: '/a', firstMessage: 'first', messageCount: 1 }),
      manager.upsert({ sdkType: 'pi', path: '/b', cwd: '/b', firstMessage: 'second', messageCount: 2 }),
      manager.upsert({ sdkType: 'claude', path: '/c', cwd: '/c', firstMessage: 'third', messageCount: 3 }),
    ]);

    expect(results).toHaveLength(3);

    const all = await manager.listAll();
    expect(all).toHaveLength(3);
    expect(all.map(e => e.path).sort()).toEqual(['/a', '/b', '/c']);

    const { existsSync, readFileSync } = await import('fs');
    expect(existsSync(registryPath)).toBe(true);
    expect(existsSync(registryPath + '.tmp')).toBe(false);
    const onDisk = JSON.parse(readFileSync(registryPath, 'utf-8'));
    expect(onDisk.entries).toHaveLength(3);
  });

  it('does not lose data when concurrent updateStatus calls race', async () => {
    const manager = new SessionRegistryManager(registryPath);

    const e1 = await manager.upsert({ sdkType: 'pi', path: '/x', cwd: '/x', firstMessage: 'x', messageCount: 1 });
    const e2 = await manager.upsert({ sdkType: 'claude', path: '/y', cwd: '/y', firstMessage: 'y', messageCount: 2 });

    await Promise.all([
      manager.updateStatus(e1.id, 'running'),
      manager.updateStatus(e2.id, 'error'),
    ]);

    const fetched1 = await manager.get(e1.id);
    const fetched2 = await manager.get(e2.id);
    expect(fetched1?.status).toBe('running');
    expect(fetched2?.status).toBe('error');
  });
});
