import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { PinExpiryStore, type PersistedApiPin } from '../../../src/internal-api/pin-expiry-store.js';

function samplePin(sessionId: string, pinnedUntil = Date.now() + 60_000): PersistedApiPin {
  return {
    sessionId,
    sessionPath: sessionId,
    runtime: 'claude',
    pinnedAt: Date.now(),
    pinnedUntil,
    label: 'agent-task',
  };
}

describe('PinExpiryStore — durable API-pin ledger', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-pin-store-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  it('persists a pin and reloads it in a fresh store (survives "restart")', async () => {
    const a = new PinExpiryStore(dir);
    await a.init();
    await a.save(samplePin('s1'));

    const b = new PinExpiryStore(dir);
    await b.init();
    const reloaded = b.get('s1');
    expect(reloaded).toBeDefined();
    expect(reloaded?.runtime).toBe('claude');
    expect(reloaded?.label).toBe('agent-task');
  });

  it('serializes concurrent saves without corrupting the file', async () => {
    const store = new PinExpiryStore(dir);
    await store.init();
    const rec = samplePin('s2');
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        store.save({ ...rec, pinnedUntil: rec.pinnedUntil + i * 1000 }),
      ),
    );
    const fresh = new PinExpiryStore(dir);
    await fresh.init();
    expect(fresh.get('s2')).toBeDefined();
  });

  it('deletes a pin file', async () => {
    const store = new PinExpiryStore(dir);
    await store.init();
    await store.save(samplePin('s3'));
    await store.delete('s3');
    expect(store.get('s3')).toBeUndefined();
    const fresh = new PinExpiryStore(dir);
    await fresh.init();
    expect(fresh.get('s3')).toBeUndefined();
  });

  it('tolerates a corrupt file without losing the rest', async () => {
    const store = new PinExpiryStore(dir);
    await store.init();
    await store.save(samplePin('good'));
    await fs.writeFile(path.join(dir, 'broken.json'), '{ not valid json', 'utf8');
    const fresh = new PinExpiryStore(dir);
    await fresh.init();
    expect(fresh.get('good')).toBeDefined();
  });

  it('list() returns every persisted pin', async () => {
    const store = new PinExpiryStore(dir);
    await store.init();
    await store.save(samplePin('a'));
    await store.save(samplePin('b'));
    expect(store.list().map((p) => p.sessionId).sort()).toEqual(['a', 'b']);
  });
});
