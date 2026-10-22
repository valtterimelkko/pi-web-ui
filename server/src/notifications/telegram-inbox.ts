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
const REPLY_TO_TEXT_MAX = 500;

const NOT_SAVED_UNSUPPORTED = 'Not saved: only voice notes, audio and text are kept.';
const TOO_LARGE_REPLY = 'Too large to save';

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

/** Seam for the binary download (default: global fetch GET). */
export type DownloadFileFn = (url: string, signal: AbortSignal) => Promise<Buffer>;

export const defaultDownloadFile: DownloadFileFn = async (url, signal) => {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`file download failed: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
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
   * The full message path for one `message` update — the loop's per-update
   * step for messages and the validation/test injection point (never the
   * network in tests: transport and download are injected).
   */
  async handleMessage(message: TelegramMessage): Promise<void> {
    const chatId = message.chat?.id;
    const senderId = message.from?.id;
    const chatMatches = chatId !== undefined && String(chatId) === this.opts.ownerChatId;
    const senderMatches = senderId !== undefined && String(senderId) === this.opts.ownerChatId;
    if (!chatMatches || !senderMatches) {
      // Owner-only, same rule as button taps: ignored silently, no reply.
      // The debug line carries match flags only — never message content.
      logger.debug('ignored telegram message: not from the configured owner', {
        chatMatchesOwner: chatMatches,
        senderMatchesOwner: senderMatches,
      });
      return;
    }

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
      await reply(savedReplyText(classified.kind, classified.kind === 'text' ? undefined : classified.media.duration));
    } catch (error) {
      if (error instanceof FileTooLargeError) {
        await reply(TOO_LARGE_REPLY);
        return;
      }
      logger.errorObject('failed to spool owner message', error, { messageId });
      await reply(`Not saved: ${safeReason(error, this.opts.botToken)}`);
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
    const res = await this.opts.transport.post(
      `${TELEGRAM_API_BASE}/bot${this.opts.botToken}/getFile`,
      JSON.stringify({ file_id: fileId }),
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
    return parsed.result;
  }

  private async downloadFileBytes(url: string): Promise<Buffer> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`file download timed out after ${this.opts.downloadTimeoutMs}ms`)),
      this.opts.downloadTimeoutMs,
    );
    timer.unref?.();
    try {
      return await this.opts.downloadFile(url, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`file download timed out after ${this.opts.downloadTimeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
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

  private async postMessage(endpoint: string, body: Record<string, unknown>): Promise<void> {
    const res = await this.opts.transport.post(
      `${TELEGRAM_API_BASE}/bot${this.opts.botToken}/${endpoint}`,
      JSON.stringify(body),
    );
    if (!res.ok || res.status < 200 || res.status >= 300) {
      throw new Error(`${endpoint} failed: HTTP ${res.status}: ${redactToken(res.bodyText, this.opts.botToken).slice(0, 200)}`);
    }
  }
}
