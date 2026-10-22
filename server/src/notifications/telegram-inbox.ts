/**
 * Telegram Inbox — the owner's messages spooled for another service to read.
 *
 * The actions listener's `getUpdates` also asks for `message` updates. This
 * class accepts a message only when BOTH the chat id and the sender id equal
 * the configured owner chat id (same rule as button taps); anyone else is
 * ignored silently. Accepted kinds: `voice`, `audio`, `video_note`, a
 * `document` whose mime type starts `audio/`, and plain text (commands are
 * refused with a hint). Media is fetched with `getFile`, downloaded from
 * Telegram's file endpoint (20 MB bot cap) and written to the spool dir
 * atomically (tmp + rename, mode 0600) as `<UTC stamp>-<message_id>.<ext>`,
 * followed by a `<same stem>.json` sidecar — written LAST, so a reader can
 * treat a present `.json` as "complete".
 *
 * Spooling never runs inside the poll loop: the listener hands each accepted
 * message to {@link TelegramInbox.enqueue}, which returns at once and works
 * through a single-slot serial queue (at most 20 pending; beyond that the
 * message is answered "Busy, please resend" and dropped — the spool is
 * at-most-once). `stop()` aborts the in-flight download, stops accepting and
 * never waits more than ~2 s. Every Telegram call is bounded by an
 * AbortController timeout (getFile and replies 15 s, download 60 s).
 *
 * Nothing here is interpreted, transcribed or forwarded to any runtime: this
 * is a drop folder, nothing more. The bot token and the full file URL never
 * reach a log or a thrown error the owner does not see redacted.
 */

import { chmod, mkdir, open, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { createLogger } from '../logging/logger.js';
import type { TelegramTransport } from './channels/telegram-channel.js';

const logger = createLogger('TelegramInbox');

const TELEGRAM_API_BASE = 'https://api.telegram.org';
const TELEGRAM_FILE_BASE = 'https://api.telegram.org/file';
/** Telegram's bot-API download cap. */
const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60_000;
/** Timeout for every Telegram API call made here (getFile, replies). */
const TELEGRAM_CALL_TIMEOUT_MS = 15_000;
/** At most this many messages wait in the serial spool queue. */
const MAX_PENDING_MESSAGES = 20;
/** stop() waits at most this long for the in-flight message to settle. */
const INBOX_STOP_SETTLE_MS = 2_000;
const REPLY_TO_TEXT_MAX = 500;

const NOT_SAVED_UNSUPPORTED = 'Not saved: only voice notes, audio and text are kept.';
const TOO_LARGE_REPLY = 'Too large to save';
const BUSY_REPLY = 'Busy, please resend';

/** Defence against a malformed `getFile` result reaching the download URL. */
const FILE_PATH_ALLOWED = /^[\w\-./]+$/;

/** The slice of a Telegram `message` update the inbox path needs. */
export interface TelegramMessageMedia {
  file_id?: string;
  file_size?: number;
  duration?: number;
  mime_type?: string;
  file_name?: string;
}

export interface TelegramMessage {
  message_id?: number;
  date?: number;
  from?: { id?: number | string };
  chat?: { id?: number | string };
  text?: string;
  caption?: string;
  voice?: TelegramMessageMedia;
  audio?: TelegramMessageMedia;
  video_note?: TelegramMessageMedia;
  document?: TelegramMessageMedia;
  reply_to_message?: { message_id?: number; text?: string };
  [key: string]: unknown;
}

export type TelegramInboxKind = 'voice' | 'audio' | 'video_note' | 'document' | 'text';

/**
 * The slice of a download response the inbox consumes: headers are checked
 * before the body is streamed chunk by chunk, so the size cap is enforced
 * before AND during the download (never a full buffer in memory first).
 */
export interface DownloadResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  body: AsyncIterable<Uint8Array>;
}

/** Seam for the binary download (default: global fetch GET). */
export type DownloadFileFn = (url: string, signal: AbortSignal) => Promise<DownloadResponse>;

export const defaultDownloadFile: DownloadFileFn = async (url, signal) => {
  // Response matches DownloadResponse structurally; body is null only for
  // 204/205 responses, which Telegram's file endpoint never returns.
  return (await fetch(url, { signal })) as unknown as DownloadResponse;
};

