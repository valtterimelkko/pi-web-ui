/**
 * Telegram Actions Listener (contract CHANNEL.md §7).
 *
 * ONE listener long-polls the bot's `getUpdates` (timeout ~30s,
 * `allowed_updates: ["callback_query", "message"]`), persisting its offset
 * under the server's data directory so a restart never replays processed
 * updates. It accepts a callback query only when BOTH the chat id and the
 * sender id equal the configured owner chat id — anyone else is answered
 * "Not allowed" and ignored. Owner `message` updates (voice notes, audio,
 * video notes, audio documents, text) are spooled for another service by
 * {@link TelegramInbox}; nothing is interpreted or forwarded to a runtime. The first tap on a notification runs its registered handler ONCE
 * (execFile, no shell) and records the outcome on the notification; later taps
 * are answered "Already decided". Every callback query is answered, then the
 * message is edited to the original text, a blank line, the result line — and
 * no buttons. Owner `message` updates (voice notes, audio, video notes, audio
 * documents, text) are handed to {@link TelegramInbox}'s bounded background
 * queue — callback queries in a batch are always handled first — so a
 * spooling download never delays a tap; nothing is interpreted or forwarded
 * to a runtime.
 *
 * In validation mode the listener is constructed but `start()` is refused: the
 * capture channel records the outgoing buttons and tests drive the tap path
 * directly through {@link handleCallbackQuery} (never the network).
 */

