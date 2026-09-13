import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearBrowserDiagnostics,
  createBrowserDiagnosticBundle,
} from '../../../src/lib/browserDiagnostics.js';
import { recordSpeechEvent } from '../../../src/lib/speechTelemetry.js';

/**
 * P10 D4 — client speech telemetry. The arbiter's decisions (the "why didn't
 * I hear it?" half) become recoverable through the EXISTING browser
 * diagnostic bundle — no new wire message, no server route. The bundle's
 * privacy rules hold: no utterance text, no ids, allowlisted fields only.
 */
describe('speechTelemetry — rides the existing browser diagnostic bundle', () => {
  beforeEach(() => clearBrowserDiagnostics());

  it('records submit/drop/floor/playback events as allowlisted speech events', () => {
    recordSpeechEvent('submit', { tier: 4 });
    recordSpeechEvent('drop', { tier: 4, reason: 'busy' });
    recordSpeechEvent('floor_held');
    recordSpeechEvent('playback_failed', { tier: 3, errorName: 'SynthesisError' });
    recordSpeechEvent('floor_released');

    const bundle = createBrowserDiagnosticBundle();
    const speech = bundle.events.filter((e) => e.kind === 'speech');
    expect(speech).toHaveLength(5);
    expect(speech[0]).toMatchObject({ kind: 'speech', operation: 'submit', speechTier: 4 });
    expect(speech[1]).toMatchObject({ kind: 'speech', operation: 'drop', speechTier: 4, state: 'busy' });
    expect(speech[2]).toMatchObject({ kind: 'speech', operation: 'floor_held' });
    expect(speech[3]).toMatchObject({ kind: 'speech', operation: 'playback_failed', speechTier: 3, errorName: 'SynthesisError' });
    expect(speech[4]).toMatchObject({ kind: 'speech', operation: 'floor_released' });
  });

  it('keeps the bundle privacy-safe: no text, no ids, bounded fields', () => {
    recordSpeechEvent('submit', {
      tier: 3,
      // Attempted smuggle fields must not survive the allowlist.
      ...({ text: 'the operator said something secret', id: 'msg-42', sessionId: 'sess-9' } as object),
    } as never);
    const json = JSON.stringify(createBrowserDiagnosticBundle());
    expect(json).not.toContain('something secret');
    expect(json).not.toContain('msg-42');
    expect(json).not.toContain('sess-9');
  });

  it('ignores invalid tiers and unknown operations instead of widening the allowlist', () => {
    recordSpeechEvent('submit', { tier: 1 as never }); // tier 1 is the operator floor, not a playback tier
    recordSpeechEvent('submit', { tier: 99 as never });
    recordSpeechEvent('intrigue' as never);
    const speech = createBrowserDiagnosticBundle().events.filter((e) => e.kind === 'speech');
    // Valid operation + invalid tier: the event is kept, the tier is not.
    expect(speech).toHaveLength(2);
    expect(speech[0].speechTier).toBeUndefined();
    expect(speech[1].speechTier).toBeUndefined();
  });

  it('never throws into the arbiter', () => {
    expect(() => recordSpeechEvent('submit', { tier: 2, reason: 'x'.repeat(500) })).not.toThrow();
    const bundle = createBrowserDiagnosticBundle();
    expect(bundle.events[0]?.state?.length ?? 0).toBeLessThanOrEqual(80);
  });
});
