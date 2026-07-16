import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { NotificationStore } from '../../../src/notifications/notification-store.js';
import { setLogTap, type LogRecord } from '../../../src/logging/logger.js';
import type {
  OptInRecord,
  Notification,
  DeliveryRecord,
  QueuedNotification,
  NotificationRuntime,
} from '../../../src/notifications/types.js';

function optIn(sessionId: string, runtime: NotificationRuntime = 'pi'): OptInRecord {
  return {
    sessionId,
    runtime,
    sessionPath: `/tmp/sessions/${sessionId}`,
    optedInAt: '2026-06-29T00:00:00.000Z',
    label: `Label ${sessionId}`,
  };
}

function notification(id: string, sessionId?: string): Notification {
  return {
    id,
    sessionId,
    runtime: sessionId ? 'pi' : undefined,
    kind: sessionId ? 'agent_end' : 'explicit',
    title: 'Agent finished',
    body: 'I am done.',
    deepLink: sessionId ? `https://app/sessions/${sessionId}` : undefined,
    createdAt: '2026-06-29T00:00:01.000Z',
  };
}

function queued(
  id: string,
  sessionId?: string,
  status: DeliveryRecord['status'] = 'pending',
  ingress?: QueuedNotification['ingress'],
): QueuedNotification {
  return {
    notification: notification(id, sessionId),
    ingress,
    delivery: {
      notificationId: id,
      channel: 'telegram',
      status,
      attempts: 0,
      firstQueuedAt: '2026-06-29T00:00:02.000Z',
    },
  };
}

