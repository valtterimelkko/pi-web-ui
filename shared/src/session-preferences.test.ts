import { describe, expect, it } from 'vitest';
import { deriveLegacySessionArrays } from './session-preferences.js';

/** Fixed fixture set pinning BOTH real consumers (server compat window and
 * client optimistic projection) to one shared, identical transformation. */
const fixtures: Record<string, Record<string, { legacyKey?: string; archived?: boolean; pinned?: boolean; displayName?: string }>> = {
  'all five runtimes with legacy keys': {
    'pi:uuid-1': { legacyKey: '/sessions/--p--/pi.jsonl', archived: true },
    'claude:uuid-2': { legacyKey: 'claude-2', pinned: true },
    'opencode:uuid-3': { legacyKey: 'oc-3', archived: true, pinned: true },
    'antigravity:uuid-4': { legacyKey: 'agy-4', displayName: 'Research' },
    'commandcode:uuid-5': { legacyKey: 'cc-5', archived: true, displayName: 'Build' },
  },
  'missing values fall back to the v2 key id': {
    'pi:no-legacy-key': { archived: true },
    'claude:renamed-from': { displayName: 'Renamed' },
  },
  'empty records derive nothing': { 'pi:empty': {} },
};

describe('shared legacy session-preference derivation', () => {
  it('derives identical arrays for every runtime with legacy keys', () => {
    const result = deriveLegacySessionArrays(fixtures['all five runtimes with legacy keys']);
    expect(result.archivedSessionPaths).toEqual(['/sessions/--p--/pi.jsonl', 'oc-3', 'cc-5']);
    expect(result.pinnedSessionPaths).toEqual(['claude-2', 'oc-3']);
    expect(result.sessionDisplayNames).toEqual({ 'agy-4': 'Research', 'cc-5': 'Build' });
  });

  it('falls back to the key id after the first colon when legacyKey is absent', () => {
    const result = deriveLegacySessionArrays(fixtures['missing values fall back to the v2 key id']);
    expect(result.archivedSessionPaths).toEqual(['no-legacy-key']);
    expect(result.sessionDisplayNames).toEqual({ 'renamed-from': 'Renamed' });
  });

  it('derives nothing from empty records and tolerates an empty map', () => {
    expect(deriveLegacySessionArrays(fixtures['empty records derive nothing']))
      .toEqual({ archivedSessionPaths: [], pinnedSessionPaths: [], sessionDisplayNames: {} });
    expect(deriveLegacySessionArrays({}))
      .toEqual({ archivedSessionPaths: [], pinnedSessionPaths: [], sessionDisplayNames: {} });
  });
});
