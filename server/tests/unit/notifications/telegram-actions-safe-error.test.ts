import { describe, expect, it } from 'vitest';
import { safeErrorText } from '../../../src/notifications/telegram-actions-listener.js';

describe('safeErrorText', () => {
  it('redacts the bot token from transport error text', () => {
    const token = '123456:ABC-secret';
    const text = safeErrorText(new Error(`request to https://api.telegram.org/bot${token}/getUpdates failed`), token);
    expect(text).not.toContain(token);
    expect(text).toContain('<redacted>');
  });
  it('caps the length and handles non-errors', () => {
    expect(safeErrorText('x'.repeat(1000), 't').length).toBe(300);
  });
});
