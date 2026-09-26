import { describe, expect, it } from 'vitest';
import { parseHeapSnapshotSummary } from '../../../src/live-validation/heap-soak/snapshot-parse.js';

function fixtureSnapshot(): string {
  // Minimal 2-field-per-node fixture (id, self_size) so the sum is checkable by hand.
  return JSON.stringify({
    snapshot: {
      meta: { node_fields: ['id', 'self_size'] },
      node_count: 3,
      edge_count: 2,
    },
    nodes: [1, 100, 2, 200, 3, 50],
    edges: [],
    strings: [],
  });
}

describe('parseHeapSnapshotSummary', () => {
  it('parses a minimal valid .heapsnapshot document', () => {
    const summary = parseHeapSnapshotSummary(fixtureSnapshot());
    expect(summary.nodeCount).toBe(3);
    expect(summary.edgeCount).toBe(2);
    expect(summary.totalSizeBytes).toBe(350);
  });

  it('throws on a document missing snapshot/nodes', () => {
    expect(() => parseHeapSnapshotSummary(JSON.stringify({ foo: 1 }))).toThrow(/Not a valid/);
  });

  it('throws on malformed JSON', () => {
    expect(() => parseHeapSnapshotSummary('{not json')).toThrow();
  });
});
