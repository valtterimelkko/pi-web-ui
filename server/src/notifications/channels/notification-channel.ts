/**
 * Channel Router
 *
 * Fans a Notification out to every configured channel. Channels self-report
 * `isConfigured()` (false when their credentials are missing) and the router
 * skips unconfigured ones. A single channel throwing never rejects the whole
 * route — per-channel results are returned so the manager can decide retry.
 *
 * New channels are "register one adapter" — the formatter is channel-agnostic.
 */

import type { Notification, NotificationChannel } from '../types.js';

export interface ChannelSendResult {
  channel: string;
  ok: boolean;
  error?: string;
}

export class ChannelRouter {
  private readonly channels: NotificationChannel[] = [];

  register(channel: NotificationChannel): void {
    this.channels.push(channel);
  }

  listConfigured(): NotificationChannel[] {
    return this.channels.filter((c) => c.isConfigured());
  }

  async route(notification: Notification): Promise<ChannelSendResult[]> {
    const configured = this.listConfigured();
    return Promise.all(
      configured.map(async (ch) => {
        try {
          await ch.send(notification);
          return { channel: ch.id, ok: true };
        } catch (e) {
          return {
            channel: ch.id,
            ok: false,
            error: e instanceof Error ? e.message : String(e),
          };
        }
      }),
    );
  }
}
