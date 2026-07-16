import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import type { NormalizedEvent } from '@pi-web-ui/shared';
import { NotificationStore } from '../../../src/notifications/notification-store.js';
import { ChannelRouter } from '../../../src/notifications/channels/notification-channel.js';
import { NotificationManager } from '../../../src/notifications/notification-manager.js';
import { NotificationIngressSpool } from '../../../src/notifications/notification-ingress-spool.js';
import { setLogTap, type LogRecord } from '../../../src/logging/logger.js';
import type {
  Notification,
  NotificationChannel,
  OptInRecord,
} from '../../../src/notifications/types.js';

const NOW = '2026-06-29T00:00:00.000Z';
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Real prod-derived Pi dual-id shapes (plan §2): basename (live sidebar id) and
// bare uuid (reloaded sidebar id / canonical opt-in key), sharing one `.jsonl` path.
const PI_UUID = '019f23d5-624d-7ca3-b34c-53b6732c2b44';
const PI_BASENAME = `2026-07-02T17-16-54-733Z_${PI_UUID}`;
const PI_PATH = `/root/.pi/agent/sessions/--root-pi-web-ui--/${PI_BASENAME}.jsonl`;

/** Fake runtime service that records observer attach/detach and can emit events. */
function fakeService() {
  const observers = new Map<string, Set<(e: NormalizedEvent) => void>>();
  const addCalls: { key: string }[] = [];
  const removeCalls: { key: string }[] = [];
  return {
    addCalls,
    removeCalls,
    addApiObserver(key: string, observer: (e: NormalizedEvent) => void): void {
      addCalls.push({ key });
      let set = observers.get(key);
      if (!set) {
        set = new Set();
        observers.set(key, set);
      }
      set.add(observer);
    },
    removeApiObserver(key: string, observer: (e: NormalizedEvent) => void): void {
      removeCalls.push({ key });
      observers.get(key)?.delete(observer);
    },
    emit(key: string, event: NormalizedEvent): void {
      observers.get(key)?.forEach((o) => {
        try {
          o(event);
        } catch {
          /* non-fatal */
        }
      });
    },
  };
}

/** Capture channel; fails every send when `fail` is set (so items stay pending). */
function captureChannel(opts: { fail?: boolean } = {}) {
  const received: Notification[] = [];
  const channel: NotificationChannel & { received: Notification[] } = {
    id: 'telegram',
    received,
    isConfigured: () => true,
    async send(n) {
      if (opts.fail) throw new Error('send failed');
      received.push(n);
    },
  };
  return channel;
}

interface Harness {
  mgr: NotificationManager;
  store: NotificationStore;
  pi: ReturnType<typeof fakeService>;
  claude: ReturnType<typeof fakeService>;
  channel: NotificationChannel & { received: Notification[] };
}

function makeHarness(
  dir: string,
  opts: {
    debounceMs?: number;
    channelFail?: boolean;
    store?: NotificationStore;
    enabled?: boolean;
    resolveLabel?: (sessionPath: string) => Promise<string | undefined>;
    ingressSpool?: NotificationIngressSpool;
  } = {},
): Harness {
  const store = opts.store ?? new NotificationStore(dir);
  const pi = fakeService();
  const claude = fakeService();
  const channel = captureChannel({ fail: opts.channelFail });
  const router = new ChannelRouter();
  router.register(channel);
  const mgr = new NotificationManager({
    enabled: opts.enabled ?? true,
    store,
    router,
    services: { pi, claude },
    tailMaxChars: 1200,
    publicBaseUrl: 'https://app.example.com',
    debounceMs: opts.debounceMs ?? 20,
    maxAttempts: 3,
    retryBackoffMs: 5000, // long: retries must NOT fire during test wait windows
    now: () => NOW,
    resolveLabel: opts.resolveLabel,
    ingressSpool: opts.ingressSpool,
    ingressPollMs: 60_000,
  });
  return { mgr, store, pi, claude, channel };
}

