import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import type { ExecFileException } from 'node:child_process';
import { NotificationStore } from '../../../src/notifications/notification-store.js';
import {
  ActionHandlerRegistry,
  type ExecFileFn,
} from '../../../src/notifications/action-handlers.js';
import {
  TelegramActionsListener,
  type TelegramCallbackQuery,
} from '../../../src/notifications/telegram-actions-listener.js';
import type { DownloadFileFn } from '../../../src/notifications/telegram-inbox.js';
import { formatCallbackData } from '../../../src/notifications/channels/telegram-callback-data.js';
import type { TelegramTransport } from '../../../src/notifications/channels/telegram-channel.js';
import type { Notification } from '../../../src/notifications/types.js';

const UUID = '019f23d5-624d-7ca3-b34c-53b6732c2b44';
const OWNER_CHAT = '987654321';

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Poll until `condition` is true (bounded), so tests never race real file I/O. */
async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await wait(5);
  }
  throw new Error('waitFor timed out');
}

function fakeExec(result: { stdout?: string; error?: ExecFileException | null; stderr?: string } = {}): ExecFileFn & {
  calls: Array<{ file: string; args: readonly string[]; options: { timeout: number } }>;
} {
  const calls: Array<{ file: string; args: readonly string[]; options: { timeout: number } }> = [];
  const execFile: ExecFileFn = (file, args, options, callback) => {
    calls.push({ file, args, options });
    callback(
      result.error ?? null,
      result.stdout ?? '',
      result.stderr ?? '',
    );
    return undefined;
  };
  return Object.assign(execFile, { calls });
}

interface TransportCall { url: string; body: Record<string, unknown> }

function makeTransport(script: Array<unknown[]> = [], failFirst = 0): {
  transport: TelegramTransport;
  calls: TransportCall[];
} {
  const calls: TransportCall[] = [];
  let getUpdatesCalls = 0;
  let failuresLeft = failFirst;
  const transport: TelegramTransport = {
    async post(url, body) {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      const endpoint = url.split('/').pop() ?? '';
      if (endpoint === 'getUpdates') {
        calls.push({ url, body: parsed });
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          throw new Error('network down');
        }
        const result = script[Math.min(getUpdatesCalls, script.length - 1)] ?? [];
        getUpdatesCalls += 1;
        return { status: 200, ok: true, bodyText: JSON.stringify({ ok: true, result }) };
      }
      calls.push({ url, body: parsed });
      return { status: 200, ok: true, bodyText: '{"ok":true}' };
    },
  };
  return { transport, calls };
}

function ownerCallbackQuery(over: Partial<TelegramCallbackQuery> = {}): TelegramCallbackQuery {
  return {
    id: 'cbq-1',
    from: { id: Number(OWNER_CHAT) },
    message: { message_id: 42, chat: { id: Number(OWNER_CHAT) }, text: 'Agent request\n\nwants to message' },
    data: formatCallbackData(UUID, 'approve'),
    ...over,
  };
}

function update(id: number, query: TelegramCallbackQuery) {
  return { update_id: id, callback_query: query };
}

function ownerVoiceMessage(messageId = 9) {
  return {
    message_id: messageId,
    date: Math.floor(Date.parse('2026-06-29T00:00:10.000Z') / 1000),
    from: { id: Number(OWNER_CHAT) },
    chat: { id: Number(OWNER_CHAT) },
    voice: { file_id: 'fv9', duration: 83, mime_type: 'audio/ogg' },
  };
}

function voiceMessageUpdate(updateId: number, messageId = 9) {
  return { update_id: updateId, message: ownerVoiceMessage(messageId) };
}

