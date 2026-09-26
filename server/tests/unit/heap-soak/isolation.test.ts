import { describe, expect, it } from 'vitest';
import {
  assertOutsideProductionPaths,
  diffChecksums,
  productionGuardedPaths,
  sha256Hex,
} from '../../../src/live-validation/heap-soak/isolation.js';

describe('isolation checksums', () => {
  it('sha256Hex is stable for identical content', () => {
    expect(sha256Hex('hello')).toBe(sha256Hex(Buffer.from('hello')));
  });

  it('diffChecksums reports no mismatches for unchanged files', () => {
    const before = [{ path: '/a', sha256: 'aaa' }, { path: '/b', sha256: 'bbb' }];
    expect(diffChecksums(before, before)).toEqual([]);
  });

  it('diffChecksums flags a changed file', () => {
    const before = [{ path: '/a', sha256: 'aaa' }];
    const after = [{ path: '/a', sha256: 'zzz' }];
    expect(diffChecksums(before, after)).toEqual([{ path: '/a', before: 'aaa', after: 'zzz' }]);
  });

  it('diffChecksums flags a file that disappeared or newly appeared', () => {
    const before = [{ path: '/a', sha256: 'aaa' }];
    const after = [{ path: '/b', sha256: 'bbb' }];
    const mismatches = diffChecksums(before, after);
    expect(mismatches).toContainEqual({ path: '/a', before: 'aaa', after: 'MISSING-AFTER' });
    expect(mismatches).toContainEqual({ path: '/b', before: 'MISSING-BEFORE', after: 'bbb' });
  });
});

describe('productionGuardedPaths', () => {
  it('includes the registry, agent config, and notification opt-ins', () => {
    const paths = productionGuardedPaths('/root');
    expect(paths).toContain('/root/.pi-web-ui/session-registry.json');
    expect(paths).toContain('/root/.pi/agent/models.json');
    expect(paths).toContain('/root/.pi/agent/auth.json');
    expect(paths).toContain('/root/.pi/agent/settings.json');
    expect(paths).toContain('/root/.pi-web-ui/notifications/opt-ins.json');
  });
});

describe('assertOutsideProductionPaths', () => {
  const prod = productionGuardedPaths('/root');

  it('allows an unrelated run directory', () => {
    expect(() => assertOutsideProductionPaths('/root/.pi-web-ui/validation/heap-soak/run-1', prod)).not.toThrow();
  });

  it('rejects the exact production path', () => {
    expect(() => assertOutsideProductionPaths('/root/.pi-web-ui/session-registry.json', prod)).toThrow(/collides/);
  });

  it('rejects a path nested under a production directory', () => {
    expect(() => assertOutsideProductionPaths('/root/.pi/agent/models.json/evil', prod)).toThrow(/collides/);
  });
});
