/**
 * Notification channel selection.
 *
 * Extracted from internal-api/server.ts so the validation-mode capture-channel
 * branch is unit-testable. In validation mode an in-process capture channel
 * (always succeeds, never hits the network) so a disposable validation server
 * can observe deliveries via the log without sending real Telegram messages;
 * otherwise the real Telegram channel (configured only when creds are present).
 */

import type { NotificationChannel } from './types.js';
import { TelegramChannel } from './channels/telegram-channel.js';

export interface NotificationChannelConfig {
  validationMode: boolean;
  telegramBotToken?: string;
  telegramChatId?: string;
  timeoutMs?: number;
}

export function pickNotificationChannel(cfg: NotificationChannelConfig): NotificationChannel {
  if (cfg.validationMode) {
    return {
      id: 'telegram',
      isConfigured: () => true,
      async send() {
        /* captured in-process; observable via the delivery log */
      },
    };
  }
  return new TelegramChannel({
    botToken: cfg.telegramBotToken,
    chatId: cfg.telegramChatId,
    timeoutMs: cfg.timeoutMs,
  });
}
