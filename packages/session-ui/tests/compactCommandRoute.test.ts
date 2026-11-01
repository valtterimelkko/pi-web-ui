import { describe, expect, it } from 'vitest';
import { COMPACTION_UNAVAILABLE_NOTICE, compactCommandRoute } from '../src/piExtensionControls';

/**
 * L4 round 2 / NOTE 1: a hand-typed `/compact` must open the compaction modal
 * only for a Pi session. On any other runtime the composer shows one plain
 * inline sentence and sends nothing — before this it opened the Pi-only modal
 * and the server answered the misleading `SESSION_NOT_FOUND` ("Session not
 * found") to a session that plainly exists.
 */
describe('compactCommandRoute (NOTE 1)', () => {
  it('routes a typed /compact to the compaction modal for a pi session', () => {
    expect(compactCommandRoute('/compact', 'pi')).toBe('compact');
    expect(compactCommandRoute('  /compact  ', 'pi')).toBe('compact');
  });

  it('refuses /compact on every other runtime instead of opening the pi-only modal', () => {
    const others = ['claude', 'opencode', 'antigravity', 'commandcode', null, undefined, 'not-a-runtime'];
    for (const sdkType of others) {
      expect(compactCommandRoute('/compact', sdkType as never)).toBe('unavailable');
    }
  });

  it('leaves every other message alone — no interception', () => {
    expect(compactCommandRoute('/compact-all', 'pi')).toBe('prompt');
    expect(compactCommandRoute('compact', 'pi')).toBe('prompt');
    expect(compactCommandRoute('/goal pause', 'antigravity')).toBe('prompt');
    expect(compactCommandRoute('/clear', 'claude')).toBe('prompt');
    expect(compactCommandRoute('', 'pi')).toBe('prompt');
  });

  it('offers one plain British-English sentence to show inline', () => {
    expect(COMPACTION_UNAVAILABLE_NOTICE).toBe('Compaction is not available for this runtime from the browser');
  });
});