/** Transport for loop-level tests: scripted getUpdates batches, a working getFile, optional sendMessage failures. */
function makeLoopTransport(batches: unknown[][], over: { failSend?: boolean } = {}): {
  transport: TelegramTransport;
  calls: TransportCall[];
} {
  const calls: TransportCall[] = [];
  let getUpdatesCalls = 0;
  const transport: TelegramTransport = {
    async post(url, body) {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      const endpoint = url.split('/').pop() ?? '';
      calls.push({ url, body: parsed });
      if (endpoint === 'getUpdates') {
        const result = batches[Math.min(getUpdatesCalls, batches.length - 1)] ?? [];
        getUpdatesCalls += 1;
        return { status: 200, ok: true, bodyText: JSON.stringify({ ok: true, result }) };
      }
      if (endpoint === 'sendMessage' && over.failSend) throw new Error('sendMessage network down');
      if (endpoint === 'getFile') {
        return {
          status: 200,
          ok: true,
          bodyText: JSON.stringify({ ok: true, result: { file_id: 'fv9', file_size: 10, mime_type: 'audio/ogg', file_path: 'voice/file_9.oga' } }),
        };
      }
      return { status: 200, ok: true, bodyText: '{"ok":true}' };
    },
  };
  return { transport, calls };
}

function chunkDownload(chunks: Buffer[]): DownloadFileFn {
  return async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: (async function* () { for (const c of chunks) yield c; })(),
  });
}

