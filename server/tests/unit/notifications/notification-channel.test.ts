import { describe, it, expect } from 'vitest';
import { ChannelRouter } from '../../../src/notifications/channels/notification-channel.js';
import type { Notification, NotificationChannel } from '../../../src/notifications/types.js';

function notification(id = 'n1'): Notification {
  return { id, kind: 'explicit', title: 't', body: 'b', createdAt: '2026-06-29T00:00:00.000Z' };
}

function fakeChannel(opts: {
  configured: boolean;
  send?: (n: Notification) => void;
  throwError?: string;
}): NotificationChannel {
  return {
    id: 'telegram',
    isConfigured: () => opts.configured,
    send: async (n) => {
      if (opts.throwError) throw new Error(opts.throwError);
      opts.send?.(n);
    },
  };
}

describe('ChannelRouter', () => {
  it('lists only configured channels', () => {
    const router = new ChannelRouter();
    router.register(fakeChannel({ configured: true }));
    router.register(fakeChannel({ configured: false }));
    expect(router.listConfigured()).toHaveLength(1);
  });

  it('routes a notification to every configured channel and reports success', async () => {
    const router = new ChannelRouter();
    const sentA: string[] = [];
    const sentB: string[] = [];
    router.register(fakeChannel({ configured: true, send: (n) => sentA.push(n.id) }));
    router.register(fakeChannel({ configured: true, send: (n) => sentB.push(n.id) }));

    const results = await router.route(notification('x1'));
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(sentA).toEqual(['x1']);
    expect(sentB).toEqual(['x1']);
  });

  it('collects a per-channel error without rejecting the whole route', async () => {
    const router = new ChannelRouter();
    router.register(fakeChannel({ configured: true, throwError: 'boom' }));
    const results = await router.route(notification('x2'));
    expect(results).toEqual([{ channel: 'telegram', ok: false, error: 'boom' }]);
  });

  it('returns an empty result set when no channel is configured', async () => {
    const router = new ChannelRouter();
    router.register(fakeChannel({ configured: false }));
    expect(await router.route(notification('x3'))).toEqual([]);
  });
});
