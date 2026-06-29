import { describe, it, expect } from 'vitest';
import { pickNotificationChannel } from '../../../src/notifications/channel-factory.js';
import type { Notification } from '../../../src/notifications/types.js';

const sample: Notification = {
  id: 'n',
  kind: 'explicit',
  title: 't',
  body: 'b',
  createdAt: '2026-06-29T00:00:00.000Z',
};

describe('pickNotificationChannel', () => {
  it('returns a capture channel (always configured, no-op send) in validation mode', async () => {
    const ch = pickNotificationChannel({ validationMode: true });
    expect(ch.id).toBe('telegram');
    expect(ch.isConfigured()).toBe(true);
    await expect(ch.send(sample)).resolves.toBeUndefined();
  });

  it('returns a configured Telegram channel when creds are present (non-validation)', () => {
    const ch = pickNotificationChannel({
      validationMode: false,
      telegramBotToken: 'FAKE:TOKEN',
      telegramChatId: '123',
    });
    expect(ch.isConfigured()).toBe(true);
  });

  it('returns an unconfigured Telegram channel when creds are missing', () => {
    const ch = pickNotificationChannel({ validationMode: false });
    expect(ch.isConfigured()).toBe(false);
  });
});
