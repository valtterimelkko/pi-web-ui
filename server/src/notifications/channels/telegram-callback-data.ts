/**
 * Telegram callback_data codec + inline keyboard for notification actions
 * (contract CHANNEL.md §7).
 *
 * Telegram caps `callback_data` at 64 bytes and allows only `A-Za-z0-9_-`
 * inside it. A notification id is a UUID (36 chars) and an action id may be up
 * to 32 chars, so concatenating them verbatim cannot fit. Instead the UUID's 16
 * raw bytes are base64url-encoded (22 chars, Telegram-safe) and the action id —
 * whose allowed charset already equals Telegram's — is appended verbatim after
 * a `.` separator at a fixed position:
 *
 *     [0:22]  base64url of the notification id's 16 UUID bytes
 *     [22]    '.'
 *     [23:]   action id (1–32 chars)
 *
 * The longest legal payload is 22 + 1 + 32 = 55 bytes ≤ 64. Parsing is
 * positional, so an action id containing `-`/`_` is unambiguous.
 */

import type { NotificationAction } from '../types.js';

export const TELEGRAM_CALLBACK_DATA_MAX_BYTES = 64;

const UUID_PARTS_LENGTHS = [8, 4, 4, 4, 12] as const;

/** Encode `<notification id>.<action id>` into a ≤64-byte Telegram-safe payload. */
export function formatCallbackData(notificationId: string, actionId: string): string {
  const hex = notificationId.replace(/-/g, '');
  if (notificationId.length !== 36 || !/^[0-9a-f]{32}$/.test(hex)) {
    throw new Error(`callback_data requires a UUID notification id, got: ${notificationId}`);
  }
  const encoded = Buffer.from(hex, 'hex').toString('base64url');
  return `${encoded}.${actionId}`;
}

/** Decode a callback_data payload produced by {@link formatCallbackData}; null when foreign. */
export function parseCallbackData(data: string): { notificationId: string; actionId: string } | null {
  if (data.length < 24 || data[22] !== '.') return null;
  const encoded = data.slice(0, 22);
  const actionId = data.slice(23);
  let bytes: Buffer;
  try {
    bytes = Buffer.from(encoded, 'base64url');
  } catch {
    return null;
  }
  if (bytes.length !== 16 || !/^[A-Za-z0-9_-]{22}$/.test(encoded)) return null;
  const hex = bytes.toString('hex');
  let notificationId = '';
  let offset = 0;
  for (const part of UUID_PARTS_LENGTHS) {
    if (offset > 0) notificationId += '-';
    notificationId += hex.slice(offset, offset + part);
    offset += part;
  }
  return { notificationId, actionId };
}

export interface TelegramInlineButton {
  text: string;
  callback_data: string;
}

export interface TelegramInlineKeyboardMarkup {
  inline_keyboard: TelegramInlineButton[][];
}

/**
 * Render a notification's actions as a one-row inline keyboard. Callers pass at
 * most three actions (enforced at acceptance); each button carries the encoded
 * notification + action ids.
 */
export function buildInlineKeyboard(
  actions: readonly NotificationAction[],
  notificationId: string,
): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      actions.map((action) => ({
        text: action.label,
        callback_data: formatCallbackData(notificationId, action.id),
      })),
    ],
  };
}
