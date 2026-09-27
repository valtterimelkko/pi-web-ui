import { describe, expect, it } from 'vitest';
import { HEAP_SAMPLE_CSV_HEADER } from '../../../src/live-validation/heap-soak/types.js';

/**
 * B0 defect 3: `residentSessionCount` and `registryEntryCount` were both filled
 * from the same `GET /sessions` list length, so the "resident sessions" column
 * was just the registry size (and reported the ~1,700 seeded registry entries
 * as if 1,700 Pi sessions were in memory).
 *
 * No existing server source exposes the live, in-memory Pi session count:
 * `GET /api/v1/capacity` has no such field; `GET /api/v1/diagnostics`'s
 * `sessions.total` and `byRuntime` are registry-derived; and
 * `MultiSessionManager.getMemoryStats().sessionCount` (the one true source) is
 * never exposed by any route. Rather than duplicate the registry column under a
 * different name, the resident-session column is dropped and documented.
 */
describe('heap-sample CSV columns (B0 defect 3)', () => {
  it('keeps registryEntryCount but drops the duplicated residentSessionCount', () => {
    expect(HEAP_SAMPLE_CSV_HEADER).toContain('registryEntryCount');
    expect(HEAP_SAMPLE_CSV_HEADER).not.toContain('residentSessionCount');
  });

  it('has no duplicate column names', () => {
    expect(new Set(HEAP_SAMPLE_CSV_HEADER).size).toBe(HEAP_SAMPLE_CSV_HEADER.length);
  });
});
