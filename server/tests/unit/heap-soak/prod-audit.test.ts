import { describe, expect, it } from 'vitest';
import { buildAuditNeedles, findNeedleMatches } from '../../../src/live-validation/heap-soak/prod-audit.js';

describe('buildAuditNeedles', () => {
  it('includes the run dir and every session id, but NOT the bare run id', () => {
    // B0 defect 5: the bare run id appears in operator sessions and Agent OS
    // captures that merely DISCUSS the run, so it must not be a needle.
    const needles = buildAuditNeedles('/root/.pi-web-ui/validation/heap-soak/run-1', ['s1', 's2']);
    expect(needles).toEqual(['/root/.pi-web-ui/validation/heap-soak/run-1', 's1', 's2']);
    expect(needles).not.toContain('run-1');
  });
});

describe('findNeedleMatches', () => {
  it('flags a file whose content references the run dir', () => {
    const files = [{ path: '/root/.pi/agent/foo.json', content: 'unrelated ambient content /root/.pi-web-ui/validation/heap-soak/run-1/children/x' }];
    const matches = findNeedleMatches(files, buildAuditNeedles('/root/.pi-web-ui/validation/heap-soak/run-1', []));
    expect(matches).toHaveLength(1);
    expect(matches[0].path).toBe('/root/.pi/agent/foo.json');
  });

  it('does NOT flag a file that only mentions the bare run id (operator/capture discussion)', () => {
    // A genuine soak-attributable write carries the isolated cwd path or a
    // session id; a human/agent writing about the run elsewhere only mentions
    // its id, which must not be flagged (B0 defect 5).
    const files = [{ path: '/root/agent-os/memory-vault/evidence/x.md', content: 'We reviewed soak run full-1790411484255-ec8b813c today; verdict LEAK.' }];
    expect(findNeedleMatches(files, buildAuditNeedles('/root/.pi-web-ui/validation/heap-soak/full-1790411484255-ec8b813c', []))).toEqual([]);
  });

  it('flags a planted soak-attributable write (isolated cwd path present)', () => {
    const files = [{ path: '/root/.pi/agent/leaked.json', content: '{"cwd":"/root/.pi-web-ui/validation/heap-soak/run-1/children/A-abcd"}' }];
    expect(findNeedleMatches(files, buildAuditNeedles('/root/.pi-web-ui/validation/heap-soak/run-1', []))).toHaveLength(1);
  });

  it('flags a file whose content references a child session id', () => {
    const files = [{ path: '/root/agent-os/board-store/entries/x.json', content: 'session pi-0123456789abcdef ...' }];
    const matches = findNeedleMatches(files, buildAuditNeedles('/root/x/run-1', ['pi-0123456789abcdef']));
    expect(matches).toHaveLength(1);
    expect(matches[0].needle).toBe('pi-0123456789abcdef');
  });

  it('does not flag unrelated ambient content', () => {
    const files = [{ path: '/root/.pi/agent/session-registry.json', content: 'completely unrelated production traffic' }];
    expect(findNeedleMatches(files, buildAuditNeedles('/root/x/run-1', ['s1']))).toEqual([]);
  });

  it('ignores trivially short needles (guards against false-positive matching)', () => {
    const files = [{ path: '/root/.pi/agent/whatever.json', content: 'contains the letters r u n somewhere' }];
    expect(findNeedleMatches(files, ['run'])).toEqual([]);
  });

  it('reports at most one match per file even if multiple needles match', () => {
    const files = [{ path: '/root/x', content: '/root/x/run-1 and pi-0123456789 both here' }];
    expect(findNeedleMatches(files, ['/root/x/run-1', 'pi-0123456789'])).toHaveLength(1);
  });
});
