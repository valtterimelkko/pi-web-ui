import { describe, expect, it } from 'vitest';
import { aggregateByConstructor, diffAggregates, parseHeapSnapshotSummary, type ConstructorAggregate } from '../../../src/live-validation/heap-soak/snapshot-parse.js';

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

function fixtureWithConstructors(sizes: { fooA: number; fooB: number; bar: number; str: number; arr: number }): string {
  return JSON.stringify({
    snapshot: {
      meta: {
        node_fields: ['type', 'name', 'id', 'self_size'],
        node_types: [['hidden', 'array', 'string', 'object', 'code']],
      },
      node_count: 5,
      edge_count: 0,
    },
    nodes: [
      3, 1, 1, sizes.fooA, // object 'Foo'
      3, 1, 2, sizes.fooB, // object 'Foo'
      3, 2, 3, sizes.bar, // object 'Bar'
      2, 0, 4, sizes.str, // string
      1, 0, 5, sizes.arr, // array
    ],
    strings: ['', 'Foo', 'Bar', 'somestring'],
  });
}

describe('aggregateByConstructor / diffAggregates', () => {
  it('groups object nodes by constructor name and other nodes by type', () => {
    const agg = aggregateByConstructor(fixtureWithConstructors({ fooA: 100, fooB: 50, bar: 30, str: 20, arr: 10 }));
    const byLabel = Object.fromEntries(agg.map((a) => [a.label, a]));
    expect(byLabel.Foo).toEqual({ label: 'Foo', count: 2, selfSizeBytes: 150 });
    expect(byLabel.Bar).toEqual({ label: 'Bar', count: 1, selfSizeBytes: 30 });
    expect(byLabel.string).toEqual({ label: 'string', count: 1, selfSizeBytes: 20 });
    expect(byLabel.array).toEqual({ label: 'array', count: 1, selfSizeBytes: 10 });
  });

  it('sorts aggregates by self-size descending', () => {
    const agg = aggregateByConstructor(fixtureWithConstructors({ fooA: 100, fooB: 50, bar: 30, str: 20, arr: 10 }));
    expect(agg[0].label).toBe('Foo'); // 150 total, the largest
  });

  it('diffAggregates sorts by growth (delta) descending, first vs last', () => {
    // Both 'fooA' and 'fooB' nodes share the label 'Foo' (same constructor name); only
    // fooB's self_size changes between snapshots, so 'Foo's aggregate size grows 100->600.
    const before = aggregateByConstructor(fixtureWithConstructors({ fooA: 100, fooB: 0, bar: 30, str: 20, arr: 10 }));
    const after = aggregateByConstructor(fixtureWithConstructors({ fooA: 100, fooB: 500, bar: 30, str: 20, arr: 10 }));
    const growth = diffAggregates(before, after);
    expect(growth[0].label).toBe('Foo');
    expect(growth[0].deltaBytes).toBe(500);
    expect(growth[0].countBefore).toBe(2);
    expect(growth[0].countAfter).toBe(2);
  });

  it('diffAggregates includes a label present only in one snapshot (count 0 on the other side)', () => {
    const before = aggregateByConstructor(fixtureWithConstructors({ fooA: 100, fooB: 50, bar: 30, str: 20, arr: 10 }));
    const afterNoBar: ConstructorAggregate[] = [
      { label: 'Foo', count: 2, selfSizeBytes: 150 },
      { label: 'string', count: 1, selfSizeBytes: 20 },
      { label: 'array', count: 1, selfSizeBytes: 10 },
    ];
    const growth = diffAggregates(before, afterNoBar);
    const bar = growth.find((g) => g.label === 'Bar')!;
    expect(bar.countAfter).toBe(0);
    expect(bar.sizeAfterBytes).toBe(0);
    expect(bar.deltaBytes).toBe(-30);
  });

  it('throws on a document missing strings', () => {
    expect(() => aggregateByConstructor(JSON.stringify({ snapshot: { meta: {} }, nodes: [] }))).toThrow(/Not a valid/);
  });
});

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
