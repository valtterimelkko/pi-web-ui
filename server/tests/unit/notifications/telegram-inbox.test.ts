import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {
  TelegramInbox,
  type DownloadFileFn,
  type TelegramMessage,
} from '../../../src/notifications/telegram-inbox.js';
import { setLogTap, type LogRecord } from '../../../src/logging/logger.js';
import type { TelegramTransport } from '../../../src/notifications/channels/telegram-channel.js';

// Injected failing writes for the atomic-write tests (N1): the first N
// FileHandles opened come back with a writeFile that always throws.
const failState = vi.hoisted(() => ({ failNextWrites: 0 }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    default: actual,
    open: (async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (failState.failNextWrites > 0) {
        failState.failNextWrites -= 1;
        handle.writeFile = async () => {
          throw Object.assign(new Error('simulated write failure'), { code: 'ENOSPC' });
        };
      }
      return handle;
    }) as unknown as typeof actual.open,
  };
});

const OWNER_CHAT = '987654321';
const DATE_SEC = Math.floor(Date.parse('2026-06-29T00:00:10.000Z') / 1000);
const STEM = '20260629T000010Z-55';

interface TransportCall { endpoint: string; body: Record<string, unknown> }

interface ScriptedGetFile { result?: unknown; httpStatus?: number }