export interface TelegramInboxOptions {
  botToken: string;
  /** The owner's chat id: a message is accepted only when chat AND sender equal it. */
  ownerChatId: string;
  /** Spool directory; created (and forced) to mode 0700 on first save. */
  inboxDir: string;
  transport: TelegramTransport;
  /** Download size cap (default: Telegram's 20 MB bot limit). */
  maxFileBytes?: number;
  downloadFile?: DownloadFileFn;
  downloadTimeoutMs?: number;
  now?: () => string;
}

/** Sentinel: answered "Too large to save", nothing kept. */
class FileTooLargeError extends Error {
  constructor() {
    super('file exceeds the bot download size cap');
  }
}

type Classified =
  | { kind: 'text'; text: string }
  | { kind: Exclude<TelegramInboxKind, 'text'>; media: TelegramMessageMedia };

function classifyMessage(message: TelegramMessage): Classified | null {
  if (message.voice) return { kind: 'voice', media: message.voice };
  if (message.audio) return { kind: 'audio', media: message.audio };
  if (message.video_note) return { kind: 'video_note', media: message.video_note };
  if (message.document) {
    const mime = message.document.mime_type;
    if (typeof mime === 'string' && mime.startsWith('audio/')) {
      return { kind: 'document', media: message.document };
    }
    return null;
  }
  const text = message.text;
  if (typeof text === 'string' && text.length > 0 && !text.startsWith('/')) {
    return { kind: 'text', text };
  }
  return null;
}

const ALLOWED_EXTS = new Set(['ogg', 'oga', 'mp3', 'm4a', 'mp4', 'wav']);
const EXT_BY_MIME: Record<string, string> = {
  'audio/ogg': 'ogg',
  'audio/oga': 'oga',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/m4a': 'm4a',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'video/mp4': 'mp4',
};

/** Extension from the file path when allowlisted, else from the mime type, else `bin`. */
function resolveExt(filePath: string | undefined, mimeType: string | undefined): string {
  const base = filePath ? path.basename(filePath) : '';
  const dot = base.lastIndexOf('.');
  const fromPath = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  if (ALLOWED_EXTS.has(fromPath)) return fromPath;
  const mime = mimeType?.toLowerCase();
  if (mime && EXT_BY_MIME[mime]) return EXT_BY_MIME[mime];
  return 'bin';
}

function stampFromIso(iso: string): string {
  return iso.replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
}

