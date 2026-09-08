import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionRegistryManager } from '../../src/session-registry.js';

let tempDir: string;
let registryPath: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'session-registry-recovery-'));
  registryPath = join(tempDir, 'registry.json');
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('SessionRegistryManager failure and recovery', () => {
  it('rejects schema-invalid state, preserves bytes, and recovers after repair', async () => {
    const original = JSON.stringify({ version: 1, entries: 'not-an-array' });
    await writeFile(registryPath, original, 'utf-8');

    const manager = new SessionRegistryManager(registryPath);
    await expect(manager.load()).rejects.toThrow(/unavailable/i);
    expect(manager.getLoadStatus()).toEqual({ state: 'unavailable', reason: 'invalid' });
    await expect(manager.delete('missing')).rejects.toThrow(/unavailable/i);
    await expect(manager.save()).rejects.toThrow(/unavailable/i);
    expect(await readFile(registryPath, 'utf-8')).toBe(original);

    await writeFile(registryPath, JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      entries: [],
    }), 'utf-8');

    expect(await manager.listAll()).toEqual([]);
    expect(manager.getLoadStatus()).toEqual({ state: 'available', source: 'disk' });
  });

  it.each([null, 42, 'invalid', []])('rejects non-record entries without overwriting the registry: %j', async entry => {
    const original = JSON.stringify({ version: 1, entries: [entry] });
    await writeFile(registryPath, original, 'utf-8');
    const manager = new SessionRegistryManager(registryPath);
    await expect(manager.load()).rejects.toThrow(/unavailable/i);
    expect(manager.getLoadStatus()).toEqual({ state: 'unavailable', reason: 'invalid' });
    await expect(manager.save()).rejects.toThrow(/unavailable/i);
    expect(await readFile(registryPath, 'utf-8')).toBe(original);
  });

  it('classifies a JSON value without the registry shape as invalid', async () => {
    await writeFile(registryPath, 'null', 'utf-8');

    const manager = new SessionRegistryManager(registryPath);
    await expect(manager.load()).rejects.toThrow(/unavailable/i);
    expect(manager.getLoadStatus()).toEqual({ state: 'unavailable', reason: 'invalid' });
    expect(await readFile(registryPath, 'utf-8')).toBe('null');
  });

  it('uses an injected EACCES read failure, refuses mutation, and recovers on retry', async () => {
    const original = JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      entries: [],
    });
    await writeFile(registryPath, original, 'utf-8');

    let denyRead = true;
    const manager = new SessionRegistryManager(registryPath, {
      readFile: async () => {
        if (denyRead) {
          throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        }
        return readFile(registryPath, 'utf-8');
      },
    });

    await expect(manager.load()).rejects.toThrow(/unavailable/i);
    expect(manager.getLoadStatus()).toEqual({ state: 'unavailable', reason: 'unreadable', errorCode: 'EACCES' });
    await expect(manager.upsert({
      sdkType: 'pi',
      path: '/must-not-write',
      cwd: '/cwd',
      firstMessage: 'blocked',
      messageCount: 0,
    })).rejects.toThrow(/unavailable/i);
    expect(await readFile(registryPath, 'utf-8')).toBe(original);

    denyRead = false;
    expect(await manager.listAll()).toEqual([]);
    expect(manager.getLoadStatus()).toEqual({ state: 'available', source: 'disk' });
  });

  it('initialises a missing registry without conflating it with unreadable state', async () => {
    const manager = new SessionRegistryManager(registryPath);
    const registry = await manager.load();
    expect(registry).toMatchObject({ version: 1, entries: [] });
    expect(manager.getLoadStatus()).toEqual({ state: 'missing' });
  });
});
