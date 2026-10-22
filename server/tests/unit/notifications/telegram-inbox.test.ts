import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {
  TelegramInbox,
  type DownloadFileFn,
  type TelegramMessage,
} from '../../../src/notifications/telegram-inbox.js';
import type { TelegramTransport } from '../../../src/notifications/channels/telegram-channel.js';

const OWNER_CHAT = '987654321';
const DATE_SEC = Math.floor(Date.parse('2026-06-29T00:00:10.000Z') / 1000);
const STEM = '20260629T000010Z-55';

interface TransportCall { endpoint: string; body: Record<string, unknown> }

interface ScriptedGetFile { result?: unknown; httpStatus?: number }

function fakeTransport(getFile?: (body: Record<string, unknown>) => ScriptedGetFile): {
  transport: TelegramTransport;
  calls: TransportCall[];
} {
  const calls: TransportCall[] = [];
  const transport: TelegramTransport = {
    async post(url, body) {
      const endpoint = url.split('/').pop() ?? '';
      const parsed = JSON.parse(body) as Record<string, unknown>;
      calls.push({ endpoint, body: parsed });
      if (endpoint === 'getFile' && getFile) {
        const scripted = getFile(parsed);
        const status = scripted.httpStatus ?? 200;
        return {
          status,
          ok: status >= 200 && status < 300,
          bodyText: JSON.stringify(scripted.httpStatus
            ? { ok: false }
            : { ok: true, result: scripted.result }),
        };
      }
      return { status: 200, ok: true, bodyText: '{"ok":true}' };
    },
  };
  return { transport, calls };
}

