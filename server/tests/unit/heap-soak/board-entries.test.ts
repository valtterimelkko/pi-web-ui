import { describe, expect, it } from 'vitest';
import { filterBoardEntriesForRunDir } from '../../../src/live-validation/heap-soak/board-entries.js';

describe('filterBoardEntriesForRunDir', () => {
  const runDir = '/root/.pi-web-ui/validation/heap-soak/run-1';

  it('finds entries whose scope.repos references the run dir', () => {
    const entries = [
      { id: 'pi-abc', scope: { repos: [`${runDir}/children/A-0001`] } },
      { id: 'antigravity-xyz', scope: { repos: ['/root'] } },
    ];
    expect(filterBoardEntriesForRunDir(entries, runDir)).toEqual(['pi-abc']);
  });

  it('returns empty when nothing references the run dir', () => {
    const entries = [{ id: 'claude-fc35fbf1', scope: { repos: ['/root/pi-web-ui'] } }];
    expect(filterBoardEntriesForRunDir(entries, runDir)).toEqual([]);
  });

  it('tolerates malformed entries (missing scope/repos)', () => {
    expect(filterBoardEntriesForRunDir([{}, { scope: {} }, { id: 'x', scope: { repos: 'not-an-array' } }], runDir)).toEqual([]);
  });
});