function formatDuration(totalSec: number): string {
  const sec = Math.max(0, Math.floor(totalSec));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

function savedReplyText(kind: TelegramInboxKind, duration?: number): string {
  switch (kind) {
    case 'voice':
      return duration === undefined ? 'Saved voice note.' : `Saved voice note (${formatDuration(duration)}).`;
    case 'audio':
      return 'Saved audio.';
    case 'video_note':
      return 'Saved video note.';
    case 'document':
      return 'Saved audio file.';
    case 'text':
      return 'Saved text.';
  }
}

/** Error text safe to surface: the bot token is redacted, length capped. */
function safeReason(error: unknown, botToken: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  const redacted = botToken ? raw.split(botToken).join('<redacted>') : raw;
  return redacted.slice(0, 120);
}

function redactToken(text: string, botToken: string): string {
  return botToken ? text.split(botToken).join('<redacted>') : text;
}

/** Defence in depth: the generated name must stay inside the spool dir. */
function assertInsideDir(dir: string, target: string): void {
  const resolvedDir = path.resolve(dir) + path.sep;
  if (!path.resolve(target).startsWith(resolvedDir)) {
    throw new Error('resolved path escaped the spool dir');
  }
}

export class TelegramInbox {
  private readonly opts: TelegramInboxOptions & {
    maxFileBytes: number;
    downloadFile: DownloadFileFn;
    downloadTimeoutMs: number;
    now: () => string;
  };

  /** Serial spool queue: the poll loop never awaits the media work. */
  private queue: TelegramMessage[] = [];
  private draining = false;
  private inFlight: Promise<void> | null = null;
  private stopped = false;
  /** Aborted by stop(): every download links to it, whenever it started. */
  private readonly stopController = new AbortController();

  constructor(options: TelegramInboxOptions) {
    this.opts = {
      ...options,
      maxFileBytes: options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
      downloadFile: options.downloadFile ?? defaultDownloadFile,
      downloadTimeoutMs: options.downloadTimeoutMs ?? DOWNLOAD_TIMEOUT_MS,
      now: options.now ?? (() => new Date().toISOString()),
    };
  }

  /**
   * Queue one `message` update for spooling and return at once — the poll
   * loop's entry point, so button taps are never delayed by a download.
   * Owner gating happens synchronously; the work itself runs on a serial
   * queue (at most 20 pending: further messages are answered once
   * "Busy, please resend" and dropped — at-most-once spool).
   */
  enqueue(message: TelegramMessage): 'accepted' | 'ignored' | 'busy' {
    if (this.stopped) return 'ignored'; // shutdown: stop accepting, no reply
    if (!this.fromOwner(message)) return 'ignored';
    if (this.queue.length >= MAX_PENDING_MESSAGES) {
      const messageId = message.message_id;
      void this.postMessage('sendMessage', {
        chat_id: message.chat?.id,
        text: BUSY_REPLY,
        ...(Number.isInteger(messageId) ? { reply_to_message_id: messageId } : {}),
      }).catch((error: unknown) => {
        logger.errorObject('failed to send the busy reply', new Error(safeReason(error, this.opts.botToken)), { messageId });
      });
      return 'busy';
    }
    this.queue.push(message);
    void this.drain();
    return 'accepted';
  }

  /**
   * Stop accepting messages, abort the in-flight download and drop queued
   * messages; waits for the in-flight message to settle, but never longer
   * than ~2 s (a hung API call must not hold up shutdown).
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.queue.length = 0;
    // Downloads link to this signal (even ones that start later, mid-getFile
    // when stop() fired), so the in-flight download is always aborted.
    this.stopController.abort(new Error('download aborted: listener stopping'));
    const inFlight = this.inFlight;
    if (!inFlight) return;
    await Promise.race([
      inFlight.catch(() => { /* the drain logs it redacted; stopping never throws */ }),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, INBOX_STOP_SETTLE_MS);
        timer.unref?.();
      }),
    ]);
  }

  /** Owner-only gate: BOTH the chat id and the sender id must be the owner's. */
  private fromOwner(message: TelegramMessage): boolean {
    const chatMatches = message.chat?.id !== undefined && String(message.chat.id) === this.opts.ownerChatId;
    const senderMatches = message.from?.id !== undefined && String(message.from.id) === this.opts.ownerChatId;
    if (chatMatches && senderMatches) return true;
    // Ignored silently, no reply. The debug line carries match flags only —
    // never message content.
    logger.debug('ignored telegram message: not from the configured owner', {
      chatMatchesOwner: chatMatches,
      senderMatchesOwner: senderMatches,
    });
    return false;
  }

  /** Work through the queue one message at a time; never dies with one. */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (!this.stopped && this.queue.length > 0) {
        const message = this.queue.shift() as TelegramMessage;
        const task = this.handleMessage(message);
        this.inFlight = task;
        try {
          await task;
        } catch (error) {
          // One bad message never kills the queue; logged redacted.
          logger.errorObject(
            'failed to process owner message',
            new Error(safeReason(error, this.opts.botToken)),
            { messageId: message.message_id },
          );
        } finally {
          this.inFlight = null;
        }
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * The full message path for one accepted `message` update — the queue's
   * worker step and the validation/test injection point (never the network
   * in tests: transport and download are injected).
   */
  async handleMessage(message: TelegramMessage): Promise<void> {
    if (!this.fromOwner(message)) return;
    const chatId = message.chat?.id as number | string;
    const messageId = message.message_id;
    const reply = async (text: string): Promise<void> => {
      await this.postMessage('sendMessage', {
        chat_id: chatId,
        text,
        ...(Number.isInteger(messageId) ? { reply_to_message_id: messageId } : {}),
      });
    };

    if (typeof messageId !== 'number' || !Number.isInteger(messageId) || messageId <= 0) {
      await reply('Not saved: invalid message');
      return;
    }

    const classified = classifyMessage(message);
    try {
      if (!classified) {
        await reply(NOT_SAVED_UNSUPPORTED);
        return;
      }
      if (classified.kind === 'text') {
        await this.spoolText(message, messageId, classified.text);
      } else {
        await this.spoolMedia(message, messageId, classified);
      }
    } catch (error) {
      if (error instanceof FileTooLargeError) {
        await reply(TOO_LARGE_REPLY);
        return;
      }
      logger.errorObject(
        'failed to spool owner message',
        new Error(safeReason(error, this.opts.botToken)),
        { messageId },
      );
      await reply(`Not saved: ${safeReason(error, this.opts.botToken)}`);
      return;
    }
    // The save succeeded: the confirmation is a separate best-effort try. A
    // failed reply must never turn a successful save into a "Not saved" (the
    // files stay; the owner sees no "Saved" line and can resend).
    try {
      await reply(savedReplyText(classified.kind, classified.kind === 'text' ? undefined : classified.media.duration));
    } catch (error) {
      logger.errorObject(
        'failed to send the save confirmation',
        new Error(safeReason(error, this.opts.botToken)),
        { messageId },
      );
    }
  }

  private async spoolText(
    message: TelegramMessage,
    messageId: number,
    text: string,
  ): Promise<void> {
    await this.ensureDir();
    const stem = `${stampFromIso(this.messageDateIso(message))}-${messageId}`;
    const sidecarPath = path.join(this.opts.inboxDir, `${stem}.json`);
    assertInsideDir(this.opts.inboxDir, sidecarPath);
    await this.writeAtomic(sidecarPath, JSON.stringify(this.sidecarRecord(message, 'text', { text })));
  }

  private async spoolMedia(
    message: TelegramMessage,
    messageId: number,
    classified: { kind: Exclude<TelegramInboxKind, 'text'>; media: TelegramMessageMedia },
  ): Promise<void> {
    const { kind, media } = classified;
    const cap = this.opts.maxFileBytes;
    if (typeof media.file_size === 'number' && media.file_size > cap) throw new FileTooLargeError();

    await this.ensureDir();
    if (!media.file_id) throw new Error('message media carries no file id');

    const file = await this.getFileFilePath(media.file_id);
    if (typeof file.file_size === 'number' && file.file_size > cap) throw new FileTooLargeError();

    const bytes = await this.downloadFileBytes(`${TELEGRAM_FILE_BASE}/bot${this.opts.botToken}/${file.file_path}`);
    if (bytes.length > cap) throw new FileTooLargeError();

    const stem = `${stampFromIso(this.messageDateIso(message))}-${messageId}`;
    const mediaName = `${stem}.${resolveExt(file.file_path, media.mime_type)}`;
    const mediaPath = path.join(this.opts.inboxDir, mediaName);
    assertInsideDir(this.opts.inboxDir, mediaPath);
    await this.writeAtomic(mediaPath, bytes);
    try {
      const sidecarPath = path.join(this.opts.inboxDir, `${stem}.json`);
      assertInsideDir(this.opts.inboxDir, sidecarPath);
      // Written LAST: a present .json is the reader's "complete" marker.
      await this.writeAtomic(sidecarPath, JSON.stringify(this.sidecarRecord(message, kind, { media, mediaName })));
    } catch (error) {
      // No partial pairs: the media file alone is never left behind.
      await unlink(mediaPath).catch(() => { /* best effort */ });
      throw error;
    }
  }

  private async getFileFilePath(fileId: string): Promise<{ file_path?: string; file_size?: number }> {
    const res = await this.postWithTimeout(
      'getFile',
      { file_id: fileId },
    );
    if (!res.ok || res.status < 200 || res.status >= 300) {
      throw new Error(`getFile failed: HTTP ${res.status}: ${redactToken(res.bodyText, this.opts.botToken).slice(0, 200)}`);
    }
    let parsed: { ok?: boolean; result?: { file_path?: string; file_size?: number } };
    try {
      parsed = JSON.parse(res.bodyText) as typeof parsed;
    } catch {
      throw new Error('getFile returned an unparseable response');
    }
    if (!parsed.ok || typeof parsed.result?.file_path !== 'string' || parsed.result.file_path.length === 0) {
      throw new Error('getFile returned no file path');
    }
    // The path comes from Telegram, but it goes into a request URL: accept a
    // conservative shape only (word chars, dash, dot, slash; no traversal).
    if (!FILE_PATH_ALLOWED.test(parsed.result.file_path) || parsed.result.file_path.includes('..')) {
      throw new Error('getFile returned an unexpected file path');
    }
    return parsed.result;
  }

  private async downloadFileBytes(url: string): Promise<Buffer> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`file download timed out after ${this.opts.downloadTimeoutMs}ms`)),
      this.opts.downloadTimeoutMs,
    );
    timer.unref?.();
    // stop() must abort the download no matter when it started relative to
    // the stop call.
    const onStop = () => controller.abort(this.stopController.signal.reason);
    if (this.stopController.signal.aborted) onStop();
    else this.stopController.signal.addEventListener('abort', onStop, { once: true });
    try {
      const res = await this.opts.downloadFile(url, controller.signal);
      if (!res.ok) throw new Error(`file download failed: HTTP ${res.status}`);
      // Cap check one: the declared size, before a single byte is read.
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > this.opts.maxFileBytes) throw new FileTooLargeError();
      // Cap check two: stream the body, counting bytes, aborting past the cap.
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of res.body) {
        total += chunk.byteLength;
        if (total > this.opts.maxFileBytes) {
          controller.abort(new Error('file exceeds the bot download size cap'));
          throw new FileTooLargeError();
        }
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    } catch (error) {
      // Translate an abort into its reason (timeout, stop), except the cap
      // abort, whose FileTooLargeError already says what happened.
      if (!(error instanceof FileTooLargeError) && controller.signal.aborted) {
        const reason = controller.signal.reason;
        throw reason instanceof Error ? reason : new Error(String(reason));
      }
      throw error;
    } finally {
      clearTimeout(timer);
      this.stopController.signal.removeEventListener('abort', onStop);
    }
  }

  /** Shared sidecar shape (field order is the documented contract). */
  private sidecarRecord(
    message: TelegramMessage,
    kind: TelegramInboxKind,
    extra: { text?: string; media?: TelegramMessageMedia; mediaName?: string },
  ): Record<string, unknown> {
    const record: Record<string, unknown> = {
      messageId: message.message_id,
      date: this.messageDateIso(message),
      kind,
    };
    if (extra.media?.duration !== undefined) record.durationSec = extra.media.duration;
    if (extra.media?.mime_type) record.mimeType = extra.media.mime_type;
    if (extra.mediaName) record.fileName = extra.mediaName;
    if (message.caption) record.caption = message.caption;
    if (extra.text !== undefined) record.text = extra.text;
    const replyTo = message.reply_to_message;
    if (replyTo && Number.isInteger(replyTo.message_id)) {
      record.replyTo = {
        messageId: replyTo.message_id,
        ...(typeof replyTo.text === 'string' ? { text: replyTo.text.slice(0, REPLY_TO_TEXT_MAX) } : {}),
      };
    }
    return record;
  }

  private messageDateIso(message: TelegramMessage): string {
    return typeof message.date === 'number' && Number.isFinite(message.date)
      ? new Date(message.date * 1000).toISOString()
      : this.opts.now();
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.opts.inboxDir, { recursive: true, mode: 0o700 });
    // In case the directory pre-existed with a looser mode.
    await chmod(this.opts.inboxDir, 0o700);
  }

  private async writeAtomic(target: string, content: Buffer | string): Promise<void> {
    const tmpPath = path.join(this.opts.inboxDir, `${path.basename(target)}.tmp-${randomBytes(6).toString('hex')}`);
    assertInsideDir(this.opts.inboxDir, tmpPath);
    const handle = await open(tmpPath, 'w', 0o600);
    try {
      await handle.writeFile(content);
    } catch (error) {
      // No orphan tmp on a failed write (disk full, EIO): remove and rethrow.
      await unlink(tmpPath).catch(() => { /* best effort */ });
      throw error;
    } finally {
      await handle.close();
    }
    try {
      await rename(tmpPath, target);
    } catch (error) {
      await unlink(tmpPath).catch(() => { /* best effort */ });
      throw error;
    }
  }

  /** Every API call here is bounded: the transport gets an abort signal. */
  private async postWithTimeout(endpoint: string, body: Record<string, unknown>): Promise<{ status: number; ok: boolean; bodyText: string }> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`${endpoint} timed out after ${TELEGRAM_CALL_TIMEOUT_MS}ms`)),
      TELEGRAM_CALL_TIMEOUT_MS,
    );
    timer.unref?.();
    try {
      return await this.opts.transport.post(
        `${TELEGRAM_API_BASE}/bot${this.opts.botToken}/${endpoint}`,
        JSON.stringify(body),
        controller.signal,
      );
    } catch (error) {
      if (controller.signal.aborted) {
        const reason = controller.signal.reason;
        throw reason instanceof Error ? reason : new Error(String(reason));
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async postMessage(endpoint: string, body: Record<string, unknown>): Promise<void> {
    const res = await this.postWithTimeout(endpoint, body);
    if (!res.ok || res.status < 200 || res.status >= 300) {
      throw new Error(`${endpoint} failed: HTTP ${res.status}: ${redactToken(res.bodyText, this.opts.botToken).slice(0, 200)}`);
    }
  }
}
