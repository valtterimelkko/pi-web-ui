import { describe, expect, it } from 'vitest';
import { piSessionIdFromFilename } from '../../../src/pi/session-identity.js';

/**
 * The Pi filename→id parser is shared by the Pi service (header/filename
 * identity preflight) and the session watcher (unlink identity fallback), so it
 * is tested directly as well as through both callers.
 */
describe('piSessionIdFromFilename', () => {
  it('extracts the canonical id from a Pi timestamp_<uuid>.jsonl name', () => {
    expect(piSessionIdFromFilename('/root/.pi/agent/sessions/x/2026-09-28T21-29-27-008Z_01a0e9ec-36e0-74b4-930e-0e5a311deaa1.jsonl'))
      .toBe('01a0e9ec-36e0-74b4-930e-0e5a311deaa1');
    expect(piSessionIdFromFilename('C:\\sessions\\2026-01-01T00-00-00_abc.jsonl')).toBe('abc');
  });

  it('returns undefined when there is no _<id>.jsonl suffix', () => {
    expect(piSessionIdFromFilename('/sessions/plainname.jsonl')).toBeUndefined();
    expect(piSessionIdFromFilename('/sessions/not-jsonl.txt')).toBeUndefined();
    expect(piSessionIdFromFilename('/sessions/')).toBeUndefined();
  });
});
