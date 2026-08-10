import { describe, expect, it } from 'vitest';
import { isPiRuntimeQuiescent, readPiRuntimeQuiescence } from '../../../src/internal-api/runtime-quiescence.js';

describe('Pi Internal API runtime quiescence', () => {
  it('keeps busy and streaming sessions non-quiescent', () => {
    expect(isPiRuntimeQuiescent('busy')).toBe(false);
    expect(isPiRuntimeQuiescent('streaming')).toBe(false);
  });

  it('treats an unloaded session as quiescent when there is no active status', () => {
    expect(isPiRuntimeQuiescent(undefined)).toBe(true);
    expect(isPiRuntimeQuiescent('idle')).toBe(true);
  });

  it('fails closed when the status lookup throws', () => {
    expect(readPiRuntimeQuiescence(() => {
      throw new Error('status lookup failed');
    })).toBe(false);
  });

  it('uses the status returned by the lookup', () => {
    expect(readPiRuntimeQuiescence(() => ({ status: 'streaming' }))).toBe(false);
    expect(readPiRuntimeQuiescence(() => undefined)).toBe(true);
  });
});
