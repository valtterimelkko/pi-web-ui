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
