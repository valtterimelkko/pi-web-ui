import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import type { NormalizedEvent } from '@pi-web-ui/shared';
import { NotificationStore } from '../../../src/notifications/notification-store.js';
import { ChannelRouter } from '../../../src/notifications/channels/notification-channel.js';
import { NotificationManager } from '../../../src/notifications/notification-manager.js';
import type {
  Notification,
  NotificationChannel,
  OptInRecord,
} from '../../../src/notifications/types.js';

const NOW = '2026-06-29T00:00:00.000Z';
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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

  describe('explicit notifications', () => {
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
