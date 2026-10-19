/**
 * Notification channel selection.
 *
 * Extracted from internal-api/server.ts so the validation-mode capture-channel
 * branch is unit-testable. In validation mode an in-process capture channel
 * (always succeeds, never hits the network) so a disposable validation server
 * can observe deliveries via the log without sending real Telegram messages;
 * otherwise the real Telegram channel (configured only when creds are present).
 */

import type { Notification, NotificationChannel } from './types.js';
import { TelegramChannel } from './channels/telegram-channel.js';
import { buildInlineKeyboard, type TelegramInlineKeyboardMarkup } from './channels/telegram-callback-data.js';

/** One captured send in validation mode: the notification and, when present, its rendered buttons. */
export interface CapturedNotificationSend {
  notification: Notification;
  inlineKeyboard?: TelegramInlineKeyboardMarkup;
}

export interface NotificationChannelConfig {
  validationMode: boolean;
  telegramBotToken?: string;
  telegramChatId?: string;
  timeoutMs?: number;
  /** Validation mode only: the capture channel appends every send here. */
  validationCapture?: CapturedNotificationSend[];
}

export function pickNotificationChannel(cfg: NotificationChannelConfig): NotificationChannel {
  if (cfg.validationMode) {
    const capture = cfg.validationCapture;
    return {
      id: 'telegram',
      isConfigured: () => true,
      async send(notification) {
        // Contract CHANNEL.md §7: in validation mode the capture channel
        // records the buttons (and everything else) in-process — never the
        // network — so a validation server can observe what would have been
        // rendered and tests can inject taps.
        capture?.push({
          notification,
          ...(notification.actions?.length
            ? { inlineKeyboard: buildInlineKeyboard(notification.actions, notification.id) }
            : {}),
        });
      },
    };
  }
  return new TelegramChannel({
    botToken: cfg.telegramBotToken,
    chatId: cfg.telegramChatId,
    timeoutMs: cfg.timeoutMs,
  });
}