import { mkdir, open, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '../logging/logger.js';
import { NotificationStore } from './notification-store.js';
import {
  runNotificationActionHandler,
  type ActionHandlerRegistry,
  type ExecFileFn,
} from './action-handlers.js';
import { parseCallbackData } from './channels/telegram-callback-data.js';
import { defaultTelegramTransport, type TelegramTransport } from './channels/telegram-channel.js';
import { TelegramInbox, type DownloadFileFn, type TelegramMessage } from './telegram-inbox.js';

const logger = createLogger('TelegramActionsListener');

const DEFAULT_POLL_TIMEOUT_SEC = 30;
/** Grace over the long-poll's server-side wait so healthy polls are never aborted. */
const POLL_ABORT_GRACE_MS = 5_000;
const DEFAULT_BACKOFF_INITIAL_MS = 1_000;
const DEFAULT_BACKOFF_MAX_MS = 60_000;

/** The slice of a Telegram `callback_query` the tap path needs. */
export interface TelegramCallbackQuery {
  id: string;
  from?: { id?: number | string };
  message?: {
    message_id?: number;
    chat?: { id?: number | string };
    text?: string;
  };
  data?: string;
}

interface TelegramUpdate {
  update_id: number;
  callback_query?: TelegramCallbackQuery;
  message?: TelegramMessage;
}

export interface TelegramActionsListenerOptions {
  botToken: string;
  /** The owner's chat id: a callback is accepted only when chat AND sender equal it. */
  ownerChatId: string;
  store: NotificationStore;
  handlers: ActionHandlerRegistry;
  /** Offset file under the server's data directory (survives restarts). */
  offsetPath: string;
  /** Spool dir for owner messages (default: `<offset dir>/telegram-inbox`). */
  inboxDir?: string;
  /** Download seam passed to the inbox (tests inject; default: global fetch). */
  downloadFile?: DownloadFileFn;
  /** Injectable transport; defaults to the real Telegram HTTPS transport. */
  transport?: TelegramTransport;
  /** Long-poll server wait, seconds. */
  pollTimeoutSec?: number;
  execFile?: ExecFileFn;
  handlerTimeoutMs?: number;
  now?: () => string;
  /** Validation mode refuses to start the network loop; only the test injection works. */
  validationMode?: boolean;
  /** Test seams: loop pacing and error backoff (production defaults below). */
  loopIdleMs?: number;
  backoffInitialMs?: number;
  backoffMaxMs?: number;
}

const TELEGRAM_API_BASE = 'https://api.telegram.org';

export class TelegramActionsListener {
  private readonly opts: TelegramActionsListenerOptions & {
    transport: TelegramTransport;
    pollTimeoutSec: number;
    now: () => string;
    loopIdleMs: number;
    backoffInitialMs: number;
    backoffMaxMs: number;
  };
  private readonly inbox: TelegramInbox;
  private offset: number | undefined;
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private pollAbort: AbortController | null = null;
  private resolveStopped: (() => void) | null = null;

  constructor(options: TelegramActionsListenerOptions) {
    this.opts = {
      ...options,
      transport: options.transport ?? defaultTelegramTransport,
      pollTimeoutSec: options.pollTimeoutSec ?? DEFAULT_POLL_TIMEOUT_SEC,
      now: options.now ?? (() => new Date().toISOString()),
      loopIdleMs: options.loopIdleMs ?? 1_000,
      backoffInitialMs: options.backoffInitialMs ?? DEFAULT_BACKOFF_INITIAL_MS,
      backoffMaxMs: options.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS,
    };
    this.inbox = new TelegramInbox({
      botToken: options.botToken,
      ownerChatId: options.ownerChatId,
      inboxDir: options.inboxDir ?? path.join(path.dirname(options.offsetPath), 'telegram-inbox'),
      transport: this.opts.transport,
      ...(options.downloadFile ? { downloadFile: options.downloadFile } : {}),
      now: this.opts.now,
    });
  }

  /** Idempotent. Refused in validation mode (no network there, ever). */
  start(): void {
    if (this.running) return;
    if (this.opts.validationMode) {
      logger.warn('Telegram actions listener not started: validation mode (taps are injected by tests only)');
      return;
    }
    this.running = true;
    this.loopPromise = this.loop()
      // The loop must never die silently or reject unhandled: a crashed
      // listener would otherwise answer nothing and stall every tap.
      .catch((error) => logger.errorObject('telegram actions listener loop crashed', error))
      .finally(() => {
        this.loopPromise = null;
        this.resolveStopped?.();
        this.resolveStopped = null;
      });
  }

  /** Stop the loop, abort any in-flight long poll and abort the inbox's in-flight download. Resolves when stopped. */
  async stop(): Promise<void> {
    if (!this.running) {
      await this.inbox.stop();
      return;
    }
    this.running = false;
    this.pollAbort?.abort(new Error('listener stopped'));
    // Bounded (~2 s): aborts the spool queue's in-flight download.
    await this.inbox.stop();
    if (this.loopPromise) {
      await new Promise<void>((resolve) => {
        this.resolveStopped = resolve;
      });
    }
  }

  /**
   * The full tap path for one callback query — the loop's per-update step and
   * the validation/test injection point. Answers every callback query; runs
   * the handler at most once per notification (first tap wins).
   */
  async handleCallbackQuery(query: TelegramCallbackQuery): Promise<void> {
    const answer = async (text: string): Promise<void> => {
      await this.postJson('answerCallbackQuery', { callback_query_id: query.id, text });
    };

    // Owner-only: BOTH the chat and the sender must be the configured owner.
    const chatId = query.message?.chat?.id;
    const senderId = query.from?.id;
    if (String(chatId) !== String(this.opts.ownerChatId) || String(senderId) !== String(this.opts.ownerChatId)) {
      await answer('Not allowed');
      return;
    }

    const parsed = query.data ? parseCallbackData(query.data) : null;
    if (!parsed) {
      await answer('Unknown notification');
      return;
    }

    const queued = this.opts.store.getById(parsed.notificationId);
    const notification = queued?.notification;
    if (!queued || !notification) {
      await answer('Unknown notification');
      return;
    }
    if (!notification.actions?.some((a) => a.id === parsed.actionId)) {
      await answer('Unknown action');
      return;
    }
    if (queued.actionTaken) {
      await answer('Already decided');
      return;
    }

    const handlerName = notification.actionHandler ?? '';
    const definition = this.opts.handlers.get(handlerName);
    if (!definition) {
      // The handler was registered at acceptance time but vanished from the
      // server configuration: record and surface the refusal, run nothing.
      const result = `Could not apply: unknown action handler "${handlerName}"`;
      await this.recordAndReflect(query, notification.id, parsed.actionId, result, answer);
      return;
    }

    const outcome = await runNotificationActionHandler(definition, notification.actionRef ?? '', parsed.actionId, {
      execFile: this.opts.execFile,
      timeoutMs: this.opts.handlerTimeoutMs,
    });
    await this.recordAndReflect(query, notification.id, parsed.actionId, outcome.message, answer);
  }

  private async recordAndReflect(
    query: TelegramCallbackQuery,
    notificationId: string,
    actionId: string,
    result: string,
    answer: (text: string) => Promise<void>,
  ): Promise<void> {
    const at = this.opts.now();
    try {
      const recorded = await this.opts.store.recordAction(notificationId, { action: actionId, at, result });
      if (!recorded) {
        // Lost the first-tap race (e.g. a redelivered update after a crash):
        // the earlier decision stands.
        await answer('Already decided');
        return;
      }
    } catch (error) {
      logger.errorObject('failed to persist notification action record', error, { notificationId });
    }
    await answer(result);
    await this.editMessage(query, notificationId, result);
  }

  private async editMessage(query: TelegramCallbackQuery, notificationId: string, result: string): Promise<void> {
    const chatId = query.message?.chat?.id;
    const messageId = query.message?.message_id;
    if (chatId === undefined || messageId === undefined) {
      logger.warn('cannot edit notification message: callback query carries no message reference', { notificationId });
      return;
    }
    const queued = this.opts.store.getById(notificationId);
    const original = query.message?.text
      ?? [queued?.notification.title, queued?.notification.body].filter(Boolean).join('\n\n');
    try {
      // reply_markup omitted: the edit removes the buttons.
      await this.postJson('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: `${original}\n\n${result}`,
        disable_web_page_preview: true,
      });
    } catch (error) {
      logger.errorObject('failed to edit notification message after action', error, { notificationId });
    }
  }

  private async loop(): Promise<void> {
    await this.loadPersistedOffset();
    let backoffMs = this.opts.backoffInitialMs;
    while (this.running) {
      let received = 0;
      try {
        const updates = await this.getUpdates();
        backoffMs = this.opts.backoffInitialMs;
        // Taps first: a button answer must never wait behind a spooling
        // download. Message work is handed to the inbox's queue and never
        // awaited here.
        const ordered = [
          ...updates.filter((u) => u.callback_query),
          ...updates.filter((u) => !u.callback_query),
        ];
        let settled = this.offset ?? 0;
        for (const update of ordered) {
          received += 1;
          try {
            if (update.callback_query) await this.handleCallbackQuery(update.callback_query);
            else if (update.message) this.inbox.enqueue(update.message);
          } catch (error) {
            // One bad update never stops the loop; the offset still advances.
            // Logged redacted: the token sits in every request URL.
            logger.errorObject(
              'telegram update handling failed',
              new Error(safeErrorText(error, this.opts.botToken)),
              { updateId: update.update_id },
            );
          }
          // Updates are processed out of id order, so the offset must only
          // ever move forward.
          settled = Math.max(settled, update.update_id + 1);
          this.offset = settled;
          await this.persistOffset();
        }
      } catch (error) {
        if (!this.running) break; // aborted by stop()
        logger.warn(`getUpdates failed; backing off ${backoffMs}ms: ${safeErrorText(error, this.opts.botToken)}`);
        await sleep(backoffMs);
        backoffMs = Math.min(this.opts.backoffMaxMs, backoffMs * 2);
        continue;
      }
      if (this.running && received === 0) await sleep(this.opts.loopIdleMs);
    }
  }

  private async getUpdates(): Promise<TelegramUpdate[]> {
    const controller = new AbortController();
    this.pollAbort = controller;
    const timer = setTimeout(
      () => controller.abort(new Error('getUpdates long poll exceeded its budget')),
      this.opts.pollTimeoutSec * 1000 + POLL_ABORT_GRACE_MS,
    );
    timer.unref?.();
    try {
      const res = await this.opts.transport.post(
        `${TELEGRAM_API_BASE}/bot${this.opts.botToken}/getUpdates`,
        JSON.stringify({
          ...(this.offset !== undefined ? { offset: this.offset } : {}),
          timeout: this.opts.pollTimeoutSec,
          allowed_updates: ['callback_query', 'message'],
        }),
        controller.signal,
      );
      if (!res.ok || res.status < 200 || res.status >= 300) {
        throw new Error(`getUpdates failed: HTTP ${res.status}: ${res.bodyText.slice(0, 200)}`);
      }
      const parsed = JSON.parse(res.bodyText) as { ok?: boolean; result?: TelegramUpdate[] };
      if (!parsed.ok || !Array.isArray(parsed.result)) {
        throw new Error('getUpdates returned an unparseable response');
      }
      return parsed.result;
    } finally {
      clearTimeout(timer);
      this.pollAbort = null;
    }
  }

  private async postJson(endpoint: string, body: Record<string, unknown>): Promise<void> {
    const res = await this.opts.transport.post(
      `${TELEGRAM_API_BASE}/bot${this.opts.botToken}/${endpoint}`,
      JSON.stringify(body),
    );
    if (!res.ok || res.status < 200 || res.status >= 300) {
      throw new Error(`${endpoint} failed: HTTP ${res.status}: ${res.bodyText.slice(0, 200)}`);
    }
  }

  private async persistOffset(): Promise<void> {
    if (this.offset === undefined) return;
    try {
      await mkdir(path.dirname(this.opts.offsetPath), { recursive: true, mode: 0o700 });
      const tmp = `${this.opts.offsetPath}.tmp`;
      const handle = await open(tmp, 'w', 0o600);
      try {
        await handle.writeFile(JSON.stringify({ offset: this.offset }), 'utf8');
      } finally {
        await handle.close();
      }
      await rename(tmp, this.opts.offsetPath);
    } catch (error) {
      logger.errorObject('failed to persist getUpdates offset', error);
    }
  }

  /** Read the offset file (if any) before the first poll, so a restart never replays taps. */
  private async loadPersistedOffset(): Promise<void> {
    try {
      const raw = await readFile(this.opts.offsetPath, 'utf8');
      const parsed = JSON.parse(raw) as { offset?: number };
      if (typeof parsed.offset === 'number') this.offset = parsed.offset;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        logger.warn(`failed to read getUpdates offset; starting from scratch: ${(error as Error).message}`);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Error text safe to log: the bot token (which sits in every request URL) is redacted, length capped. */
export function safeErrorText(error: unknown, botToken: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  const redacted = botToken ? raw.split(botToken).join('<redacted>') : raw;
  return redacted.slice(0, 300);
}
