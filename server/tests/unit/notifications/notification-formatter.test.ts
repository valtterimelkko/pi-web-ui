import { describe, it, expect } from 'vitest';
import {
  formatNotification,
  runtimeLabel,
} from '../../../src/notifications/notification-formatter.js';

describe('notification-formatter', () => {
  describe('runtimeLabel', () => {
    it('maps each runtime to a human label', () => {
      expect(runtimeLabel('pi')).toBe('Pi');
      expect(runtimeLabel('claude')).toBe('Claude');
      expect(runtimeLabel('opencode')).toBe('OpenCode');
      expect(runtimeLabel('antigravity')).toBe('Antigravity');
      expect(runtimeLabel(undefined)).toBe('Session');
    });
  });

  describe('formatNotification — header + tail + deep link', () => {
    it('builds an agent_end header, the tail body, and a deep link', () => {
      const out = formatNotification(
        { sessionId: 's1', runtime: 'claude', label: 'Refactor job', kind: 'agent_end', tail: 'All tests pass.' },
        { tailMaxChars: 1200, publicBaseUrl: 'https://app.example.com' },
      );
      expect(out.title).toBe('🤖 Refactor job · waiting for you');
      expect(out.body).toBe('All tests pass.');
      expect(out.deepLink).toBe('https://app.example.com?session=s1');
    });

    it('falls back to the runtime label when no label is given', () => {
      const out = formatNotification(
        { sessionId: 's1', runtime: 'opencode', kind: 'agent_end', tail: 'hi' },
        { tailMaxChars: 1200, publicBaseUrl: 'https://app.example.com' },
      );
      expect(out.title).toBe('🤖 OpenCode · waiting for you');
    });

    it('uses a distinct header for explicit notifications', () => {
      const out = formatNotification(
        { kind: 'explicit', label: 'Deploy', tail: 'shipped' },
        { tailMaxChars: 1200, publicBaseUrl: 'https://app.example.com' },
      );
      expect(out.title).toBe('📢 Deploy');
      expect(out.body).toBe('shipped');
      expect(out.deepLink).toBeUndefined();
    });

    it('clamps a long label (e.g. a first-message auto-name) so the title stays short', () => {
      const longLabel = 'Fix the flaky billing test that times out on cold cache. '.repeat(6);
      const out = formatNotification(
        { sessionId: 's1', runtime: 'pi', label: longLabel, kind: 'agent_end', tail: 'done' },
        { tailMaxChars: 1200, publicBaseUrl: 'https://app.example.com' },
      );
      expect(out.title).toMatch(/^🤖 .+… · waiting for you$/);
      // Name portion (between the emoji prefix and the suffix) stays bounded.
      const name = out.title.slice('🤖 '.length, out.title.length - ' · waiting for you'.length);
      expect(name.length).toBeLessThanOrEqual(80);
      expect(name.endsWith('…')).toBe(true);
    });

    it('leaves a short label unclamped', () => {
      const out = formatNotification(
        { sessionId: 's1', runtime: 'pi', label: 'Refactor job', kind: 'agent_end', tail: 'done' },
        { tailMaxChars: 1200, publicBaseUrl: 'https://app.example.com' },
      );
      expect(out.title).toBe('🤖 Refactor job · waiting for you');
    });
  });

  describe('truncation', () => {
    it('keeps a tail exactly at the limit unchanged (no marker)', () => {
      const tail = 'a'.repeat(50);
      const out = formatNotification(
        { sessionId: 's1', runtime: 'pi', kind: 'agent_end', tail },
        { tailMaxChars: 50, publicBaseUrl: 'https://app.example.com' },
      );
      expect(out.body).toBe(tail);
      expect(out.body).not.toContain('truncated');
    });

    it('truncates a tail over the limit and signals truncation', () => {
      const tail = 'a'.repeat(80);
      const out = formatNotification(
        { sessionId: 's1', runtime: 'pi', kind: 'agent_end', tail },
        { tailMaxChars: 50, publicBaseUrl: 'https://app.example.com' },
      );
      expect(out.body.startsWith('a'.repeat(50))).toBe(true);
      expect(out.body).toContain('truncated');
      expect(out.body.length).toBeLessThan(tail.length);
    });

    it('handles a missing / blank tail with a fallback body', () => {
      const noTail = formatNotification(
        { sessionId: 's1', runtime: 'pi', kind: 'agent_end' },
        { tailMaxChars: 1200, publicBaseUrl: 'https://app.example.com' },
      );
      expect(noTail.body).toMatch(/open the session/i);
      expect(noTail.body.length).toBeGreaterThan(0);

      const blank = formatNotification(
        { sessionId: 's1', runtime: 'pi', kind: 'agent_end', tail: '   \n  ' },
        { tailMaxChars: 1200, publicBaseUrl: 'https://app.example.com' },
      );
      expect(blank.body).toMatch(/open the session/i);
    });
  });

  describe('deep link', () => {
    it('encodes the session id and requires a base url', () => {
      const out = formatNotification(
        { sessionId: 's with spaces', runtime: 'pi', kind: 'agent_end', tail: 'x' },
        { tailMaxChars: 1200, publicBaseUrl: 'https://app.example.com' },
      );
      expect(out.deepLink).toBe('https://app.example.com?session=s%20with%20spaces');
    });

    it('omits the deep link when there is no public base url', () => {
      const out = formatNotification(
        { sessionId: 's1', runtime: 'pi', kind: 'agent_end', tail: 'x' },
        { tailMaxChars: 1200 },
      );
      expect(out.deepLink).toBeUndefined();
    });
  });
});
