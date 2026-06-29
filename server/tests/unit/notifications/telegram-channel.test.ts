import { describe, it, expect } from 'vitest';
import { TelegramChannel, type TelegramTransport } from '../../../src/notifications/channels/telegram-channel.js';
import type { Notification } from '../../../src/notifications/types.js';

// Fake creds only — never a real secret. Tests must not hit the network.
const FAKE_TOKEN = 'FAKE:TOKEN-12345';
const FAKE_CHAT = '987654321';

function makeTransport(overrides: Partial<TelegramTransport> = {}): TelegramTransport & {
  calls: { url: string; body: string }[];
} {
  const calls: { url: string; body: string }[] = [];
  const transport: TelegramTransport & { calls: typeof calls } = {
    calls,
    async post(url, body) {
      calls.push({ url, body });
      return { status: 200, ok: true, bodyText: '{"ok":true}' };
    },
    ...overrides,
  };
  return transport;
}

function agentEndNotification(over: Partial<Notification> = {}): Notification {
  return {
    id: 'n1',
    sessionId: 's1',
    runtime: 'claude',
    kind: 'agent_end',
    title: '🤖 Claude · waiting for you',
    body: 'All tests pass.',
    deepLink: 'https://app.example.com?session=s1',
    createdAt: '2026-06-29T00:00:01.000Z',
    ...over,
  };
}

describe('TelegramChannel', () => {
  describe('isConfigured', () => {
    it('is false when either credential is missing', () => {
      expect(new TelegramChannel({ botToken: FAKE_TOKEN, chatId: undefined }).isConfigured()).toBe(false);
      expect(new TelegramChannel({ botToken: undefined, chatId: FAKE_CHAT }).isConfigured()).toBe(false);
      expect(new TelegramChannel({}).isConfigured()).toBe(false);
    });

    it('is true when both credentials are present', () => {
      expect(new TelegramChannel({ botToken: FAKE_TOKEN, chatId: FAKE_CHAT }).isConfigured()).toBe(true);
    });
  });

  describe('send — payload + transport', () => {
    it('POSTs a sendMessage payload to the bot endpoint via the injectable transport', async () => {
      const transport = makeTransport();
      const ch = new TelegramChannel({ botToken: FAKE_TOKEN, chatId: FAKE_CHAT, transport });
      await ch.send(agentEndNotification());

      expect(transport.calls).toHaveLength(1);
      expect(transport.calls[0].url).toBe(`https://api.telegram.org/bot${FAKE_TOKEN}/sendMessage`);

      const payload = JSON.parse(transport.calls[0].body);
      expect(payload.chat_id).toBe(FAKE_CHAT);
      expect(payload.disable_web_page_preview).toBe(true);
      // Composed text = title + blank line + body + blank line + deep link.
      expect(payload.text).toBe(
        [
          '🤖 Claude · waiting for you',
          'All tests pass.',
          'https://app.example.com?session=s1',
        ].join('\n\n'),
      );
    });

    it('resolves on a successful response', async () => {
      const transport = makeTransport();
      const ch = new TelegramChannel({ botToken: FAKE_TOKEN, chatId: FAKE_CHAT, transport });
      await expect(ch.send(agentEndNotification())).resolves.toBeUndefined();
    });
  });

  describe('send — failure handling', () => {
    it('throws on a non-ok response (so the outbox retries)', async () => {
      const transport = makeTransport({
        async post() {
          return { status: 401, ok: false, bodyText: '{"ok":false,"description":"Unauthorized"}' };
        },
      });
      const ch = new TelegramChannel({ botToken: FAKE_TOKEN, chatId: FAKE_CHAT, transport });
      await expect(ch.send(agentEndNotification())).rejects.toThrow(/Telegram sendMessage failed/);
    });

    it('never leaks the bot token in the thrown error message', async () => {
      // Pathological case: the response body somehow echoes the token. The
      // channel must redact it from any error it throws.
      const transport = makeTransport({
        async post() {
          return {
            status: 400,
            ok: false,
            bodyText: `{"ok":false,"description":"bad token ${FAKE_TOKEN}"}'`,
          };
        },
      });
      const ch = new TelegramChannel({ botToken: FAKE_TOKEN, chatId: FAKE_CHAT, transport });
      await expect(
        ch.send(agentEndNotification()).catch((e: Error) => {
          expect(e.message).not.toContain(FAKE_TOKEN);
          // Sanity: the redacted marker replaced it.
          expect(e.message).toContain('<redacted>');
          throw e;
        }),
      ).rejects.toThrow();
    });

    it('throws when used while not configured', async () => {
      const ch = new TelegramChannel({ botToken: undefined, chatId: undefined });
      await expect(ch.send(agentEndNotification())).rejects.toThrow(/not configured/i);
    });
  });

  describe('send — telegram length safety net', () => {
    it('caps the composed text to Telegram’s 4096-char limit', async () => {
      const transport = makeTransport();
      const ch = new TelegramChannel({ botToken: FAKE_TOKEN, chatId: FAKE_CHAT, transport });
      const huge = 'x'.repeat(20_000);
      await ch.send(agentEndNotification({ body: huge }));

      const payload = JSON.parse(transport.calls[0].body);
      expect(payload.text.length).toBeLessThanOrEqual(4096);
      // The deep link must survive truncation.
      expect(payload.text).toContain('https://app.example.com?session=s1');
    });
  });
});
