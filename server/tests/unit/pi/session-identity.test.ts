import { describe, expect, it } from 'vitest';
import { piSessionIdFromFilename, strictPiSessionIdFromFilename } from '../../../src/pi/session-identity.js';

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

  // The watcher's unlink fallback uses the strict variant (correction 05): only
  // a real Pi `timestamp_<uuid>.jsonl` name may supply an id from the filename.
  it('strict variant accepts only a real Pi timestamp + UUID file name', () => {
    expect(strictPiSessionIdFromFilename('/s/2026-09-28T22-43-34-298Z_01a0ea30-131a-774f-9f3c-642abb70790e.jsonl'))
      .toBe('01a0ea30-131a-774f-9f3c-642abb70790e');
  });

  it('strict variant rejects malformed prefixes and suffixes', () => {
    const uuid = '01a0ea30-131a-774f-9f3c-642abb70790e';
    expect(strictPiSessionIdFromFilename(`not-a-pi-timestamp_${uuid}.jsonl`)).toBeUndefined();
    expect(strictPiSessionIdFromFilename('2026-09-28T22-43-34-298Z_abc.jsonl')).toBeUndefined();
    expect(strictPiSessionIdFromFilename(`2026-09-28T22-43-34-298Z_${uuid}.jsonl.bak`)).toBeUndefined();
    expect(strictPiSessionIdFromFilename(`2026-09-28T22-43-34-298_${uuid}.jsonl`)).toBeUndefined();
  });
});
