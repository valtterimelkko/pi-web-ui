import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearBrowserDiagnostics,
  recordBrowserDiagnostic,
  getRecentBrowserEvents,
  createBrowserDiagnosticBundle,
} from '../../../src/lib/browserDiagnostics.js';
import {
  reportClientError,
  installGlobalErrorReporting,
  resetClientErrorReporter,
  MAX_REPORTS_PER_PAGE,
} from '../../../src/lib/clientDiagnosticsReporter.js';

/**
 * P13 Phase 2 — the client half of "make voice errors visible".
 *
 * A client crash dies with the page: the browser diagnostic ring is
 * manual-only, and the React error boundary's manual export is unreachable
 * once the tab reloads. These tests pin the minimal additive upload the P13
 * brief authorises: a bounded, scrubbed, self-rate-limited POST to
 * /api/client-diagnostics that re-emits the report as an ordinary ClientVoice
 * record in the SERVER's diagnostics ring — retrievable through the same
 * documented query as every server-side record.
 */
describe('clientDiagnosticsReporter', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    clearBrowserDiagnostics();
    resetClientErrorReporter();
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('getRecentBrowserEvents (bounded ring read for context)', () => {
    it('returns the newest events, oldest first, capped at max', () => {
      for (let i = 0; i < 20; i++) {
        recordBrowserDiagnostic({ kind: 'speech', operation: 'submit', speechTier: 4 });
      }
      const events = getRecentBrowserEvents(5);
      expect(events).toHaveLength(5);
      expect(events.every((e) => e.kind === 'speech')).toBe(true);
    });

    it('projects only allowlisted fields (no text, no ids)', () => {
      recordBrowserDiagnostic({ kind: 'speech', operation: 'floor_held' });
      const events = getRecentBrowserEvents(10);
      expect(events[0]).toMatchObject({ kind: 'speech', operation: 'floor_held' });
      const json = JSON.stringify(events);
      expect(json).not.toContain('utterance');
    });
  });

  describe('reportClientError', () => {
    it('POSTs a bounded scrubbed report to /api/client-diagnostics', async () => {
      await reportClientError({
        operation: 'unhandled_rejection',
        message: 'Cannot read properties of undefined (reading gain)',
        errorName: 'TypeError',
        stack: 'TypeError: ...\n    at setVolume (useReadAloud.ts:1:1)',
        runtime: 'pi',
        workerSessionId: '01a09cbd',
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('/api/client-diagnostics');
      expect(init.method).toBe('POST');
      expect(init.credentials).toBe('include');
      const body = JSON.parse(init.body);
      expect(body.operation).toBe('unhandled_rejection');
      expect(body.workerSessionId).toBe('01a09cbd');
      expect(body.message).toContain('reading gain');
    });

    it('scrubs credential-shaped text client-side (defence in depth before the ring)', async () => {
      await reportClientError({
        operation: 'uncaught_error',
        message: 'request failed with token=super-secret-value in the URL',
      });
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.message).not.toContain('super-secret-value');
    });

    it('attaches a bounded recent-event context by default (the barge-in story rides along)', async () => {
      recordBrowserDiagnostic({ kind: 'speech', operation: 'floor_held' });
      recordBrowserDiagnostic({ kind: 'speech', operation: 'playback_failed', speechTier: 3, errorName: 'DecodeError' });
      await reportClientError({ operation: 'uncaught_error', message: 'boom' });
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.recentEvents).toHaveLength(2);
      expect(body.recentEvents[1]).toMatchObject({ operation: 'playback_failed', errorName: 'DecodeError' });
    });

    it('never throws, even when the network fails', async () => {
      fetchMock.mockRejectedValue(new Error('network down'));
      await expect(
        reportClientError({ operation: 'uncaught_error', message: 'boom' }),
      ).resolves.toBeUndefined();
    });

    it(`caps itself at ${MAX_REPORTS_PER_PAGE} uploads per page load`, async () => {
      for (let i = 0; i < MAX_REPORTS_PER_PAGE + 5; i++) {
        await reportClientError({ operation: 'uncaught_error', message: `boom ${i}` });
      }
      expect(fetchMock).toHaveBeenCalledTimes(MAX_REPORTS_PER_PAGE);
    });
  });

  describe('installGlobalErrorReporting', () => {
    it('routes uncaught errors and unhandled rejections into the ring AND the upload', async () => {
      installGlobalErrorReporting();

      const errEvent = new ErrorEvent('error', { message: 'sync boom', error: new Error('sync boom') });
      window.dispatchEvent(errEvent);
      const rejEvent = new Event('unhandledrejection');
      (rejEvent as unknown as { reason: Error }).reason = new Error('async boom');
      window.dispatchEvent(rejEvent);
      await new Promise((r) => setTimeout(r, 0));

      const bundle = JSON.stringify(createBrowserDiagnosticBundle().events);
      expect(bundle).toContain('uncaught_error');
      expect(bundle).toContain('unhandled_rejection');

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(firstBody.operation).toBe('uncaught_error');
      expect(firstBody.message).toBe('sync boom');
      expect(secondBody.operation).toBe('unhandled_rejection');
    });

    it('is idempotent (double install must not double-report)', async () => {
      installGlobalErrorReporting();
      installGlobalErrorReporting();
      window.dispatchEvent(new ErrorEvent('error', { message: 'once', error: new Error('once') }));
      await new Promise((r) => setTimeout(r, 0));
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