const piOptIn = (overrides: Partial<OptInRecord> = {}): OptInRecord => ({
  sessionId: 's1',
  runtime: 'pi',
  sessionPath: '/sessions/s1',
  optedInAt: NOW,
  label: 'Pi job',
  ...overrides,
});

const claudeOptIn = (overrides: Partial<OptInRecord> = {}): OptInRecord => ({
  sessionId: 'c1',
  runtime: 'claude',
  sessionPath: 'c1',
  optedInAt: NOW,
  label: 'Claude job',
  ...overrides,
});

function agentEnd(sessionId: string): NormalizedEvent {
  return { type: 'agent_end', sessionId, timestamp: 3, data: {} };
}
function assistantText(sessionId: string, text: string): NormalizedEvent[] {
  return [
    { type: 'message_start', sessionId, timestamp: 1, data: { role: 'assistant' } },
    {
      type: 'message_update',
      sessionId,
      timestamp: 2,
      data: { assistantMessageEvent: { type: 'text_delta', delta: text } },
    },
  ];
}

describe('NotificationManager', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-notif-mgr-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  describe('opt-in / opt-out wiring', () => {
    it('attaches an observer on the correct service + key on opt-in (Pi uses sessionPath)', async () => {
      const h = makeHarness(dir);
      await h.mgr.init();
      await h.mgr.optIn(piOptIn());
      expect(h.pi.addCalls).toEqual([{ key: '/sessions/s1' }]);
      expect(h.claude.addCalls).toHaveLength(0);
    });

    it('uses the sessionId as the observer key for non-Pi runtimes', async () => {
      const h = makeHarness(dir);
      await h.mgr.init();
      await h.mgr.optIn(claudeOptIn());
      expect(h.claude.addCalls).toEqual([{ key: 'c1' }]);
    });

    it('detaches the observer on opt-out', async () => {
      const h = makeHarness(dir);
      await h.mgr.init();
      await h.mgr.optIn(piOptIn());
      await h.mgr.optOut('s1');
      expect(h.pi.removeCalls).toEqual([{ key: '/sessions/s1' }]);
    });

    it('does not attach observers when disabled', async () => {
      const h = makeHarness(dir, { enabled: false });
      await h.mgr.init();
      await h.mgr.optIn(piOptIn());
      expect(h.pi.addCalls).toHaveLength(0);
      // The opt-in record is still persisted.
      expect(h.mgr.getOptIn('s1')).toBeDefined();
    });
  });

  describe('agent_end trigger', () => {
    it('builds + delivers a notification on agent_end for an opted-in session', async () => {
      const h = makeHarness(dir);
      await h.mgr.init();
      await h.mgr.optIn(piOptIn());
      for (const e of assistantText('s1', 'All tests pass.')) h.pi.emit('/sessions/s1', e);
      h.pi.emit('/sessions/s1', agentEnd('s1'));
      await wait(60);
      await h.mgr.drain();

      expect(h.channel.received).toHaveLength(1);
      const n = h.channel.received[0];
      expect(n.kind).toBe('agent_end');
      expect(n.sessionId).toBe('s1');
      expect(n.body).toContain('All tests pass.');
      expect(n.deepLink).toBe('https://app.example.com?session=s1');
    });

    it('ignores agent_end for a non-opted-in session', async () => {
      const h = makeHarness(dir);
      await h.mgr.init();
      // No optIn for s2.
      h.pi.emit('/sessions/s2', agentEnd('s2'));
      await wait(60);
      expect(h.channel.received).toHaveLength(0);
    });

    it('ignores non-agent_end events', async () => {
      const h = makeHarness(dir);
      await h.mgr.init();
      await h.mgr.optIn(piOptIn());
      for (const e of assistantText('s1', 'streaming')) h.pi.emit('/sessions/s1', e);
      await wait(60);
      expect(h.channel.received).toHaveLength(0);
    });

    it('stops notifying after opt-out', async () => {
      const h = makeHarness(dir);
      await h.mgr.init();
      await h.mgr.optIn(piOptIn());
      await h.mgr.optOut('s1');
      for (const e of assistantText('s1', 'x')) h.pi.emit('/sessions/s1', e);
      h.pi.emit('/sessions/s1', agentEnd('s1'));
      await wait(60);
      expect(h.channel.received).toHaveLength(0);
    });
  });

  describe('debounce', () => {
    it('durably flushes a pending agent_end when shutdown starts inside the debounce window', async () => {
      const h = makeHarness(dir, { debounceMs: 5000 });
      await h.mgr.init();
      await h.mgr.optIn(piOptIn());
      for (const event of assistantText('s1', 'last words')) h.pi.emit('/sessions/s1', event);
      h.pi.emit('/sessions/s1', agentEnd('s1'));

      h.mgr.shutdown();
      await h.mgr.waitForIdle();

      const fresh = new NotificationStore(dir);
      await fresh.init();
      expect(fresh.listPending()).toHaveLength(1);
      expect(fresh.listPending()[0].notification.body).toContain('last words');
      expect(h.channel.received).toHaveLength(0);
    });

    it('coalesces two agent_ends within the window into one notification', async () => {
      const h = makeHarness(dir, { debounceMs: 50 });
      await h.mgr.init();
      await h.mgr.optIn(piOptIn());
      for (const e of assistantText('s1', 'a')) h.pi.emit('/sessions/s1', e);
      h.pi.emit('/sessions/s1', agentEnd('s1'));
      h.pi.emit('/sessions/s1', agentEnd('s1')); // second within window
      await wait(150);
      expect(h.channel.received).toHaveLength(1);
    });
  });

  describe('outbox delivery lifecycle', () => {
    it('keeps a failed delivery pending (retried later) instead of dropping it', async () => {
      const h = makeHarness(dir, { channelFail: true });
      await h.mgr.init();
      await h.mgr.optIn(piOptIn());
      h.pi.emit('/sessions/s1', agentEnd('s1'));
      await wait(60);
      await h.mgr.drain();
      // Channel failed → still pending in the outbox, attempts incremented.
      const pending = h.store.listPending();
      expect(pending).toHaveLength(1);
      expect(pending[0].delivery.attempts).toBeGreaterThanOrEqual(1);
      expect(h.channel.received).toHaveLength(0);
      h.mgr.shutdown();
    });

    it('gives up after maxAttempts and marks the delivery failed in the log', async () => {
      const h = makeHarness(dir, { channelFail: true }); // maxAttempts = 3
      await h.mgr.init();
      await h.mgr.optIn(piOptIn());
      h.pi.emit('/sessions/s1', agentEnd('s1'));
      await wait(60); // debounce flush → drain #1 (attempt 1, non-terminal)
      await h.mgr.drain(); // drain #2 (attempt 2, non-terminal)
      await h.mgr.drain(); // drain #3 (attempt 3 → terminal → failed)
      expect(h.store.listPending()).toHaveLength(0);
      const log = h.store.listLog();
      expect(log).toHaveLength(1);
      expect(log[0].delivery.status).toBe('failed');
      expect(log[0].delivery.attempts).toBe(3);
      h.mgr.shutdown();
    });
  });

  describe('rehydration (simulated restart)', () => {
    it('re-attaches observers for opted-in sessions and resumes the pending outbox', async () => {
      // Manager A: opt-in + a turn whose delivery fails → item stays pending.
      const a = makeHarness(dir, { channelFail: true });
      await a.mgr.init();
      await a.mgr.optIn(piOptIn());
      for (const e of assistantText('s1', 'first turn')) a.pi.emit('/sessions/s1', e);
      a.pi.emit('/sessions/s1', agentEnd('s1'));
      await wait(60);
      await a.mgr.drain();
      a.mgr.shutdown();

      // Manager B: same store dir (fresh instances) + a working channel.
      const b = makeHarness(dir, { store: new NotificationStore(dir) });
      await b.mgr.init();
      // Observer re-attached for the still-opted-in session.
      expect(b.pi.addCalls).toEqual([{ key: '/sessions/s1' }]);
      // Pending outbox drained and delivered by the working channel.
      await wait(40);
      expect(b.channel.received).toHaveLength(1);
      expect(b.channel.received[0].body).toContain('first turn');
      b.mgr.shutdown();
    });
  });

  describe('canonical-id migration on init (desync self-heal)', () => {
    it('re-keys a legacy basename-keyed Pi opt-in to the bare uuid', async () => {
      const store = new NotificationStore(dir);
      await store.init();
      await store.setOptIn({
        sessionId: PI_BASENAME,
        runtime: 'pi',
        sessionPath: PI_PATH,
        optedInAt: NOW,
        label: 'live basename opt-in',
      });

      const h = makeHarness(dir, { store });
      await h.mgr.init();

      // Now findable under the bare uuid (the reloaded sidebar id); the legacy
      // basename key is gone.
      expect(h.mgr.getOptIn(PI_UUID)?.label).toBe('live basename opt-in');
      expect(h.mgr.getOptIn(PI_BASENAME)).toBeUndefined();
      // Exactly one observer attached (on the real path) — no duplicate husk.
      expect(h.pi.addCalls).toEqual([{ key: PI_PATH }]);
      h.mgr.shutdown();
    });

    it('dedupes a basename record and a uuid record for the same session (no double-notify)', async () => {
      const store = new NotificationStore(dir);
      await store.init();
      // Legacy live-sidebar opt-in keyed by basename (newer).
      await store.setOptIn({
        sessionId: PI_BASENAME,
        runtime: 'pi',
        sessionPath: PI_PATH,
        optedInAt: '2026-07-02T17:20:00.000Z',
        label: 'from basename',
      });
      // Earlier internal-API opt-in already keyed by uuid (older).
      await store.setOptIn({
        sessionId: PI_UUID,
        runtime: 'pi',
        sessionPath: PI_PATH,
        optedInAt: '2026-07-02T17:00:00.000Z',
        label: 'from uuid',
      });

      const h = makeHarness(dir, { store });
      await h.mgr.init();

      // Both collapse to the uuid; the newer (basename) record wins, the older
      // uuid husk is replaced — so exactly one record + one observer remain.
      const rec = h.mgr.getOptIn(PI_UUID);
      expect(rec?.label).toBe('from basename');
      expect(rec?.optedInAt).toBe('2026-07-02T17:20:00.000Z');
      expect(h.mgr.listOptIns().filter((r) => r.sessionPath === PI_PATH)).toHaveLength(1);
      expect(h.pi.addCalls).toEqual([{ key: PI_PATH }]);
      h.mgr.shutdown();
    });

    it('keeps the uuid record when it is newer than the legacy basename one', async () => {
      const store = new NotificationStore(dir);
      await store.init();
      await store.setOptIn({
        sessionId: PI_BASENAME,
        runtime: 'pi',
        sessionPath: PI_PATH,
        optedInAt: '2026-07-02T17:00:00.000Z',
        label: 'older basename',
      });
      await store.setOptIn({
        sessionId: PI_UUID,
        runtime: 'pi',
        sessionPath: PI_PATH,
        optedInAt: '2026-07-02T17:20:00.000Z',
        label: 'newer uuid',
      });

      const h = makeHarness(dir, { store });
      await h.mgr.init();

      expect(h.mgr.getOptIn(PI_UUID)?.label).toBe('newer uuid');
      expect(h.mgr.getOptIn(PI_BASENAME)).toBeUndefined();
      expect(h.pi.addCalls).toEqual([{ key: PI_PATH }]);
      h.mgr.shutdown();
    });

    it('leaves non-Pi opt-ins untouched', async () => {
      const store = new NotificationStore(dir);
      await store.init();
      await store.setOptIn(claudeOptIn());

      const h = makeHarness(dir, { store });
      await h.mgr.init();

      expect(h.mgr.getOptIn('c1')?.runtime).toBe('claude');
      expect(h.claude.addCalls).toEqual([{ key: 'c1' }]);
      h.mgr.shutdown();
    });

    it('is idempotent: a second init does not duplicate or lose records', async () => {
      const store = new NotificationStore(dir);
      await store.init();
      await store.setOptIn({
        sessionId: PI_BASENAME,
        runtime: 'pi',
        sessionPath: PI_PATH,
        optedInAt: NOW,
        label: 'live',
      });

      const h = makeHarness(dir, { store });
      await h.mgr.init();
      const firstCount = h.mgr.listOptIns().length;
      // Re-run init (simulating a second boot on the already-normalized store).
      await h.mgr.init();
      expect(h.mgr.listOptIns().length).toBe(firstCount);
      expect(h.mgr.getOptIn(PI_UUID)?.label).toBe('live');
      expect(h.mgr.getOptIn(PI_BASENAME)).toBeUndefined();
      h.mgr.shutdown();
    });
  });

  describe('explicit notifications', () => {
    it('ingests a durable terminal spool record and deletes it after durable acceptance', async () => {
      const ingressDir = path.join(dir, 'ingress');
      await fs.mkdir(ingressDir, { recursive: true });
      await fs.writeFile(path.join(ingressDir, 'queued.json'), JSON.stringify({
        version: 1,
        idempotencyKey: 'spooled-key',
        title: 'Offline completion',
        body: 'Recovered after restart.',
        createdAt: '2026-06-28T23:59:00.000Z',
        expiresAt: '2026-06-30T00:00:00.000Z',
      }));
      const ingressSpool = new NotificationIngressSpool(ingressDir, {
        now: () => Date.parse(NOW),
      });
      const h = makeHarness(dir, { ingressSpool });

      await h.mgr.init();
      await h.mgr.drain();

      expect(h.channel.received).toHaveLength(1);
      expect(h.channel.received[0].title).toBe('Offline completion');
      expect(await fs.readdir(ingressDir)).toEqual([]);
    });

    it('restores every unprocessed claim when one spool acceptance fails transiently', async () => {
      const ingressDir = path.join(dir, 'ingress-failure');
      const ingressSpool = new NotificationIngressSpool(ingressDir, { now: () => Date.parse(NOW) });
      const h = makeHarness(dir, { ingressSpool });
      await h.mgr.init();
      for (let index = 0; index < 3; index += 1) {
        await fs.writeFile(path.join(ingressDir, `${index}.json`), JSON.stringify({
          version: 1,
          idempotencyKey: `spool-${index}`,
          title: `Spool ${index}`,
          body: 'body',
          createdAt: '2026-06-28T23:59:00.000Z',
          expiresAt: '2026-06-30T00:00:00.000Z',
        }));
      }
      const original = h.mgr.acceptExplicit.bind(h.mgr);
      let calls = 0;
      vi.spyOn(h.mgr, 'acceptExplicit').mockImplementation(async (...args) => {
        calls += 1;
        if (calls === 2) throw new Error('transient store failure');
        return original(...args);
      });

      await expect(h.mgr.drainIngress()).rejects.toThrow(/transient/);

      const files = await fs.readdir(ingressDir);
      expect(files.some((name) => name.startsWith('.processing-'))).toBe(false);
      expect(files.filter((name) => name.endsWith('.json'))).toHaveLength(2);
    });

    it('deduplicates concurrent identical ingress keys and detects payload conflicts', async () => {
      const h = makeHarness(dir);
      await h.mgr.init();
      const input = { title: 'Deploy', body: 'shipped', deepLink: 'https://x' };
      const [first, second] = await Promise.all([
        h.mgr.acceptExplicit(input, 'same-caller-key'),
        h.mgr.acceptExplicit(input, 'same-caller-key'),
      ]);

      expect(first.notification.id).toBe(second.notification.id);
      expect([first.duplicate, second.duplicate].sort()).toEqual([false, true]);
      await expect(h.mgr.acceptExplicit({ ...input, body: 'different' }, 'same-caller-key'))
        .rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' });
      await h.mgr.drain();
      expect(h.channel.received).toHaveLength(1);
    });

    it('persists but does not send explicit notifications while the master switch is disabled', async () => {
      const h = makeHarness(dir, { enabled: false });
      await h.mgr.init();
      const accepted = await h.mgr.acceptExplicit({ title: 'Disabled', body: 'queued' }, 'disabled-key');
      await h.mgr.drain();

      expect(h.channel.received).toHaveLength(0);
      expect(h.store.getById(accepted.notification.id)?.delivery.status).toBe('pending');
    });

    it('dispatches an explicit notification with no session required', async () => {
      const h = makeHarness(dir);
      await h.mgr.init();
      await h.mgr.emitExplicit({ title: 'Deploy', body: 'shipped', deepLink: 'https://x' });
      await h.mgr.drain();
      expect(h.channel.received).toHaveLength(1);
      expect(h.channel.received[0].kind).toBe('explicit');
      expect(h.channel.received[0].title).toBe('Deploy');
      expect(h.channel.received[0].sessionId).toBeUndefined();
    });
  });

  describe('live session-name resolution (renamed sessions)', () => {
    it('surfaces the live-resolved display name in the title, overriding the opt-in snapshot label', async () => {
      const h = makeHarness(dir, { resolveLabel: async () => 'My Renamed Session' });
      await h.mgr.init();
      await h.mgr.optIn(piOptIn({ label: 'old snapshot label' }));
      for (const e of assistantText('s1', 'done')) h.pi.emit('/sessions/s1', e);
      h.pi.emit('/sessions/s1', agentEnd('s1'));
      await wait(60);
      await h.mgr.drain();
      expect(h.channel.received).toHaveLength(1);
      expect(h.channel.received[0].title).toBe('🤖 My Renamed Session · waiting for you');
    });

    it('passes the opt-in sessionPath to the resolver (prefs are keyed by path)', async () => {
      const seen: string[] = [];
      const h = makeHarness(dir, { resolveLabel: async (p) => (seen.push(p), 'x') });
      await h.mgr.init();
      await h.mgr.optIn(piOptIn({ sessionPath: '/sessions/abc' }));
      for (const e of assistantText('s1', 'done')) h.pi.emit('/sessions/abc', e);
      h.pi.emit('/sessions/abc', agentEnd('s1'));
      await wait(60);
      await h.mgr.drain();
      expect(seen).toContain('/sessions/abc');
    });

    it('falls back to the opt-in snapshot label when the resolver returns nothing', async () => {
      const h = makeHarness(dir, { resolveLabel: async () => undefined });
      await h.mgr.init();
      await h.mgr.optIn(piOptIn({ label: 'Snapshot name' }));
      for (const e of assistantText('s1', 'done')) h.pi.emit('/sessions/s1', e);
      h.pi.emit('/sessions/s1', agentEnd('s1'));
      await wait(60);
      await h.mgr.drain();
      expect(h.channel.received[0].title).toBe('🤖 Snapshot name · waiting for you');
    });

    it('falls back to the runtime label when neither resolver nor snapshot provide a name', async () => {
      const h = makeHarness(dir, { resolveLabel: async () => undefined });
      await h.mgr.init();
      await h.mgr.optIn(piOptIn({ label: undefined }));
      for (const e of assistantText('s1', 'done')) h.pi.emit('/sessions/s1', e);
      h.pi.emit('/sessions/s1', agentEnd('s1'));
      await wait(60);
      await h.mgr.drain();
      expect(h.channel.received[0].title).toBe('🤖 Pi · waiting for you');
    });

    it('ignores a blank/whitespace resolver result and falls back', async () => {
      const h = makeHarness(dir, { resolveLabel: async () => '   ' });
      await h.mgr.init();
      await h.mgr.optIn(piOptIn({ label: 'Snapshot name' }));
      for (const e of assistantText('s1', 'done')) h.pi.emit('/sessions/s1', e);
      h.pi.emit('/sessions/s1', agentEnd('s1'));
      await wait(60);
      await h.mgr.drain();
      expect(h.channel.received[0].title).toBe('🤖 Snapshot name · waiting for you');
    });

    it('never lets a throwing resolver break the notification (falls back gracefully)', async () => {
      const h = makeHarness(dir, { resolveLabel: async () => { throw new Error('prefs read failed'); } });
      await h.mgr.init();
      await h.mgr.optIn(piOptIn({ label: 'Snapshot name' }));
      for (const e of assistantText('s1', 'done')) h.pi.emit('/sessions/s1', e);
      h.pi.emit('/sessions/s1', agentEnd('s1'));
      await wait(60);
      await h.mgr.drain();
      expect(h.channel.received).toHaveLength(1);
      expect(h.channel.received[0].title).toBe('🤖 Snapshot name · waiting for you');
    });

    it('does not require a resolver — back-compat: uses the opt-in snapshot label', async () => {
      const h = makeHarness(dir); // no resolveLabel injected
      await h.mgr.init();
      await h.mgr.optIn(piOptIn({ label: 'Snapshot name' }));
      for (const e of assistantText('s1', 'done')) h.pi.emit('/sessions/s1', e);
      h.pi.emit('/sessions/s1', agentEnd('s1'));
      await wait(60);
      await h.mgr.drain();
      expect(h.channel.received[0].title).toBe('🤖 Snapshot name · waiting for you');
    });
  });
});

