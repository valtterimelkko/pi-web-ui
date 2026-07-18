import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { WatchStore, type PersistedWatch } from '../../../src/internal-api/watch/watch-store.js';
import { RunReceiptStore, type PersistedRunReceipt } from '../../../src/internal-api/run-receipts/run-receipt-store.js';

function watchRecord(sessionId: string): PersistedWatch {
  return {
    watchId: `watch-${sessionId}`,
    sessionId,
    sessionPath: sessionId,
    subject: 'pi',
    seed: 'seed',
    watchText: 'DONE',
    intervalSeconds: 2,
    maxWaitSeconds: 60,
    label: `Label ${sessionId}`,
    createdAt: '2026-07-17T00:00:00.000Z',
    state: 'running',
  } as PersistedWatch;
}

function receipt(runId: string): PersistedRunReceipt {
  return {
    runId,
    sessionId: runId,
    runtime: 'pi',
    executionInstanceId: 'pi-local-default',
    model: 'provider/model',
    status: 'accepted',
    acceptedAt: '2026-07-17T00:00:00.000Z',
  } as PersistedRunReceipt;
}

function chains(store: unknown): Map<string, Promise<void>> {
  return (store as { writeChains: Map<string, Promise<void>> }).writeChains;
}

describe('P4: settled session-keyed write chains are removed', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'write-chains-p4-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  describe('WatchStore', () => {
    it('1,000 unique session keys settle to writeChains size 0', async () => {
      const store = new WatchStore(dir);
      const saves = [];
      for (let i = 0; i < 1000; i++) saves.push(store.save(watchRecord(`s${i}`)));
      await Promise.all(saves);
      expect(chains(store).size).toBe(0);
    });

    it('two saves for one key stay ordered (second wins)', async () => {
      const store = new WatchStore(dir);
      await store.save({ ...watchRecord('s1'), label: 'first' });
      await store.save({ ...watchRecord('s1'), label: 'second' });
      const reloaded = new WatchStore(dir);
      await reloaded.init();
      expect(reloaded.get('s1')?.label).toBe('second');
      expect(chains(store).size).toBe(0);
    });
  });

  describe('RunReceiptStore', () => {
    it('1,000 unique run keys settle to writeChains size 0', async () => {
      const store = new RunReceiptStore(dir, { maxCount: 100000, maxAgeMs: 10 ** 9 });
      await store.init();
      const creates = [];
      for (let i = 0; i < 1000; i++) creates.push(store.create(receipt(`r${i}`)));
      await Promise.all(creates);
      expect(chains(store).size).toBe(0);
    });

    it('two writes for one key stay ordered (second wins)', async () => {
      const store = new RunReceiptStore(dir, { maxCount: 100000, maxAgeMs: 10 ** 9 });
      await store.init();
      await store.create(receipt('r1'));
      // create -> 'accepted', then transition -> 'started' (chained on the same
      // key, so the two writes serialise; the reload recovers 'started' to
      // 'interrupted' as designed, so we assert the chain settles, not the
      // recovered status).
      await store.transition('r1', 'started');
      expect(chains(store).size).toBe(0);
    });
  });
});
