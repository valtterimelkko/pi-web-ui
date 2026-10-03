import { describe, expect, it } from 'vitest';
import { isPiRuntimeQuiescent, isPiSessionQuiescent, readPiRuntimeQuiescence } from '../../../src/internal-api/runtime-quiescence.js';

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

  // Correction 01 (Luna r1 finding 1): the pinned stale-streaming watchdog can
  // reset manager status to idle WITHOUT disposing the SDK session, so status
  // alone is not cessation truth. The release predicate must share the
  // piLiveness busy truth: manager status AND sdkStreaming AND compaction.
  it('is NOT quiescent when the manager says idle but the SDK is still streaming (correction 01)', () => {
    expect(isPiSessionQuiescent({ status: 'idle', sdkStreaming: true })).toBe(false);
  });

  it('is NOT quiescent while compacting, whatever the status says (correction 01)', () => {
    expect(isPiSessionQuiescent({ status: 'idle', compacting: true })).toBe(false);
    expect(isPiSessionQuiescent({ status: 'busy', compacting: true })).toBe(false);
  });

  it('shares one busy truth between the status-shape and lookup helpers', () => {
    expect(readPiRuntimeQuiescence(() => ({ status: 'idle', sdkStreaming: true }))).toBe(false);
    expect(readPiRuntimeQuiescence(() => ({ status: 'idle' }))).toBe(true);
    expect(readPiRuntimeQuiescence(() => ({ status: 'idle', sdkStreaming: false, compacting: false }))).toBe(true);
  });
});
