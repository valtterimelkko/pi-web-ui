/**
 * Minimal `.heapsnapshot` structural parser: enough to prove a snapshot file
 * "parses" (Gate 0's requirement) and to pull a couple of headline totals for
 * the report, without pulling in a full graph-analysis library. A
 * `.heapsnapshot` file is one JSON document with (at least) `snapshot`,
 * `nodes`, `edges`, and `strings` top-level fields — see V8's
 * HeapSnapshotWorker format.
 */

export interface HeapSnapshotSummary {
  nodeCount: number;
  edgeCount: number;
  totalSizeBytes: number;
}

export interface ConstructorAggregate {
  /** For type='object' nodes: the recorded constructor/class name. For every other node type: the type itself (e.g. 'string', 'array', 'closure', 'native', 'code'). */
  label: string;
  count: number;
  selfSizeBytes: number;
}

/**
 * Aggregate a heap snapshot's nodes by constructor name (object-type nodes)
 * or node type (everything else) — the standard cheap approximation used by
 * most heap-diff tools when a full retainer-graph analysis is out of scope.
 * Intended to run in a separate, large-heap Node process for a big snapshot
 * (see scripts/heap-soak/snapshot-diff-worker.ts) — this function itself is
 * pure/synchronous so it stays unit-testable without spawning anything.
 */
export function aggregateByConstructor(jsonText: string): ConstructorAggregate[] {
  const parsed = JSON.parse(jsonText) as {
    snapshot?: { meta?: { node_fields?: string[]; node_types?: unknown[][] } };
    nodes?: number[];
    strings?: string[];
  };
  if (!parsed.snapshot || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.strings)) {
    throw new Error('Not a valid .heapsnapshot document (missing snapshot/nodes/strings)');
  }
  const nodeFields = parsed.snapshot.meta?.node_fields ?? [];
  const typeIndex = nodeFields.indexOf('type');
  const nameIndex = nodeFields.indexOf('name');
  const selfSizeIndex = nodeFields.indexOf('self_size');
  const fieldCount = nodeFields.length || 7;
  const typeNames = (parsed.snapshot.meta?.node_types?.[0] as string[] | undefined) ?? [];
  const strings = parsed.strings;
  const nodes = parsed.nodes;

  const totals = new Map<string, { count: number; selfSizeBytes: number }>();
  for (let i = 0; i + fieldCount <= nodes.length; i += fieldCount) {
    const typeOrdinal = typeIndex >= 0 ? nodes[i + typeIndex] : -1;
    const typeName = typeNames[typeOrdinal] ?? `type${typeOrdinal}`;
    let label = typeName;
    if (typeName === 'object' && nameIndex >= 0) {
      const nameOrdinal = nodes[i + nameIndex];
      const constructorName = strings[nameOrdinal];
      if (constructorName) label = constructorName;
    }
    const selfSize = selfSizeIndex >= 0 ? nodes[i + selfSizeIndex] : 0;
    const entry = totals.get(label) ?? { count: 0, selfSizeBytes: 0 };
    entry.count += 1;
    entry.selfSizeBytes += selfSize;
    totals.set(label, entry);
  }
  return [...totals.entries()]
    .map(([label, v]) => ({ label, ...v }))
    .sort((a, b) => b.selfSizeBytes - a.selfSizeBytes);
}

export interface ConstructorGrowth {
  label: string;
  countBefore: number;
  countAfter: number;
  sizeBeforeBytes: number;
  sizeAfterBytes: number;
  deltaBytes: number;
}

/** Diff two aggregates (first vs last snapshot), sorted by size growth descending. */
export function diffAggregates(before: readonly ConstructorAggregate[], after: readonly ConstructorAggregate[]): ConstructorGrowth[] {
  const beforeByLabel = new Map(before.map((a) => [a.label, a]));
  const afterByLabel = new Map(after.map((a) => [a.label, a]));
  const labels = new Set([...beforeByLabel.keys(), ...afterByLabel.keys()]);
  const growth: ConstructorGrowth[] = [];
  for (const label of labels) {
    const b = beforeByLabel.get(label);
    const a = afterByLabel.get(label);
    growth.push({
      label,
      countBefore: b?.count ?? 0,
      countAfter: a?.count ?? 0,
      sizeBeforeBytes: b?.selfSizeBytes ?? 0,
      sizeAfterBytes: a?.selfSizeBytes ?? 0,
      deltaBytes: (a?.selfSizeBytes ?? 0) - (b?.selfSizeBytes ?? 0),
    });
  }
  return growth.sort((x, y) => y.deltaBytes - x.deltaBytes);
}

export function parseHeapSnapshotSummary(jsonText: string): HeapSnapshotSummary {
  const parsed = JSON.parse(jsonText) as {
    snapshot?: { meta?: { node_fields?: string[]; node_types?: unknown[] }; node_count?: number; edge_count?: number };
    nodes?: number[];
  };
  if (!parsed.snapshot || !Array.isArray(parsed.nodes)) {
    throw new Error('Not a valid .heapsnapshot document (missing snapshot/nodes)');
  }
  const nodeFields = parsed.snapshot.meta?.node_fields ?? [];
  const selfSizeIndex = nodeFields.indexOf('self_size');
  const fieldCount = nodeFields.length || 7; // V8's default node record width
  let totalSizeBytes = 0;
  if (selfSizeIndex >= 0) {
    for (let i = selfSizeIndex; i < parsed.nodes.length; i += fieldCount) {
      totalSizeBytes += parsed.nodes[i] ?? 0;
    }
  }
  return {
    nodeCount: parsed.snapshot.node_count ?? parsed.nodes.length / fieldCount,
    edgeCount: parsed.snapshot.edge_count ?? 0,
    totalSizeBytes,
  };
}
