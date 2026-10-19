import { describe, it, expect } from 'vitest';
import { pickNotificationChannel, type CapturedNotificationSend } from '../../../src/notifications/channel-factory.js';
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

  it('records each send and the rendered buttons into the validation capture log', async () => {
    const capture: CapturedNotificationSend[] = [];
    const ch = pickNotificationChannel({ validationMode: true, validationCapture: capture });
    const withActions: Notification = {
      ...sample,
      id: '019f23d5-624d-7ca3-b34c-53b6732c2b44',
      actions: [{ id: 'approve', label: 'Approve' }],
    };
    await ch.send(withActions);
    await ch.send(sample);

    expect(capture).toHaveLength(2);
    expect(capture[0].notification.id).toBe('019f23d5-624d-7ca3-b34c-53b6732c2b44');
    expect(capture[0].inlineKeyboard?.inline_keyboard[0][0]).toMatchObject({ text: 'Approve' });
    expect(capture[0].inlineKeyboard?.inline_keyboard[0][0].callback_data.length).toBeLessThanOrEqual(64);
    expect(capture[1].inlineKeyboard).toBeUndefined();
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
