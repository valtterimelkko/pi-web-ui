import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { WatchStore, type PersistedWatch } from '../../../src/internal-api/watch/watch-store.js';

function sampleRecord(sessionId: string): PersistedWatch {
  return {
    watchId: `watch-${sessionId}`,
    sessionId,
    sessionPath: sessionId,
    runtime: 'pi',
    status: 'active',
    pinned: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    conditions: [{ id: 'c0', type: 'event_type', spec: { id: 'c0', type: 'event_type', eventType: 'agent_end' }, fired: true, fireCount: 1, firstFiredAt: 1000, lastFiredAt: 1000 }],
    firings: [{ conditionId: 'c0', firedAt: 1000, eventType: 'agent_end', evidence: 'event agent_end' }],
    snapshot: { status: 'idle', eventCount: 5, toolCallCount: 1, sawAgentEnd: true, lastEventType: 'agent_end', lastEventAt: 1000 },
  };
}

describe('WatchStore — durable ledger persistence', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-watch-store-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  it('persists a watch and reloads it in a fresh store (survives "restart")', async () => {
    const a = new WatchStore(dir);
    await a.init();
    await a.save(sampleRecord('s1'));

    // A brand-new store instance simulates a server restart: nothing is in
    // memory, everything must come from disk.
    const b = new WatchStore(dir);
    await b.init();
    const reloaded = b.get('s1');
    expect(reloaded).toBeDefined();
    expect(reloaded?.firings).toHaveLength(1);
    expect(reloaded?.firings[0].conditionId).toBe('c0');
    expect(reloaded?.snapshot.eventCount).toBe(5);
  });

  it('loads a pre-change ledger with no deliveryKind or done status', async () => {
    const legacy = {
      watchId: 'watch-legacy',
      sessionId: 'legacy',
      sessionPath: 'legacy',
      runtime: 'pi',
      status: 'active',
      pinned: true,
      targetPinned: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      conditions: [{ id: 'c0', type: 'event_type', spec: { id: 'c0', type: 'event_type', eventType: 'agent_end' }, fired: true, fireCount: 1 }],
      onFire: { type: 'prompt', targetSessionId: 'parent', message: 'done', mode: 'follow_up' },
      wakeAttempts: [{ attemptedAt: 1000, targetSessionId: 'parent', status: 'dispatched', conditionId: 'c0', runId: 'legacy-run' }],
      firings: [{ conditionId: 'c0', firedAt: 1000, eventType: 'agent_end', evidence: 'event agent_end' }],
      snapshot: { status: 'idle', eventCount: 1, toolCallCount: 0, sawAgentEnd: true },
    };
    await fs.writeFile(path.join(dir, 'legacy.json'), JSON.stringify(legacy), 'utf8');

    const store = new WatchStore(dir);
    await store.init();
    expect(store.get('legacy')?.status).toBe('active');
    expect(store.get('legacy')?.wakeAttempts[0].deliveryKind).toBeUndefined();
  });

  it('serializes concurrent saves without corrupting the file', async () => {
    const store = new WatchStore(dir);
    await store.init();
    const rec = sampleRecord('s2');
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => {
        const r = { ...rec, snapshot: { ...rec.snapshot, eventCount: i } };
        return store.save(r);
      }),
    );
    const fresh = new WatchStore(dir);
    await fresh.init();
    expect(fresh.get('s2')).toBeDefined();
  });

  it('deletes a watch file', async () => {
    const store = new WatchStore(dir);
    await store.init();
    await store.save(sampleRecord('s3'));
    await store.delete('s3');
    expect(store.get('s3')).toBeUndefined();
    const fresh = new WatchStore(dir);
    await fresh.init();
    expect(fresh.get('s3')).toBeUndefined();
  });

  it('tolerates a corrupt file without losing the rest', async () => {
    const store = new WatchStore(dir);
    await store.init();
    await store.save(sampleRecord('good'));
    await fs.writeFile(path.join(dir, 'broken.json'), '{ not valid json', 'utf8');
    const fresh = new WatchStore(dir);
    await fresh.init();
    expect(fresh.get('good')).toBeDefined();
  });
});