describe('NotificationManager — observability logging', () => {
  let dir: string;
  let records: LogRecord[];

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-notif-mgr-log-'));
    records = [];
    setLogTap((r) => records.push(r));
  });

  afterEach(async () => {
    setLogTap(null);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  const findLog = (level: 'info' | 'warn' | 'error', substr: string): LogRecord | undefined =>
    records.find((r) => r.component === 'NotificationManager' && r.level === level && r.msg.includes(substr));

  it('logs opt-in with sessionId + runtime attached', async () => {
    const h = makeHarness(dir);
    await h.mgr.init();
    await h.mgr.optIn(piOptIn());
    const rec = findLog('info', 'opted in');
    expect(rec).toBeDefined();
    expect(rec?.sessionId).toBe('s1');
    expect(rec?.runtime).toBe('pi');
  });

  it('logs opt-out with sessionId attached', async () => {
    const h = makeHarness(dir);
    await h.mgr.init();
    await h.mgr.optIn(piOptIn());
    await h.mgr.optOut('s1');
    const rec = findLog('info', 'opted out');
    expect(rec).toBeDefined();
    expect(rec?.sessionId).toBe('s1');
  });

  it('warns when attach cannot find a wired runtime service (silent-failure blind spot)', async () => {
    const h = makeHarness(dir);
    await h.mgr.init();
    // 'opencode' has no service wired in this harness (only pi + claude).
    await h.mgr.optIn({
      sessionId: 'oc1',
      runtime: 'opencode',
      sessionPath: 'oc1',
      optedInAt: NOW,
      label: 'OC job',
    });
    const rec = findLog('warn', 'runtime service not wired');
    expect(rec).toBeDefined();
    expect(rec?.sessionId).toBe('oc1');
    expect(rec?.runtime).toBe('opencode');
  });

  it('warns on init when notifications are enabled but no channel is configured', async () => {
    const store = new NotificationStore(dir);
    const router = new ChannelRouter(); // nothing registered
    const mgr = new NotificationManager({
      enabled: true,
      store,
      router,
      services: {},
      tailMaxChars: 1200,
      debounceMs: 20,
      maxAttempts: 3,
      now: () => NOW,
    });
    await mgr.init();
    expect(findLog('warn', 'no delivery channel is configured')).toBeDefined();
  });

  it('does not warn about missing channel when a channel is configured', async () => {
    const h = makeHarness(dir);
    await h.mgr.init();
    expect(findLog('warn', 'no delivery channel is configured')).toBeUndefined();
  });

  it('logs a queued notification on agent_end with the notification id', async () => {
    const h = makeHarness(dir);
    await h.mgr.init();
    await h.mgr.optIn(piOptIn());
    for (const e of assistantText('s1', 'done')) h.pi.emit('/sessions/s1', e);
    h.pi.emit('/sessions/s1', agentEnd('s1'));
    await wait(60);
    const rec = findLog('info', 'notification queued');
    expect(rec).toBeDefined();
    expect(rec?.sessionId).toBe('s1');
    expect(rec?.runtime).toBe('pi');
    expect(h.channel.received).toHaveLength(1);
    expect(rec?.msg).toContain(h.channel.received[0].id);
  });

  it('logs successful delivery with the notification id', async () => {
    const h = makeHarness(dir);
    await h.mgr.init();
    await h.mgr.optIn(piOptIn());
    h.pi.emit('/sessions/s1', agentEnd('s1'));
    await wait(60);
    await h.mgr.drain();
    const rec = findLog('info', 'notification delivered');
    expect(rec).toBeDefined();
    expect(rec?.sessionId).toBe('s1');
  });

  it('warns on a failed delivery attempt with the error and attempt count', async () => {
    const h = makeHarness(dir, { channelFail: true });
    await h.mgr.init();
    await h.mgr.optIn(piOptIn());
    h.pi.emit('/sessions/s1', agentEnd('s1'));
    await wait(60);
    await h.mgr.drain();
    const rec = findLog('warn', 'delivery attempt');
    expect(rec).toBeDefined();
    expect(rec?.msg).toContain('send failed');
    h.mgr.shutdown();
  });

  it('logs an explicit notification queue with its id', async () => {
    const h = makeHarness(dir);
    await h.mgr.init();
    const n = await h.mgr.emitExplicit({ title: 'Deploy', body: 'shipped' });
    const rec = findLog('info', 'explicit notification queued');
    expect(rec).toBeDefined();
    expect(rec?.msg).toContain(n.id);
  });

  it('logs rehydration count on init (restart observability)', async () => {
    const a = makeHarness(dir);
    await a.mgr.init();
    await a.mgr.optIn(piOptIn());
    a.mgr.shutdown();

    records = []; // reset: only care about manager B's init log
    const b = makeHarness(dir, { store: new NotificationStore(dir) });
    await b.mgr.init();
    const rec = findLog('info', 'rehydrated');
    expect(rec).toBeDefined();
    expect(rec?.msg).toContain('1');
    b.mgr.shutdown();
  });

  it('logs the canonical-id migration count when legacy opt-ins are normalized', async () => {
    const store = new NotificationStore(dir);
    await store.init();
    await store.setOptIn({
      sessionId: PI_BASENAME,
      runtime: 'pi',
      sessionPath: PI_PATH,
      optedInAt: NOW,
      label: 'legacy',
    });

    const h = makeHarness(dir, { store });
    await h.mgr.init();
    const rec = findLog('info', 'normalized');
    expect(rec).toBeDefined();
    expect(rec?.msg).toContain('1');
    h.mgr.shutdown();
  });
});