function fakeTransport(
  getFile?: (body: Record<string, unknown>) => ScriptedGetFile,
  over: { failSend?: boolean } = {},
): {
  transport: TelegramTransport;
  calls: TransportCall[];
} {
  const calls: TransportCall[] = [];
  const transport: TelegramTransport = {
    async post(url, body) {
      const endpoint = url.split('/').pop() ?? '';
      const parsed = JSON.parse(body) as Record<string, unknown>;
      calls.push({ endpoint, body: parsed });
      if (endpoint === 'sendMessage' && over.failSend) throw new Error('sendMessage network down');
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

/** A download seam in the streamed shape: the inbox reads headers, then the body chunk by chunk. */
function chunkResponse(chunks: Buffer[], headers: Record<string, string> = {}): {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  body: AsyncIterable<Uint8Array>;
} {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    body: (async function* () { for (const c of chunks) yield c; })(),
  };
}

function fakeDownload(outcome: Buffer | Error): DownloadFileFn & { calls: string[] } {
  const calls: string[] = [];
  const fn: DownloadFileFn = async (url) => {
    calls.push(url);
    if (outcome instanceof Error) throw outcome;
    return chunkResponse([outcome]);
  };
  return Object.assign(fn, { calls });
}

interface StreamDownloadHandle {
  fn: DownloadFileFn;
  calls: string[];
  aborted: () => boolean;
  bodyIterated: () => boolean;
}

/** A seam that yields the body in chunks; `hangUntilAbort` never resolves until aborted. */
function fakeStreamDownload(
  chunks: Buffer[],
  over: { headers?: Record<string, string>; hangUntilAbort?: boolean } = {},
): StreamDownloadHandle {
  const calls: string[] = [];
  let aborted = false;
  let bodyIterated = false;
  const fn: DownloadFileFn = (url, signal) => {
    calls.push(url);
    const fail = () => { aborted = true; };
    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail);
    if (over.hangUntilAbort) {
      return new Promise((_, reject) => {
        const stop = () => reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
        if (signal.aborted) stop();
        else signal.addEventListener('abort', stop);
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: (name) => over.headers?.[name.toLowerCase()] ?? null },
      get body() {
        bodyIterated = true;
        return (async function* () { for (const c of chunks) yield c; })();
      },
    });
  };
  return { fn, calls, aborted: () => aborted, bodyIterated: () => bodyIterated };
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Poll until `condition` is true (bounded), so tests never race async spooling. */
async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await wait(5);
  }
  throw new Error('waitFor timed out');
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

describe('TelegramInbox (owner voice notes into the spool)', () => {
  let root: string;
  let inboxDir: string;

  /** True when the spool dir holds no files (missing dir counts as empty). */
  async function isInboxEmpty(): Promise<boolean> {
    try {
      return (await fs.readdir(inboxDir)).length === 0;
    } catch {
      return true; // not created yet counts as empty
    }
  }

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
    failState.failNextWrites = 0;
    setLogTap(null);
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

  // ── N7(a): authorisation edges ────────────────────────────────────────────

  it('ignores a message with no `from` (sender_chat only) and a negative group chat id', async () => {
    const senderChatOnly = fakeTransport(() => ({ result: VOICE_FILE }));
    const groupChat = fakeTransport(() => ({ result: VOICE_FILE }));
    await makeInbox(senderChatOnly.transport, fakeDownload(Buffer.alloc(0)))
      .handleMessage(ownerMessage({ from: undefined, sender_chat: { id: Number(OWNER_CHAT) } }));
    await makeInbox(groupChat.transport, fakeDownload(Buffer.alloc(0)))
      .handleMessage(ownerMessage({ chat: { id: -1009988776655 } }));

    expect(senderChatOnly.calls).toHaveLength(0);
    expect(groupChat.calls).toHaveLength(0);
    expect(await isInboxEmpty()).toBe(true);
  });

  it('accepts a forwarded message that the owner sent (its content is spooled like any owner text)', async () => {
    const { transport, calls } = fakeTransport();
    const inbox = makeInbox(transport, fakeDownload(Buffer.alloc(0)));
    await inbox.handleMessage(ownerMessage({
      voice: undefined,
      text: 'forwarded story',
      forward_origin: { type: 'user', sender_user: { id: 42 } },
    }));

    expect(calls.find((c) => c.endpoint === 'sendMessage')?.body.text).toBe('Saved text.');
    const sidecar = JSON.parse(await fs.readFile(path.join(inboxDir, `${STEM}.json`), 'utf8')) as { text?: string };
    expect(sidecar.text).toBe('forwarded story');
  });

  // ── N1: no orphan tmp file when a write fails ─────────────────────────────

  it('unlinks the tmp file when the media write fails (no partial files left)', async () => {
    const { transport, calls } = fakeTransport(() => ({ result: VOICE_FILE }));
    const inbox = makeInbox(transport, fakeDownload(Buffer.from('ogg-bytes')));
    failState.failNextWrites = 1; // the media tmp write fails
    await inbox.handleMessage(ownerMessage());

    expect(String(calls.find((c) => c.endpoint === 'sendMessage')?.body.text).startsWith('Not saved: ')).toBe(true);
    expect(await isInboxEmpty()).toBe(true);
  });

  it('removes the media file when the sidecar write fails and leaves no tmp files', async () => {
    const { transport, calls } = fakeTransport(() => ({ result: VOICE_FILE }));
    const inbox = makeInbox(transport, fakeDownload(Buffer.from('ogg-bytes')));
    failState.failNextWrites = 2; // first write (media) succeeds, second (sidecar) fails
    await inbox.handleMessage(ownerMessage());

    expect(String(calls.find((c) => c.endpoint === 'sendMessage')?.body.text).startsWith('Not saved: ')).toBe(true);
    expect(await isInboxEmpty()).toBe(true);
  });

  // ── N2: the size cap is enforced before and during the download ───────────

  it('rejects on Content-Length above the cap without reading the body', async () => {
    const { transport, calls } = fakeTransport(() => ({ result: VOICE_FILE }));
    const download = fakeStreamDownload([Buffer.from('should-never-be-read')], {
      headers: { 'content-length': String(21 * 1024 * 1024) },
    });
    const inbox = makeInbox(transport, download.fn);
    await inbox.handleMessage(ownerMessage());

    expect(calls.find((c) => c.endpoint === 'sendMessage')?.body.text).toBe('Too large to save');
    expect(download.bodyIterated()).toBe(false);
    expect(await isInboxEmpty()).toBe(true);
  });

  it('aborts a chunked download mid-stream once the bytes exceed the cap', async () => {
    const { transport, calls } = fakeTransport(() => ({ result: { ...VOICE_FILE, file_size: 5 } }));
    const download = fakeStreamDownload([Buffer.alloc(6, 0x61), Buffer.alloc(6, 0x62)]);
    const inbox = makeInbox(transport, download.fn, { maxFileBytes: 10 });
    await inbox.handleMessage(ownerMessage());

    expect(calls.find((c) => c.endpoint === 'sendMessage')?.body.text).toBe('Too large to save');
    expect(download.aborted()).toBe(true);
    expect(await isInboxEmpty()).toBe(true);
  });

  it('saves a chunked download that stays within the cap', async () => {
    const { transport, calls } = fakeTransport(() => ({ result: { ...VOICE_FILE, file_size: 9 } }));
    const download = fakeStreamDownload([Buffer.from('aaaa'), Buffer.from('bbbbb')]);
    const inbox = makeInbox(transport, download.fn, { maxFileBytes: 10 });
    await inbox.handleMessage(ownerMessage());

    expect(calls.find((c) => c.endpoint === 'sendMessage')?.body.text).toBe('Saved voice note (1:23).');
    const media = await fs.readFile(path.join(inboxDir, `${STEM}.oga`));
    expect(media.equals(Buffer.from('aaaabbbbb'))).toBe(true);
    expect((await fs.readdir(inboxDir)).sort()).toEqual([`${STEM}.oga`, `${STEM}.json`].sort());
  });

  // ── N3: a failed confirmation never turns a successful save into "Not saved" ─

  it('keeps spooled files and never answers "Not saved" when only the confirmation fails', async () => {
    const { transport, calls } = fakeTransport(() => ({ result: VOICE_FILE }), { failSend: true });
    const inbox = makeInbox(transport, fakeDownload(Buffer.from('ogg-bytes')));
    await inbox.handleMessage(ownerMessage());

    // handleMessage resolves (the failure was the best-effort confirmation only),
    // exactly one reply attempt was made (no retry storm, no "Not saved" line),
    // and both files stay on disk.
    expect(calls.filter((c) => c.endpoint === 'sendMessage')).toHaveLength(1);
    expect(String(calls[0].body.text).startsWith('Not saved:')).toBe(false);
    expect((await fs.readdir(inboxDir)).sort()).toEqual([`${STEM}.oga`, `${STEM}.json`].sort());
  });

  // ── N6: file_path from getFile is validated ───────────────────────────────

  it('rejects a getFile file_path that fails the allowlist or carries traversal', async () => {
    for (const file_path of ['../etc/passwd', 'voice/../../x', 'voice\\file.oga']) {
      const { transport, calls } = fakeTransport(() => ({ result: { ...VOICE_FILE, file_path } }));
      const download = fakeDownload(Buffer.from('x'));
      const inbox = makeInbox(transport, download);
      await inbox.handleMessage(ownerMessage());

      expect(String(calls.find((c) => c.endpoint === 'sendMessage')?.body.text).startsWith('Not saved: ')).toBe(true);
      expect(download.calls).toHaveLength(0);
      expect(await isInboxEmpty()).toBe(true);
    }
  });

  // ── N7(c): the token never reaches a reply or a log line ─────────────────

  it('a download error carrying the token reaches neither a reply nor a log line', async () => {
    const logRecords: LogRecord[] = [];
    setLogTap((record) => logRecords.push(record));
    const { transport, calls } = fakeTransport(() => ({ result: VOICE_FILE }));
    const inbox = makeInbox(transport, fakeDownload(
      new Error(`getaddrinfo failed for https://api.telegram.org/file/botFAKE:TOKEN/voice/file_55.oga`),
    ));
    await inbox.handleMessage(ownerMessage());

    const reply = String(calls.find((c) => c.endpoint === 'sendMessage')?.body.text);
    expect(reply.startsWith('Not saved: ')).toBe(true);
    expect(reply).not.toContain('FAKE:TOKEN');
    expect(JSON.stringify(logRecords)).not.toContain('FAKE:TOKEN');
  });

  // ── B1: spooling runs on a bounded queue, never inside the caller ────────

  it('caps the pending queue at 20: further messages are answered "Busy, please resend" and dropped', async () => {
    let release!: () => void;
    const gated = new Promise<void>((resolve) => { release = resolve; });
    const download: DownloadFileFn = async (_url) => {
      await gated; // hold the first message in flight
      return chunkResponse([Buffer.from('ogg-bytes')]);
    };
    const { transport, calls } = fakeTransport(() => ({ result: VOICE_FILE }));
    const inbox = makeInbox(transport, download);

    expect(inbox.enqueue(ownerMessage())).toBe('accepted'); // in flight (held at the download)
    for (let id = 56; id <= 75; id++) {
      expect(inbox.enqueue(ownerMessage({ voice: undefined, message_id: id, text: 'note' }))).toBe('accepted');
    }
    expect(inbox.enqueue(ownerMessage({ chat: { id: 111 } }))).toBe('ignored'); // non-owner: not queued
    expect(inbox.enqueue(ownerMessage({ voice: undefined, message_id: 76, text: 'one too many' }))).toBe('busy');

    release();
    await waitFor(() => calls.filter((c) => c.endpoint === 'sendMessage').length >= 22);

    const texts = calls.filter((c) => c.endpoint === 'sendMessage').map((c) => String(c.body.text));
    expect(texts.filter((t) => t === 'Saved text.')).toHaveLength(20);
    expect(texts).toContain('Saved voice note (1:23).');
    expect(texts).toContain('Busy, please resend');
    expect((await fs.readdir(inboxDir)).filter((f) => f.endsWith('.json'))).toHaveLength(21); // ids 55–75
    expect(await fs.stat(path.join(inboxDir, '20260629T000010Z-76.json')).then(() => true, () => false)).toBe(false);
  });

  it('stop() aborts the in-flight download, drops queued messages and settles quickly', async () => {
    const download = fakeStreamDownload([Buffer.from('ogg')], { hangUntilAbort: true });
    const { transport, calls } = fakeTransport(() => ({ result: VOICE_FILE }));
    const inbox = makeInbox(transport, download.fn);

    inbox.enqueue(ownerMessage());
    await waitFor(() => download.calls.length > 0); // download started
    inbox.enqueue(ownerMessage({ voice: undefined, message_id: 56, text: 'queued' }));

    const t0 = Date.now();
    await inbox.stop();
    expect(Date.now() - t0).toBeLessThan(2_500);
    expect(download.aborted()).toBe(true);
    expect(inbox.enqueue(ownerMessage({ voice: undefined, message_id: 57, text: 'too late' }))).toBe('ignored');

    await wait(30);
    // Nothing was saved: the in-flight note failed with the stop reason, the queued one was dropped.
    expect(await isInboxEmpty()).toBe(true);
    expect(calls.filter((c) => c.endpoint === 'sendMessage').map((c) => String(c.body.text)))
      .toEqual(['Not saved: download aborted: listener stopping']);
  });

  it('stop() never waits more than ~2s even when the download ignores the abort', async () => {
    let release!: () => void;
    const gated = new Promise<void>((resolve) => { release = resolve; });
    const download: DownloadFileFn = async (_url) => {
      await gated; // ignores the abort signal entirely
      return chunkResponse([Buffer.from('ogg')]);
    };
    const { transport } = fakeTransport(() => ({ result: VOICE_FILE }));
    const inbox = makeInbox(transport, download);
    inbox.enqueue(ownerMessage());

    const t0 = Date.now();
    await inbox.stop();
    expect(Date.now() - t0).toBeLessThan(2_900);
    release();
  });
});
