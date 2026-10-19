import { describe, it, expect } from 'vitest';
import {
  formatCallbackData,
  parseCallbackData,
  buildInlineKeyboard,
  TELEGRAM_CALLBACK_DATA_MAX_BYTES,
} from '../../../src/notifications/channels/telegram-callback-data.js';
import type { NotificationAction } from '../../../src/notifications/types.js';

const UUID = '019f23d5-624d-7ca3-b34c-53b6732c2b44';

describe('telegram callback_data codec', () => {
  describe('formatCallbackData', () => {
    it('stays within Telegram’s 64-byte limit for the longest legal ids', () => {
      const data = formatCallbackData(UUID, 'a'.repeat(32));
      expect(data.length).toBeLessThanOrEqual(TELEGRAM_CALLBACK_DATA_MAX_BYTES);
    });

    it('encodes the notification id and the action id (round-trip)', () => {
      const data = formatCallbackData(UUID, 'approve');
      expect(data.length).toBeLessThanOrEqual(64);
      expect(parseCallbackData(data)).toEqual({ notificationId: UUID, actionId: 'approve' });
    });

    it('keeps the action id verbatim (it uses only Telegram-safe bytes)', () => {
      const actionId = 'Reject_2-x';
      expect(formatCallbackData(UUID, actionId)).toContain(actionId);
    });

    it('is deterministic', () => {
      expect(formatCallbackData(UUID, 'ok')).toBe(formatCallbackData(UUID, 'ok'));
    });

    it('throws on a notification id that is not a UUID', () => {
      expect(() => formatCallbackData('not-a-uuid', 'ok')).toThrow(/UUID/);
    });
  });

  describe('parseCallbackData', () => {
    it('returns null for foreign or malformed payloads (never throws)', () => {
      expect(parseCallbackData('totally-foreign')).toBeNull();
      expect(parseCallbackData('')).toBeNull();
      expect(parseCallbackData('.'.repeat(23) + 'ok')).toBeNull();
      expect(parseCallbackData('short.')).toBeNull();
      expect(parseCallbackData('a'.repeat(21) + '.' + 'ok')).toBeNull(); // wrong uuid field width
    });

    it('treats a structurally valid but unknown payload as well-formed (lookup answers, codec never throws)', () => {
      const parsed = parseCallbackData('z'.repeat(22) + '.ok');
      expect(parsed).not.toBeNull();
      expect(parsed?.actionId).toBe('ok');
      expect(parsed?.notificationId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('round-trips the shortest legal action id', () => {
      const data = formatCallbackData(UUID, 'a');
      expect(parseCallbackData(data)).toEqual({ notificationId: UUID, actionId: 'a' });
    });
  });

  describe('buildInlineKeyboard', () => {
    it('renders one row of buttons (label + callback_data per action)', () => {
      const actions: NotificationAction[] = [
        { id: 'approve', label: 'Approve' },
        { id: 'reject', label: 'Reject' },
      ];
      const keyboard = buildInlineKeyboard(actions, UUID);
      expect(keyboard.inline_keyboard).toHaveLength(1);
      expect(keyboard.inline_keyboard[0]).toEqual([
        { text: 'Approve', callback_data: formatCallbackData(UUID, 'approve') },
        { text: 'Reject', callback_data: formatCallbackData(UUID, 'reject') },
      ]);
    });

    it('accepts the maximum of three actions within the byte limit', () => {
      const actions: NotificationAction[] = [
        { id: 'a'.repeat(32), label: 'One' },
        { id: 'b'.repeat(32), label: 'Two' },
        { id: 'c'.repeat(32), label: 'Three' },
      ];
      const keyboard = buildInlineKeyboard(actions, UUID);
      for (const button of keyboard.inline_keyboard[0]) {
        expect(button.callback_data.length).toBeLessThanOrEqual(TELEGRAM_CALLBACK_DATA_MAX_BYTES);
      }
    });
  });
});