describe('NotificationStore — durable persistence', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-notif-store-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  describe('opt-in records', () => {
    it('creates, reads, lists, updates, and removes opt-in records', async () => {
      const store = new NotificationStore(dir);
      await store.init();
      await store.setOptIn(optIn('s1', 'claude'));
      await store.setOptIn(optIn('s2', 'opencode'));

      expect(store.getOptIn('s1')?.runtime).toBe('claude');
      expect(store.listOptIns().map((r) => r.sessionId).sort()).toEqual(['s1', 's2']);

      // Same sessionId overwrites (update).
      await store.setOptIn(optIn('s1', 'antigravity'));
      expect(store.getOptIn('s1')?.runtime).toBe('antigravity');
      expect(store.listOptIns()).toHaveLength(2);

      await store.removeOptIn('s1');
      expect(store.getOptIn('s1')).toBeUndefined();
      expect(store.listOptIns()).toHaveLength(1);
    });

    it('survives a simulated restart (reloads opt-ins from disk)', async () => {
      const a = new NotificationStore(dir);
      await a.init();
      await a.setOptIn(optIn('s1'));

      const b = new NotificationStore(dir);
      await b.init();
      expect(b.getOptIn('s1')).toBeDefined();
      expect(b.getOptIn('s1')?.sessionPath).toBe('/tmp/sessions/s1');
    });
  });

  describe('outbox', () => {
    it('enqueues, lists pending, and marks sent → moves to the delivery log', async () => {
      const store = new NotificationStore(dir);
      await store.init();
      await store.setOptIn(optIn('s1'));
      await store.enqueue(queued('n1', 's1'));

      expect(store.listPending()).toHaveLength(1);
      expect(store.listPending()[0].notification.id).toBe('n1');

      await store.markSent('n1', '2026-06-29T00:00:09.000Z');
      expect(store.listPending()).toHaveLength(0);
      const log = store.listLog();
      expect(log).toHaveLength(1);
      expect(log[0].delivery.status).toBe('sent');
      expect(log[0].delivery.deliveredAt).toBe('2026-06-29T00:00:09.000Z');
    });

    it('records a non-terminal failure (increments attempts, stays pending)', async () => {
      const store = new NotificationStore(dir);
      await store.init();
      await store.enqueue(queued('n2', 's1', 'pending', { keyHash: 'retry-key', fingerprint: 'retry-body' }));
      await store.recordFailure('n2', 'boom', false);
      const pending = store.listPending();
      expect(pending).toHaveLength(1);
      expect(pending[0].delivery.attempts).toBe(1);
      expect(pending[0].delivery.lastError).toBe('boom');
      expect(pending[0].delivery.status).toBe('pending');
      expect(store.getByIngressKeyHash('retry-key')?.notification.id).toBe('n2');
    });

    it('records a terminal failure → moves to the log as failed', async () => {
      const store = new NotificationStore(dir);
      await store.init();
      await store.enqueue(queued('n3', 's1'));
      await store.recordFailure('n3', 'fatal', true);
      expect(store.listPending()).toHaveLength(0);
      const log = store.listLog();
      expect(log).toHaveLength(1);
      expect(log[0].delivery.status).toBe('failed');
      expect(log[0].delivery.lastError).toBe('fatal');
    });

    it('ignores markSent / recordFailure for an unknown id without throwing', async () => {
      const store = new NotificationStore(dir);
      await store.init();
      await expect(store.markSent('nope', '2026-06-29T00:00:00.000Z')).resolves.toBeUndefined();
      await expect(store.recordFailure('nope', 'x', true)).resolves.toBeUndefined();
    });

    it('finds a notification by server id or hashed ingress key across pending and terminal state', async () => {
      const store = new NotificationStore(dir);
      await store.init();
      const ingress = { keyHash: 'key-hash', fingerprint: 'payload-hash' };
      await store.enqueue(queued('lookup', undefined, 'pending', ingress));

      expect(store.getById('lookup')?.delivery.status).toBe('pending');
      expect(store.getByIngressKeyHash('key-hash')?.notification.id).toBe('lookup');

      await store.markSent('lookup', '2026-06-29T00:00:10.000Z');
      expect(store.getById('lookup')?.delivery.status).toBe('sent');
      expect(store.getByIngressKeyHash('key-hash')?.delivery.status).toBe('sent');
    });

    it('atomically joins concurrent ingress reservations before reporting a duplicate', async () => {
      const store = new NotificationStore(dir);
      await store.init();
      const item = queued('atomic', undefined, 'pending', { keyHash: 'atomic-key', fingerprint: 'same' });

      const [first, second] = await Promise.all([
        store.enqueueIdempotent(item),
        store.enqueueIdempotent({ ...item, notification: { ...item.notification, id: 'other' } }),
      ]);

      expect([first.duplicate, second.duplicate].sort()).toEqual([false, true]);
      expect(first.item.notification.id).toBe(second.item.notification.id);
      const fresh = new NotificationStore(dir);
      await fresh.init();
      expect(fresh.listPending()).toHaveLength(1);
    });

    it('reconciles a crash snapshot where a terminal log write preceded outbox removal', async () => {
      const duplicate = queued('transition', 's1');
      const terminal = {
        ...duplicate,
        delivery: { ...duplicate.delivery, status: 'sent' as const, deliveredAt: '2026-06-29T00:00:10.000Z' },
      };
      await fs.writeFile(path.join(dir, 'outbox.json'), JSON.stringify([duplicate]));
      await fs.writeFile(path.join(dir, 'delivery-log.json'), JSON.stringify([terminal]));

      const store = new NotificationStore(dir);
      await store.init();

      expect(store.listPending()).toEqual([]);
      expect(store.getById('transition')?.delivery.status).toBe('sent');
      const fresh = new NotificationStore(dir);
      await fresh.init();
      expect(fresh.listPending()).toEqual([]);
    });

    it('survives a restart with a pending item still in the outbox', async () => {
      const a = new NotificationStore(dir);
      await a.init();
      await a.enqueue(queued('n4', 's1'));

      const b = new NotificationStore(dir);
      await b.init();
      expect(b.listPending()).toHaveLength(1);
      expect(b.listPending()[0].notification.id).toBe('n4');
      await b.markSent('n4', '2026-06-29T00:00:10.000Z');
      expect(b.listPending()).toHaveLength(0);

      // And the delivery log persists across another restart.
      const c = new NotificationStore(dir);
      await c.init();
      expect(c.listLog()).toHaveLength(1);
    });
  });

  describe('delivery log', () => {
    it('caps the delivery log to the configured maximum (most-recent first)', async () => {
      const store = new NotificationStore(dir, { maxDeliveryLog: 3, maxDeliveryRecords: 20 });
      await store.init();
      for (let i = 0; i < 6; i++) {
        await store.enqueue(queued(`n${i}`, 's1'));
        await store.markSent(`n${i}`, '2026-06-29T00:00:00.000Z');
      }
      const log = store.listLog();
      expect(log).toHaveLength(3);
      expect(log[0].notification.id).toBe('n5');
      expect(log[2].notification.id).toBe('n3');
      // Pollable status/idempotency retention is wider than the recent-list view.
      expect(store.getById('n0')?.delivery.status).toBe('sent');
    });

    it('listForSession returns pending + recent deliveries for that session only', async () => {
      const store = new NotificationStore(dir);
      await store.init();
      await store.enqueue(queued('p1', 'sA'));
      await store.enqueue(queued('p2', 'sB'));
      await store.markSent('p2', '2026-06-29T00:00:00.000Z');

      expect(store.listForSession('sA').map((q) => q.notification.id)).toEqual(['p1']);
      expect(store.listForSession('sB').map((q) => q.notification.id)).toEqual(['p2']);
      expect(store.listForSession('sC')).toEqual([]);
    });
  });

  describe('atomicity & resilience', () => {
    it('enforces a private state directory and refuses symlinked ledger files', async () => {
      await fs.chmod(dir, 0o777);
      const outside = path.join(os.tmpdir(), `pi-notification-outside-${process.pid}-${Date.now()}.json`);
      await fs.writeFile(outside, JSON.stringify([queued('outside')]));
      await fs.symlink(outside, path.join(dir, 'delivery-log.json'));

      const store = new NotificationStore(dir);
      await store.init();

      expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
      expect(store.listLog()).toEqual([]);
      expect(await fs.readFile(outside, 'utf8')).toContain('outside');
      await fs.rm(outside, { force: true });
    });

    it('serializes concurrent writes without corrupting files', async () => {
      const store = new NotificationStore(dir);
      await store.init();
      await store.setOptIn(optIn('s1'));
      // Fire many enqueues concurrently — the write chain must serialize so
      // the file ends with a valid array containing every item.
      await Promise.all(
        Array.from({ length: 20 }, (_, i) => store.enqueue(queued(`c${i}`, 's1'))),
      );
      const fresh = new NotificationStore(dir);
      await fresh.init();
      expect(fresh.listPending()).toHaveLength(20);
    });

    it('tolerates a corrupt file without losing the rest', async () => {
      const store = new NotificationStore(dir);
      await store.init();
      await store.setOptIn(optIn('good'));
      await fs.writeFile(path.join(dir, 'outbox.json'), '{ not valid json', 'utf8');

      const fresh = new NotificationStore(dir);
      await fresh.init();
      expect(fresh.getOptIn('good')).toBeDefined();
      expect(fresh.listPending()).toEqual([]);
    });
  });
});

describe('NotificationStore — observability logging', () => {
  let dir: string;
  let records: LogRecord[];

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-notif-store-log-'));
    records = [];
    setLogTap((r) => records.push(r));
  });

  afterEach(async () => {
    setLogTap(null);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  it('warns (not silently swallows) when a persisted file is corrupt', async () => {
    const store = new NotificationStore(dir);
    await store.init();
    await store.setOptIn(optIn('good'));
    await fs.writeFile(path.join(dir, 'outbox.json'), '{ not valid json', 'utf8');

    records = []; // only care about the fresh instance's init
    const fresh = new NotificationStore(dir);
    await fresh.init();
    const rec = records.find(
      (r) => r.component === 'NotificationStore' && r.level === 'warn' && r.msg.includes('outbox.json'),
    );
    expect(rec).toBeDefined();
  });

  it('does not warn when a file is simply absent (normal on first boot)', async () => {
    const store = new NotificationStore(dir);
    await store.init();
    expect(records.find((r) => r.component === 'NotificationStore' && r.level === 'warn')).toBeUndefined();
  });
});