describe('TelegramActionsListener (CHANNEL.md §7)', () => {
  let dir: string;
  let store: NotificationStore;
  let offsetPath: string;
  let exec: ReturnType<typeof fakeExec>;

  async function seedNotification(over: Partial<Notification> = {}): Promise<Notification> {
    const notification: Notification = {
      id: UUID,
      kind: 'explicit',
      title: 'Agent request',
      body: 'wants to message',
      actions: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }],
      actionHandler: 'agent-os-channel',
      actionRef: 'req-1',
      createdAt: '2026-06-29T00:00:00.000Z',
      ...over,
    };
    await store.enqueue({ notification, delivery: {
      notificationId: notification.id, channel: 'telegram', status: 'sent', attempts: 1, firstQueuedAt: notification.createdAt,
    } });
    return notification;
  }

  function makeListener(transport: TelegramTransport, over: Record<string, unknown> = {}) {
    return new TelegramActionsListener({
      botToken: 'FAKE:TOKEN',
      ownerChatId: OWNER_CHAT,
      store,
      handlers: new ActionHandlerRegistry({
        'agent-os-channel': {
          command: '/root/.npm-global/bin/agent-os',
          args: ['channel', 'decide', '--request', '{ref}', '--decision', '{action}', '--by', 'telegram', '--json'],
        },
      }),
      offsetPath,
      transport,
      execFile: exec,
      now: () => '2026-06-29T00:00:10.000Z',
      loopIdleMs: 5,
      backoffInitialMs: 5,
      backoffMaxMs: 20,
      ...over,
    });
  }

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-tg-listener-'));
    store = new NotificationStore(dir);
    await store.init();
    offsetPath = path.join(dir, 'telegram-offset.json');
    exec = fakeExec({ stdout: '{"message":"Decision recorded"}' });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  it('polls getUpdates long-poll style (timeout ~30s, callback queries only) and carries the stored offset', async () => {
    const { transport, calls } = makeTransport();
    const listener = makeListener(transport);
    listener.start();
    await waitFor(() => calls.some((c) => c.url.endsWith('/getUpdates')));
    await listener.stop();

    const getUpdates = calls.filter((c) => c.url.endsWith('/getUpdates'));
    expect(getUpdates.length).toBeGreaterThanOrEqual(1);
    for (const call of getUpdates) {
      expect(call.body.timeout).toBe(30);
      expect(call.body.allowed_updates).toEqual(['callback_query', 'message']);
      expect(call.body.offset).toBeUndefined(); // no stored offset yet
    }
  });

  it('never starts in validation mode (the tap path is reachable only through the test injection)', async () => {
    const { transport, calls } = makeTransport();
    const listener = makeListener(transport, { validationMode: true });
    listener.start();
    await wait(40);
    await listener.stop();
    expect(calls).toHaveLength(0);
  });

  it('runs the handler once on the first owner tap, records it, answers, then edits the message', async () => {
    await seedNotification();
    const { transport, calls } = makeTransport([[
      update(100, ownerCallbackQuery()),
    ], []]);
    const listener = makeListener(transport);
    listener.start();
    await waitFor(() => Boolean(store.getById(UUID)?.actionTaken));
    await listener.stop();

    // Handler ran once with the §7 argv (ref + action substituted, no shell).
    expect(exec.calls).toEqual([{
      file: '/root/.npm-global/bin/agent-os',
      args: ['channel', 'decide', '--request', 'req-1', '--decision', 'approve', '--by', 'telegram', '--json'],
      options: { timeout: 20000 },
    }]);

    // Recorded on the notification (action, at, result).
    const recorded = store.getById(UUID)?.actionTaken;
    expect(recorded).toEqual({ action: 'approve', at: '2026-06-29T00:00:10.000Z', result: 'Decision recorded' });

    // Every callback query is answered, then the message edited.
    const answer = calls.find((c) => c.url.endsWith('/answerCallbackQuery'));
    const edit = calls.find((c) => c.url.endsWith('/editMessageText'));
    expect(answer?.body).toEqual({ callback_query_id: 'cbq-1', text: 'Decision recorded' });
    expect(edit?.body).toMatchObject({
      chat_id: Number(OWNER_CHAT),
      message_id: 42,
      text: 'Agent request\n\nwants to message\n\nDecision recorded',
    });
    expect(edit?.body.reply_markup).toBeUndefined(); // no buttons after the decision
    const answerIdx = calls.findIndex((c) => c.url.endsWith('/answerCallbackQuery'));
    const editIdx = calls.findIndex((c) => c.url.endsWith('/editMessageText'));
    expect(answerIdx).toBeLessThan(editIdx);
  });

  it('answers "Not allowed" and does nothing else when the chat id is not the owner', async () => {
    await seedNotification();
    const stranger = ownerCallbackQuery({ message: { message_id: 42, chat: { id: 111 }, text: 'x' } });
    const { transport, calls } = makeTransport([[update(100, stranger)], []]);
    const listener = makeListener(transport);
    listener.start();
    await waitFor(() => calls.some((c) => c.url.endsWith('/answerCallbackQuery')));
    await listener.stop();

    expect(exec.calls).toHaveLength(0);
    expect(calls.find((c) => c.url.endsWith('/answerCallbackQuery'))?.body).toMatchObject({ text: 'Not allowed' });
    expect(calls.find((c) => c.url.endsWith('/editMessageText'))).toBeUndefined();
    expect(store.getById(UUID)?.actionTaken).toBeUndefined();
  });

  it('answers "Not allowed" when the sender id is not the owner (chat matches)', async () => {
    await seedNotification();
    const impostor = ownerCallbackQuery({ from: { id: 111 } });
    const { transport, calls } = makeTransport([[update(100, impostor)], []]);
    const listener = makeListener(transport);
    listener.start();
    await waitFor(() => calls.some((c) => c.url.endsWith('/answerCallbackQuery')));
    await listener.stop();

    expect(exec.calls).toHaveLength(0);
    expect(calls.find((c) => c.url.endsWith('/answerCallbackQuery'))?.body).toMatchObject({ text: 'Not allowed' });
    expect(store.getById(UUID)?.actionTaken).toBeUndefined();
  });

  it('is first-tap-wins: a replayed tap is answered "Already decided" and the handler does not run again', async () => {
    await seedNotification();
    await store.recordAction(UUID, { action: 'approve', at: '2026-06-29T00:00:05.000Z', result: 'Decision recorded' });
    const { transport, calls } = makeTransport([[
      update(100, ownerCallbackQuery({ id: 'cbq-2' })),
    ], []]);
    const listener = makeListener(transport);
    listener.start();
    await waitFor(() => calls.some((c) => c.url.endsWith('/answerCallbackQuery')));
    await listener.stop();

    expect(exec.calls).toHaveLength(0);
    expect(calls.find((c) => c.url.endsWith('/answerCallbackQuery'))?.body).toMatchObject({ text: 'Already decided' });
    expect(store.getById(UUID)?.actionTaken?.at).toBe('2026-06-29T00:00:05.000Z'); // untouched
  });

  it('persists the offset and a restarted listener does not replay processed updates', async () => {
    await seedNotification();
    const first = makeListener(makeTransport([[update(100, ownerCallbackQuery())], []]).transport);
    first.start();
    await waitFor(() => fs.stat(offsetPath).then(() => true, () => false));
    await first.stop();

    const stored = JSON.parse(await fs.readFile(offsetPath, 'utf8')) as { offset: number };
    expect(stored.offset).toBe(101);

    const { transport, calls } = makeTransport();
    const restarted = makeListener(transport);
    restarted.start();
    await waitFor(() => calls.some((c) => c.url.endsWith('/getUpdates')));
    await restarted.stop();

    const getUpdates = calls.filter((c) => c.url.endsWith('/getUpdates'));
    expect(getUpdates.length).toBeGreaterThanOrEqual(1);
    expect(getUpdates[0].body.offset).toBe(101); // Telegram never resends update 100
  });

  it('maps a failing handler to "Could not apply: <first stderr line>" (recorded + edited)', async () => {
    await seedNotification();
    exec = fakeExec({ error: Object.assign(new Error('Command failed'), { code: 1 }), stderr: 'refusal: no such request\nmore\n' });
    const { transport, calls } = makeTransport([[update(100, ownerCallbackQuery())], []]);
    const listener = makeListener(transport);
    listener.start();
    await waitFor(() => store.getById(UUID)?.actionTaken?.result === 'Could not apply: refusal: no such request');
    await listener.stop();

    expect(calls.find((c) => c.url.endsWith('/editMessageText'))?.body.text)
      .toBe('Agent request\n\nwants to message\n\nCould not apply: refusal: no such request');
  });

  it('answers but does not run anything for malformed callback data', async () => {
    await seedNotification();
    const malformed = ownerCallbackQuery({ data: 'not-our-format' });
    const { transport, calls } = makeTransport([[update(100, malformed)], []]);
    const listener = makeListener(transport);
    listener.start();
    await waitFor(() => calls.some((c) => c.url.endsWith('/answerCallbackQuery')));
    await listener.stop();

    expect(exec.calls).toHaveLength(0);
    expect(calls.find((c) => c.url.endsWith('/answerCallbackQuery'))?.body).toMatchObject({ text: 'Unknown notification' });
    expect(calls.find((c) => c.url.endsWith('/editMessageText'))).toBeUndefined();
  });

  it('answers "Unknown notification" for a data payload naming no stored notification', async () => {
    const { transport, calls } = makeTransport([[
      update(100, ownerCallbackQuery({ data: formatCallbackData('11111111-2222-4333-8444-555555555555', 'approve') })),
    ], []]);
    const listener = makeListener(transport);
    listener.start();
    await waitFor(() => calls.some((c) => c.url.endsWith('/answerCallbackQuery')));
    await listener.stop();

    expect(exec.calls).toHaveLength(0);
    expect(calls.find((c) => c.url.endsWith('/answerCallbackQuery'))?.body).toMatchObject({ text: 'Unknown notification' });
  });

  it('answers "Unknown action" when the tapped action id is not one of the notification’s actions', async () => {
    await seedNotification();
    const { transport, calls } = makeTransport([[
      update(100, ownerCallbackQuery({ data: formatCallbackData(UUID, 'mischief') })),
    ], []]);
    const listener = makeListener(transport);
    listener.start();
    await waitFor(() => calls.some((c) => c.url.endsWith('/answerCallbackQuery')));
    await listener.stop();

    expect(exec.calls).toHaveLength(0);
    expect(calls.find((c) => c.url.endsWith('/answerCallbackQuery'))?.body).toMatchObject({ text: 'Unknown action' });
    expect(store.getById(UUID)?.actionTaken).toBeUndefined();
  });

  it('backs off on transport errors and recovers (offset untouched while failing)', async () => {
    await seedNotification();
    const { transport, calls } = makeTransport([[update(100, ownerCallbackQuery())], []], 2);
    const listener = makeListener(transport);
    listener.start();
    await waitFor(() => Boolean(store.getById(UUID)?.actionTaken));
    await listener.stop();

    expect(calls.filter((c) => c.url.endsWith('/getUpdates')).length).toBeGreaterThanOrEqual(3);
    // The tap still went through once the transport recovered.
    expect(store.getById(UUID)?.actionTaken).toBeDefined();
    expect(JSON.parse(await fs.readFile(offsetPath, 'utf8'))).toEqual({ offset: 101 });
  });

  it('ignores updates that are not callback queries (offset still advances)', async () => {
    const { transport, calls } = makeTransport([[
      { update_id: 100, message: { message_id: 1, chat: { id: 1 }, text: 'plain message' } },
    ], []]);
    const listener = makeListener(transport);
    listener.start();
    await waitFor(() => fs.stat(offsetPath).then(() => true, () => false));
    await listener.stop();

    expect(exec.calls).toHaveLength(0);
    expect(calls.find((c) => c.url.endsWith('/answerCallbackQuery'))).toBeUndefined();
    expect(JSON.parse(await fs.readFile(offsetPath, 'utf8'))).toEqual({ offset: 101 });
  });

  it('spools a text message from the owner and advances the offset', async () => {
    const { transport, calls } = makeTransport([[{
      update_id: 100,
      message: {
        message_id: 9,
        date: Math.floor(Date.parse('2026-06-29T00:00:10.000Z') / 1000),
        from: { id: Number(OWNER_CHAT) },
        chat: { id: Number(OWNER_CHAT) },
        text: 'note to self',
      },
    }], []]);
    const listener = makeListener(transport);
    listener.start();
    const spooled = path.join(dir, 'telegram-inbox', '20260629T000010Z-9.json');
    await waitFor(() => fs.stat(spooled).then(() => true, () => false));
    await listener.stop();

    expect(calls.find((c) => c.url.endsWith('/sendMessage'))?.body).toEqual({
      chat_id: Number(OWNER_CHAT),
      text: 'Saved text.',
      reply_to_message_id: 9,
    });
    expect(JSON.parse(await fs.readFile(offsetPath, 'utf8'))).toEqual({ offset: 101 });
  });

  it('a restarted listener does not re-save an already processed message', async () => {
    const inboxDir = path.join(dir, 'telegram-inbox');
    const first = makeListener(makeTransport([[{
      update_id: 100,
      message: {
        message_id: 9,
        date: Math.floor(Date.parse('2026-06-29T00:00:10.000Z') / 1000),
        from: { id: Number(OWNER_CHAT) },
        chat: { id: Number(OWNER_CHAT) },
        text: 'note to self',
      },
    }], []]).transport);
    first.start();
    await waitFor(() => fs.stat(path.join(inboxDir, '20260629T000010Z-9.json')).then(() => true, () => false));
    await first.stop();

    const { transport, calls } = makeTransport([], 0);
    const restarted = makeListener(transport);
    restarted.start();
    await waitFor(() => calls.some((c) => c.url.endsWith('/getUpdates')));
    await wait(20);
    await restarted.stop();

    expect((await fs.readdir(inboxDir)).filter((f) => f.endsWith('.json'))).toEqual(['20260629T000010Z-9.json']);
    expect(calls.find((c) => c.url.endsWith('/sendMessage'))).toBeUndefined();
  });

  it('exposes the tap path directly for the validation-mode test-only injection', async () => {
    await seedNotification();
    const { transport, calls } = makeTransport();
    const listener = makeListener(transport);
    await listener.handleCallbackQuery(ownerCallbackQuery());

    expect(exec.calls).toHaveLength(1);
    expect(store.getById(UUID)?.actionTaken).toEqual({ action: 'approve', at: '2026-06-29T00:00:10.000Z', result: 'Decision recorded' });
    expect(calls.find((c) => c.url.endsWith('/editMessageText'))).toBeDefined();
  });

  // ── B1: message spooling never blocks the tap path ─────────────────────────

  it('answers a tap within ~1s while a voice-note download hangs in the same batch, and stop() aborts the download', async () => {
    await seedNotification();
    let aborted = false;
    const hangDownload: DownloadFileFn = (_url, signal) => {
      const fail = () => {
        aborted = true;
        rejectRef(new Error(signal.reason instanceof Error ? signal.reason.message : 'aborted'));
      };
      let rejectRef: (e: Error) => void;
      const promise = new Promise<never>((_, reject) => { rejectRef = reject; });
      if (signal.aborted) fail();
      else signal.addEventListener('abort', fail);
      return promise;
    };
    const { transport, calls } = makeLoopTransport([[
      voiceMessageUpdate(100),
      update(101, ownerCallbackQuery()),
    ]]);
    const listener = makeListener(transport, { downloadFile: hangDownload });

    const t0 = Date.now();
    listener.start();
    await waitFor(() => calls.some((c) => c.url.endsWith('/answerCallbackQuery')), 1_000);
    expect(Date.now() - t0).toBeLessThan(1_000);
    // The message is past the queue (getFile called), so stop() has a
    // download to abort — waiting messages are dropped by design.
    await waitFor(() => calls.some((c) => c.url.endsWith('/getFile')));

    await listener.stop();
    expect(aborted).toBe(true);
    expect(store.getById(UUID)?.actionTaken).toBeDefined();
  });

  it('answers a tap after a message whose handling throws (offset still advances past both)', async () => {
    await seedNotification();
    // Unsupported kind (photo) from the owner; sendMessage always fails, so the
    // "Not saved" reply itself throws out of the message handling.
    const { transport, calls } = makeLoopTransport([[
      {
        update_id: 100,
        message: { ...ownerVoiceMessage(), voice: undefined, photo: [{ file_id: 'p1', file_size: 10 }] },
      },
      update(101, ownerCallbackQuery()),
    ]], { failSend: true });
    const listener = makeListener(transport);
    listener.start();

    await waitFor(() => calls.some((c) => c.url.endsWith('/answerCallbackQuery')), 1_000);
    await listener.stop();

    expect(store.getById(UUID)?.actionTaken).toBeDefined();
    expect(JSON.parse(await fs.readFile(offsetPath, 'utf8'))).toEqual({ offset: 102 });
  });

  it('handles callback queries before messages within one batch', async () => {
    await seedNotification();
    const { transport, calls } = makeLoopTransport([[
      voiceMessageUpdate(100),
      update(101, ownerCallbackQuery()),
    ]]);
    const listener = makeListener(transport, { downloadFile: chunkDownload([Buffer.from('ogg')]) });
    listener.start();
    await waitFor(() => calls.some((c) => c.url.endsWith('/answerCallbackQuery')));
    // The tap is answered first; wait for the message's getFile so the
    // ordering assertion below cannot race stop().
    await waitFor(() => calls.some((c) => c.url.endsWith('/getFile')));
    await listener.stop();

    const answerIdx = calls.findIndex((c) => c.url.endsWith('/answerCallbackQuery'));
    const getFileIdx = calls.findIndex((c) => c.url.endsWith('/getFile'));
    expect(answerIdx).toBeGreaterThanOrEqual(0);
    expect(getFileIdx).toBeGreaterThan(answerIdx);
  });
});
