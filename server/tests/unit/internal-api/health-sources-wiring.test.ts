import { describe, expect, it } from 'vitest';
import { internalApiHealthSources } from '../../../src/internal-api/server.js';

const counts = { activeTurns: 2, classes: {}, runtimes: {} } as never;
const snapshot = { runtimes: { devin: { active: 1, queued: 0, draining: 1, quarantined: 0 } } } as never;

describe('Internal API health-source wiring (queued-delivery robustness integration)', () => {
  it('registers attached-lease ownership beside admission counts, read live each sample', () => {
    let reads = 0;
    const sources = internalApiHealthSources(
      { activeCounts: () => counts },
      { getLeaseOwnershipSnapshot: () => { reads += 1; return snapshot; } },
      undefined,
    );
    expect(sources.admissionCounts?.()).toBe(counts);
    expect(sources.permitOwnership).toBeTypeOf('function');
    expect(sources.permitOwnership?.()).toBe(snapshot);
    sources.permitOwnership?.();
    expect(reads).toBe(2);
  });

  it('applies the validation leak only to admission counts, never to ownership', () => {
    const leaked = { activeTurns: 3, classes: {}, runtimes: {} } as never;
    const sources = internalApiHealthSources(
      { activeCounts: () => counts },
      { getLeaseOwnershipSnapshot: () => snapshot },
      { apply: () => leaked },
    );
    expect(sources.admissionCounts?.()).toBe(leaked);
    expect(sources.permitOwnership?.()).toBe(snapshot);
  });
});
