import { describe, expect, it } from 'vitest';
import { buildAuditNeedles, findNeedleMatches } from '../../../src/live-validation/heap-soak/prod-audit.js';

describe('buildAuditNeedles', () => {
  it('includes the run id, run dir, and every session id', () => {
    expect(buildAuditNeedles('run-1', '/root/.pi-web-ui/validation/heap-soak/run-1', ['s1', 's2']))
      .toEqual(['run-1', '/root/.pi-web-ui/validation/heap-soak/run-1', 's1', 's2']);
  });
});

describe('findNeedleMatches', () => {
  it('flags a file whose content references the run dir', () => {
    const files = [{ path: '/root/.pi/agent/foo.json', content: 'unrelated ambient content /root/.pi-web-ui/validation/heap-soak/run-1/children/x' }];
    // The run id ('run-1') is itself a substring of the run dir, and both are
    // valid needles here — either counts as proof of a leak. One match per
    // file is enough (checked exhaustively in the "reports at most one match" test below).
    const matches = findNeedleMatches(files, buildAuditNeedles('run-1', '/root/.pi-web-ui/validation/heap-soak/run-1', []));
    expect(matches).toHaveLength(1);
    expect(matches[0].path).toBe('/root/.pi/agent/foo.json');
  });

  it('flags a file whose content references a child session id', () => {
    const files = [{ path: '/root/agent-os/board-store/entries/x.json', content: 'session pi-0123456789abcdef ...' }];
    const matches = findNeedleMatches(files, buildAuditNeedles('run-1', '/root/x/run-1', ['pi-0123456789abcdef']));
    expect(matches).toHaveLength(1);
    expect(matches[0].needle).toBe('pi-0123456789abcdef');
  });

  it('does not flag unrelated ambient content', () => {
    const files = [{ path: '/root/.pi/agent/session-registry.json', content: 'completely unrelated production traffic' }];
    expect(findNeedleMatches(files, buildAuditNeedles('run-1', '/root/x/run-1', ['s1']))).toEqual([]);
  });

  it('ignores trivially short needles (guards against false-positive matching)', () => {
    const files = [{ path: '/root/.pi/agent/whatever.json', content: 'contains the letters r u n somewhere' }];
    expect(findNeedleMatches(files, ['run'])).toEqual([]);
  });

  it('reports at most one match per file even if multiple needles match', () => {
    const files = [{ path: '/root/x', content: 'run-1 and pi-0123456789 both here' }];
    expect(findNeedleMatches(files, ['run-1', 'pi-0123456789'])).toHaveLength(1);
  });
});
