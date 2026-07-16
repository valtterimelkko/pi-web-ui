/**
 * Telegram Channel
 *
 * Sends a Notification via the Telegram Bot API `sendMessage`. Transport is
 * injectable (default: global fetch) so tests never hit the network.
 *
 * Security: the bot token is part of the request URL. It must NEVER appear in
 * logs, thrown errors, or any persisted record. On failure we surface only the
 * HTTP status and a redacted, length-capped slice of the response body.
 */

import type { Notification, NotificationChannel } from '../types.js';

const TELEGRAM_API_BASE = 'https://api.telegram.org';
const TELEGRAM_TEXT_MAX = 4096;
const REDACTED = '<redacted>';
const TEXT_ELLIPSIS = '…';

/**
 * Narrow transport seam. The default posts via global fetch; tests inject a
 * fake that records the URL/body and returns a controlled response.
 */
export interface TelegramTransport {
  post(url: string, body: string, signal?: AbortSignal): Promise<{ status: number; ok: boolean; bodyText: string }>;
}

export const defaultTelegramTransport: TelegramTransport = {
  async post(url, body, signal) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal,
    });
    return { status: res.status, ok: res.ok, bodyText: await res.text() };
  },
};

export interface TelegramChannelOptions {
  botToken?: string;
  chatId?: string;
  transport?: TelegramTransport;
  timeoutMs?: number;
}

export class TelegramChannel implements NotificationChannel {
  readonly id = 'telegram' as const;
  private readonly botToken?: string;
  private readonly chatId?: string;
  private readonly transport: TelegramTransport;
  private readonly timeoutMs: number;

  constructor(opts: TelegramChannelOptions = {}) {
    this.botToken = opts.botToken;
    this.chatId = opts.chatId;
    this.transport = opts.transport ?? defaultTelegramTransport;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  isConfigured(): boolean {
    return Boolean(this.botToken && this.chatId);
  }

  async send(notification: Notification): Promise<void> {
    if (!this.isConfigured()) {
      throw new Error(
        'Telegram channel is not configured (TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID unset)',
      );
    }
    const text = composeTelegramText(notification);
    const url = `${TELEGRAM_API_BASE}/bot${this.botToken}/sendMessage`;
    const body = JSON.stringify({
      chat_id: this.chatId,
      text,
      disable_web_page_preview: true,
    });
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new Error(`Telegram sendMessage timed out after ${this.timeoutMs}ms`));
    }, this.timeoutMs);
    timer.unref?.();
    try {
      const res = await this.transport.post(url, body, controller.signal);
      if (!res.ok || res.status < 200 || res.status >= 300) {
        // The URL carries the token and the body could echo it; redact before
        // any detail reaches a thrown error (and thus a log).
        const detail = redact(res.bodyText, this.botToken).slice(0, 300);
        throw new Error(`Telegram sendMessage failed: HTTP ${res.status}: ${detail}`);
      }
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      const safe = redact(raw, this.botToken).slice(0, 500);
      if (controller.signal.aborted) {
        throw new Error(`Telegram sendMessage timed out after ${this.timeoutMs}ms`);
      }
      throw new Error(`Telegram sendMessage transport failed: ${safe}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Compose the Telegram message text from title + body + deep link. If the
 * whole would exceed 4096 chars, the body is truncated (title and link are
 * always preserved) so the operator can still reach the session.
 */
function composeTelegramText(notification: Notification): string {
  const title = notification.title ?? '';
  const link = notification.deepLink ?? '';
  const sep = '\n\n';

  const overhead =
    (title ? title.length + sep.length : 0) + (link ? link.length + sep.length : 0);
  const available = TELEGRAM_TEXT_MAX - overhead;
  let body = notification.body ?? '';
  if (body.length > available) {
    const room = Math.max(0, available - TEXT_ELLIPSIS.length);
    body = `${body.slice(0, room)}${TEXT_ELLIPSIS}`;
  }

  return [title, body, link].filter((p) => p.length > 0).join(sep);
}

/** Strip the token (if present) from a string before it can reach a log/error. */
function redact(text: string, token?: string): string {
  if (!token) return text;
  return text.split(token).join(REDACTED);
}