function fakeDownload(outcome: Buffer | Error): DownloadFileFn & { calls: string[] } {
  const calls: string[] = [];
  const fn: DownloadFileFn = async (url) => {
    calls.push(url);
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
  return Object.assign(fn, { calls });
}

function ownerMessage(over: Partial<TelegramMessage> = {}): TelegramMessage {
  return {
    message_id: 55,
    date: DATE_SEC,
    from: { id: Number(OWNER_CHAT) },
    chat: { id: Number(OWNER_CHAT) },
    voice: { file_id: 'fv1', duration: 83, mime_type: 'audio/ogg' },
    ...over,
  };
}

const VOICE_FILE = {
  file_id: 'fv1', file_size: 1200, duration: 83, mime_type: 'audio/ogg', file_path: 'voice/file_55.oga',
};

async function isInboxEmpty(): Promise<boolean> {
  try {
    return (await fs.readdir(inboxDir)).length === 0;
  } catch {
    return true; // not created yet counts as empty
  }
}

describe('TelegramInbox (owner voice notes into the spool)', () => {
  let root: string;
  let inboxDir: string;

  function makeInbox(transport: TelegramTransport, download: DownloadFileFn, over: Record<string, unknown> = {}) {
    return new TelegramInbox({
      botToken: 'FAKE:TOKEN',
      ownerChatId: OWNER_CHAT,
      inboxDir,
      transport,
      downloadFile: download,
      now: () => '2026-06-29T00:00:10.000Z',
      ...over,
    });
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-tg-inbox-'));
    inboxDir = path.join(root, 'telegram-inbox');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  it('accepts an owner voice note: getFile, download, spools media + sidecar (0600), replies with duration', async () => {
    const { transport, calls } = fakeTransport(() => ({ result: VOICE_FILE }));
    const download = fakeDownload(Buffer.from('ogg-bytes'));
    const inbox = makeInbox(transport, download);

    await inbox.handleMessage(ownerMessage());

    // getFile carried the file_id from the message.
    expect(calls.find((c) => c.endpoint === 'getFile')?.body).toEqual({ file_id: 'fv1' });
    // Download went to Telegram's file endpoint (URL asserted without the token).
    expect(download.calls).toHaveLength(1);
    expect(download.calls[0].startsWith('https://api.telegram.org/file/bot')).toBe(true);
    expect(download.calls[0].endsWith('/voice/file_55.oga')).toBe(true);

    // Exactly two files: media + sidecar, no tmp leftovers.
    expect((await fs.readdir(inboxDir)).sort()).toEqual([`${STEM}.json`, `${STEM}.oga`]);
    const media = await fs.readFile(path.join(inboxDir, `${STEM}.oga`));
    expect(media.equals(Buffer.from('ogg-bytes'))).toBe(true);
    expect(((await fs.stat(path.join(inboxDir, `${STEM}.oga`))).mode & 0o777)).toBe(0o600);
    expect(((await fs.stat(path.join(inboxDir, `${STEM}.json`))).mode & 0o777)).toBe(0o600);

    // Sidecar shape (media name is the saved file's basename).
    const sidecar = JSON.parse(await fs.readFile(path.join(inboxDir, `${STEM}.json`), 'utf8')) as Record<string, unknown>;
    expect(sidecar).toEqual({
      messageId: 55,
      date: '2026-06-29T00:00:10.000Z',
      kind: 'voice',
      durationSec: 83,
      mimeType: 'audio/ogg',
      fileName: `${STEM}.oga`,
    });

    // Reply is short, no emoji, replies to the message.
    const reply = calls.find((c) => c.endpoint === 'sendMessage');
    expect(reply?.body).toEqual({
      chat_id: Number(OWNER_CHAT),
      text: 'Saved voice note (1:23).',
      reply_to_message_id: 55,
    });
  });

  it('pads the duration seconds under a minute figure (1:05)', async () => {
    const { transport, calls } = fakeTransport(() => ({ result: VOICE_FILE }));
    const inbox = makeInbox(transport, fakeDownload(Buffer.from('x')));
    await inbox.handleMessage(ownerMessage({ voice: { file_id: 'fv1', duration: 65, mime_type: 'audio/ogg' } }));
    expect(calls.find((c) => c.endpoint === 'sendMessage')?.body.text).toBe('Saved voice note (1:05).');
  });

  it('saves audio, video notes and audio documents with kind-appropriate replies', async () => {
    const cases: Array<{ message: TelegramMessage; file: Record<string, unknown>; kind: string; reply: string }> = [
      {
        message: ownerMessage({ voice: undefined, audio: { file_id: 'fa1', duration: 200, mime_type: 'audio/mpeg' } }),
        file: { file_id: 'fa1', file_size: 5, mime_type: 'audio/mpeg', file_path: 'music/file_55.mp3' },
        kind: 'audio',
        reply: 'Saved audio.',
      },
      {
        message: ownerMessage({ voice: undefined, video_note: { file_id: 'fvn1', duration: 30, mime_type: 'video/mp4' } }),
        file: { file_id: 'fvn1', file_size: 5, mime_type: 'video/mp4', file_path: 'video_notes/file_55.mp4' },
        kind: 'video_note',
        reply: 'Saved video note.',
      },
      {
        message: ownerMessage({
          voice: undefined,
          document: { file_id: 'fd1', mime_type: 'audio/mpeg', file_name: 'song.mp3' },
        }),
        file: { file_id: 'fd1', file_size: 5, mime_type: 'audio/mpeg', file_path: 'documents/file_55.mp3' },
        kind: 'document',
        reply: 'Saved audio file.',
      },
    ];
    for (const c of cases) {
      const { transport, calls } = fakeTransport(() => ({ result: c.file }));
      const inbox = makeInbox(transport, fakeDownload(Buffer.from('media')));
      await inbox.handleMessage(c.message);
      const sidecar = JSON.parse(
        await fs.readFile(path.join(inboxDir, `${STEM}.json`), 'utf8'),
      ) as Record<string, unknown>;
      expect(sidecar.kind).toBe(c.kind);
      expect(calls.find((c2) => c2.endpoint === 'sendMessage')?.body.text).toBe(c.reply);
      await fs.rm(inboxDir, { recursive: true, force: true });
    }
  });

  it('accepts plain text: sidecar only (no media file), replies "Saved text."', async () => {
    const { transport, calls } = fakeTransport();
    const inbox = makeInbox(transport, fakeDownload(Buffer.alloc(0)));
    await inbox.handleMessage(ownerMessage({ voice: undefined, message_id: 56, text: 'note to self' }));

    expect(calls.every((c) => c.endpoint === 'sendMessage')).toBe(true); // no getFile
    expect((await fs.readdir(inboxDir))).toEqual(['20260629T000010Z-56.json']);
    const sidecar = JSON.parse(
      await fs.readFile(path.join(inboxDir, '20260629T000010Z-56.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(sidecar).toEqual({
      messageId: 56,
      date: '2026-06-29T00:00:10.000Z',
      kind: 'text',
      text: 'note to self',
    });
    expect(calls.find((c) => c.endpoint === 'sendMessage')?.body).toEqual({
      chat_id: Number(OWNER_CHAT),
      text: 'Saved text.',
      reply_to_message_id: 56,
    });
  });

  it('ignores messages from another chat or sender silently (no reply, no files)', async () => {
    const strangerChat = fakeTransport(() => ({ result: VOICE_FILE }));
    const strangerSender = fakeTransport(() => ({ result: VOICE_FILE }));
    await makeInbox(strangerChat.transport, fakeDownload(Buffer.alloc(0)))
      .handleMessage(ownerMessage({ chat: { id: 111 } }));
    await makeInbox(strangerSender.transport, fakeDownload(Buffer.alloc(0)))
      .handleMessage(ownerMessage({ from: { id: 111 } }));

    expect(strangerChat.calls).toHaveLength(0);
    expect(strangerSender.calls).toHaveLength(0);
    expect(await isInboxEmpty()).toBe(true);
  });

  it('answers unsupported kinds and slash commands once, without saving anything', async () => {
    const unsupported: TelegramMessage[] = [
      ownerMessage({ voice: undefined, photo: [{ file_id: 'p1', file_size: 10 }] }),
      ownerMessage({ voice: undefined, text: '/start' }),
      ownerMessage({ voice: undefined, document: { file_id: 'fpdf', mime_type: 'application/pdf' } }),
      ownerMessage({ voice: undefined }),
    ];
    for (const message of unsupported) {
      const { transport, calls } = fakeTransport(() => ({ result: VOICE_FILE }));
      const inbox = makeInbox(transport, fakeDownload(Buffer.alloc(0)));
      await inbox.handleMessage(message);
      expect(calls.find((c) => c.endpoint === 'sendMessage')?.body.text)
        .toBe('Not saved: only voice notes, audio and text are kept.');
      expect(calls.find((c) => c.endpoint === 'getFile')).toBeUndefined();
      expect(await isInboxEmpty()).toBe(true);
    }
  });

  it('answers "Too large to save" from message metadata alone and keeps nothing', async () => {
    const { transport, calls } = fakeTransport(() => ({ result: VOICE_FILE }));
    const inbox = makeInbox(transport, fakeDownload(Buffer.alloc(0)));
    await inbox.handleMessage(ownerMessage({ voice: { file_id: 'fv1', file_size: 21 * 1024 * 1024 } }));

    expect(calls.find((c) => c.endpoint === 'sendMessage')?.body.text).toBe('Too large to save');
    expect(calls.find((c) => c.endpoint === 'getFile')).toBeUndefined();
    expect(await isInboxEmpty()).toBe(true);
  });

  it('answers "Too large to save" when the downloaded bytes exceed the cap, keeps nothing', async () => {
    const { transport, calls } = fakeTransport(() => ({
      result: { ...VOICE_FILE, file_size: undefined },
    }));
    const inbox = makeInbox(transport, fakeDownload(Buffer.alloc(21 * 1024 * 1024 + 1)));
    await inbox.handleMessage(ownerMessage());

    expect(calls.find((c) => c.endpoint === 'sendMessage')?.body.text).toBe('Too large to save');
    expect(await isInboxEmpty()).toBe(true);
  });

  it('answers "Not saved: <reason>" on a failed download and leaves no partial files', async () => {
    const { transport, calls } = fakeTransport(() => ({ result: VOICE_FILE }));
    const inbox = makeInbox(transport, fakeDownload(new Error('network reset')));
    await inbox.handleMessage(ownerMessage());

    const reply = calls.find((c) => c.endpoint === 'sendMessage');
    expect(String(reply?.body.text).startsWith('Not saved: ')).toBe(true);
    expect(await isInboxEmpty()).toBe(true);
  });

  it('answers "Not saved: <reason>" when getFile fails and never downloads', async () => {
    const { transport, calls } = fakeTransport(() => ({ httpStatus: 400 }));
    const download = fakeDownload(Buffer.alloc(0));
    const inbox = makeInbox(transport, download);
    await inbox.handleMessage(ownerMessage());

    expect(String(calls.find((c) => c.endpoint === 'sendMessage')?.body.text).startsWith('Not saved: ')).toBe(true);
    expect(download.calls).toHaveLength(0);
    expect(await isInboxEmpty()).toBe(true);
  });

  it('records caption and replyTo (text truncated to 500 chars) in the sidecar', async () => {
    const { transport } = fakeTransport(() => ({ result: VOICE_FILE }));
    const inbox = makeInbox(transport, fakeDownload(Buffer.from('ogg')));
    await inbox.handleMessage(ownerMessage({
      caption: 'story about the lake',
      reply_to_message: { message_id: 54, text: 'y'.repeat(600) },
    }));

    const sidecar = JSON.parse(
      await fs.readFile(path.join(inboxDir, `${STEM}.json`), 'utf8'),
    ) as { caption?: string; replyTo?: { messageId: number; text?: string } };
    expect(sidecar.caption).toBe('story about the lake');
    expect(sidecar.replyTo).toEqual({ messageId: 54, text: 'y'.repeat(500) });
  });

  it('derives the extension from the file path when allowlisted, else the mime type, else bin', async () => {
    const cases: Array<{ file_path: string; mime?: string; ext: string }> = [
      { file_path: 'voice/file_55.oga', mime: 'audio/ogg', ext: 'oga' }, // path ext wins (allowlisted)
      { file_path: 'voice/file_55.exe', mime: 'audio/ogg', ext: 'ogg' }, // non-allowlisted path ext → mime
      { file_path: 'documents/file_55', mime: 'audio/mpeg', ext: 'mp3' }, // no path ext → mime
      { file_path: 'documents/file_55', mime: 'application/octet-stream', ext: 'bin' }, // unknown → bin
    ];
    for (const c of cases) {
      const { transport } = fakeTransport(() => ({
        result: { ...VOICE_FILE, file_path: c.file_path, mime_type: c.mime },
      }));
      const inbox = makeInbox(transport, fakeDownload(Buffer.from('m')));
      await inbox.handleMessage(ownerMessage({
        voice: { file_id: 'fv1', mime_type: c.mime },
      }));
      expect((await fs.readdir(inboxDir)).sort()).toEqual([`${STEM}.${c.ext}`, `${STEM}.json`].sort());
      await fs.rm(inboxDir, { recursive: true, force: true });
    }
  });

  it('forces the spool dir to 0700 even when it pre-exists looser', async () => {
    await fs.mkdir(inboxDir, { mode: 0o755 });
    const { transport } = fakeTransport();
    const inbox = makeInbox(transport, fakeDownload(Buffer.alloc(0)));
    await inbox.handleMessage(ownerMessage({ voice: undefined, message_id: 57, text: 'hi' }));
    expect(((await fs.stat(inboxDir)).mode & 0o777)).toBe(0o700);
  });

  it('keeps hostile message ids from escaping the spool dir', async () => {
    const { transport, calls } = fakeTransport(() => ({ result: VOICE_FILE }));
    const inbox = makeInbox(transport, fakeDownload(Buffer.alloc(0)));
    await inbox.handleMessage(ownerMessage({ message_id: '../../evil' as unknown as number, text: 'x' }));

    expect(String(calls.find((c) => c.endpoint === 'sendMessage')?.body.text).startsWith('Not saved: ')).toBe(true);
    expect((await fs.readdir(root, { recursive: true })).sort()).toEqual([]);
  });
});
