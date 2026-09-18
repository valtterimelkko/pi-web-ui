import { describe, expect, it } from 'vitest';
import { captureUnavailableMessage } from './captureFaultCopy';

/**
 * The 2026-09-18 deployed-UI report: "push-to-talk […] it claims that I don't
 * have a microphone at all", while the surface's own copy promised that
 * push-to-talk still worked. Push-to-talk drives the same capture path, so the
 * claim was false on its face. These assertions pin the honesty, not the prose.
 */
describe('capture unavailable copy', () => {
  it('never promises push-to-talk works when the worklet failed to load', () => {
    const message = captureUnavailableMessage({
      reason: 'worklet_unavailable',
      detail: 'Failed to load module script',
      mode: 'push-to-talk',
    });

    expect(message).toContain('capture worklet could not be loaded');
    expect(message).toContain('including push-to-talk');
    expect(message).toContain('Nothing was sent to the worker');
    // The claim that broke the report: there is no text input in Voice Mode, so
    // promising that typing works is false wherever this copy is shown.
    expect(message).not.toContain('typing');
    expect(message).not.toMatch(/push-to-talk (and typing )?(still )?(work|works)\./i);
  });

  it('says push-to-talk shares the failing path for any other capture failure', () => {
    const message = captureUnavailableMessage({ reason: 'capture_failed', mode: 'open-mic' });
    expect(message).toContain('same microphone path');
    expect(message).not.toContain('typing');
    expect(message).toContain('Nothing was sent to the worker');
  });

  it('still reports the cause verbatim when the browser names one', () => {
    const message = captureUnavailableMessage({ reason: 'capture_failed', detail: 'Permission denied' });
    expect(message).toContain('Permission denied');
  });
});
