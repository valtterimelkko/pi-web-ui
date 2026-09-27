/**
 * Retainer-path and cut analysis for `.heapsnapshot` files (B0 defect 2).
 *
 * A1's snapshot comparison was a constructor self-size diff, which cannot name
 * what RETAINS a leaked object: a constructor count of 469 tells you something
 * leaked, but not through which path. This module ports the two working
 * throwaway scripts from A1's run dir (`analysis/retainers.mjs` and
 * `analysis/cut2.mjs`) into tested code:
 *
 *  - `analyzeConstructorRetainers`: reverse-edge BFS from the root, shortest
 *    retainer chain per instance of a target constructor, grouped with counts.
 *  - `runCutTest`: re-run reachability with chosen `Ctor.prop` cuts applied,
 *    reporting the reachable bytes and target instances with and without them.
 *
 * It is pure and synchronous so it can be unit-tested on a small synthetic
 * snapshot; the real parse+analysis runs in the large-heap worker process
 * (scripts/heap-soak/snapshot-diff-worker.ts), never in the caller.
 */

export interface SnapshotMeta {
  node_fields: string[];
  edge_fields: string[];
  node_types: unknown[][];
  edge_types: unknown[][];
}

export interface ParsedHeapSnapshot {
  snapshot?: { meta?: SnapshotMeta; node_count?: number; edge_count?: number };
  nodes?: number[];
  edges?: number[];
  strings?: string[];
}

export interface SnapshotGraph {
  nodeCount: number;
  nodes: number[];
  edges: number[];
  strings: string[];
  nf: number;
  ef: number;
  nT: number;
  nN: number;
  nS: number;
  nE: number;
  eT: number;
  eN: number;
  eTo: number;
  nodeTypes: string[];
  edgeTypes: string[];
  /** Offset (in edge slots) of each node's first outgoing edge; length nodeCount + 1. */
  firstEdge: Uint32Array;
  /** Reverse-edge CSR: revFrom/revEdge for every forward edge, grouped by target node. */
  revStart: Uint32Array;
  revFrom: Uint32Array;
  revEdge: Uint32Array;
  /** BFS distance from root (node 0), skipping weak edges; -1 = unreachable. */
  dist: Int32Array;
}

/** Build the indexed graph (forward CSR, reverse CSR, root BFS distances) in one pass. */
export function buildSnapshotGraph(parsed: ParsedHeapSnapshot): SnapshotGraph {
  const meta = parsed.snapshot?.meta;
  if (!meta || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges) || !Array.isArray(parsed.strings)) {
    throw new Error('Not a valid .heapsnapshot document (missing snapshot.meta/nodes/edges/strings)');
  }
  const nodeFields = meta.node_fields ?? [];
  const edgeFields = meta.edge_fields ?? [];
  const nf = nodeFields.length || 7;
  const ef = edgeFields.length || 3;
  const { nodes, edges, strings } = parsed;
  const nodeCount = Math.floor(nodes.length / nf);

  const firstEdge = new Uint32Array(nodeCount + 1);
  const nE = nodeFields.indexOf('edge_count');
  for (let i = 0, e = 0; i < nodeCount; i++) {
    firstEdge[i] = e;
    e += (nE >= 0 ? nodes[i * nf + nE] : 0) * ef;
    firstEdge[i + 1] = e;
  }

  const eT = edgeFields.indexOf('type');
  const eN = edgeFields.indexOf('name_or_index');
  const eTo = edgeFields.indexOf('to_node');
  const edgeCount = Math.floor(edges.length / ef);

  const revCount = new Uint32Array(nodeCount + 1);
  for (let e = 0; e < edgeCount * ef; e += ef) {
    const to = edges[e + eTo] / nf;
    revCount[to] += 1;
  }
  const revStart = new Uint32Array(nodeCount + 1);
  for (let i = 0; i < nodeCount; i++) revStart[i + 1] = revStart[i] + revCount[i];
  const revFrom = new Uint32Array(edgeCount);
  const revEdge = new Uint32Array(edgeCount);
  const fill = revStart.slice();
  for (let i = 0; i < nodeCount; i++) {
    for (let e = firstEdge[i]; e < firstEdge[i + 1]; e += ef) {
      const to = edges[e + eTo] / nf;
      revFrom[fill[to]] = i;
      revEdge[fill[to]] = e;
      fill[to] += 1;
    }
  }

  const graph: SnapshotGraph = {
    nodeCount,
    nodes,
    edges,
    strings,
    nf,
    ef,
    nT: nodeFields.indexOf('type'),
    nN: nodeFields.indexOf('name'),
    nS: nodeFields.indexOf('self_size'),
    nE,
    eT,
    eN,
    eTo,
    nodeTypes: (meta.node_types?.[0] as string[] | undefined) ?? [],
    edgeTypes: (meta.edge_types?.[0] as string[] | undefined) ?? [],
    firstEdge,
    revStart,
    revFrom,
    revEdge,
    dist: new Int32Array(nodeCount).fill(-1),
  };

  // BFS from the root, skipping weak edges (a weak edge does not retain).
  const queue = new Int32Array(nodeCount);
  let head = 0;
  let tail = 0;
  graph.dist[0] = 0;
  queue[tail++] = 0;
  while (head < tail) {
    const node = queue[head++];
    for (let e = firstEdge[node]; e < firstEdge[node + 1]; e += ef) {
      if (graph.edgeTypes[edges[e + eT]] === 'weak') continue;
      const to = edges[e + eTo] / nf;
      if (graph.dist[to] < 0) {
        graph.dist[to] = graph.dist[node] + 1;
        queue[tail++] = to;
      }
    }
  }

  return graph;
}

export function nodeTypeName(graph: SnapshotGraph, nodeIndex: number): string {
  return graph.nodeTypes[graph.nodes[nodeIndex * graph.nf + graph.nT]] ?? 'unknown';
}

export function nodeName(graph: SnapshotGraph, nodeIndex: number): string {
  const ordinal = graph.nN >= 0 ? graph.nodes[nodeIndex * graph.nf + graph.nN] : -1;
  return graph.strings[ordinal] ?? '';
}

/** Node label in the retainers.mjs style: `type:name` (e.g. `object:PiService`). */
function nodeLabel(graph: SnapshotGraph, nodeIndex: number): string {
  return `${nodeTypeName(graph, nodeIndex)}:${nodeName(graph, nodeIndex).slice(0, 60)}`;
}

/** Edge label in the retainers.mjs style: `[index]` for element/hidden, else `type:name`. */
function edgeLabel(graph: SnapshotGraph, edgeOffset: number): string {
  const type = graph.edgeTypes[graph.edges[edgeOffset + graph.eT]] ?? 'unknown';
  const value = graph.edges[edgeOffset + graph.eN];
  return type === 'element' || type === 'hidden' ? `[${value}]` : `${type}:${graph.strings[value] ?? ''}`;
}

/** The property name of an edge, or undefined when it is not a named-property edge. */
function edgePropertyName(graph: SnapshotGraph, edgeOffset: number): string | undefined {
  const type = graph.edgeTypes[graph.edges[edgeOffset + graph.eT]];
  if (type !== 'property' && type !== 'shortcut') return undefined;
  return graph.strings[graph.edges[edgeOffset + graph.eN]];
}

export interface RetainerStep {
  from: string;
  edge: string;
}

export interface RetainerChainGroup {
  /** Chain rendered root→target; element/hidden indices are normalised to `[n]` for grouping. */
  chain: string;
  instances: number;
}

export interface ConstructorRetainerAnalysis {
  constructor: string;
  /** Instances of the constructor in the snapshot. */
  instances: number;
  /** Instances reachable from the root (the rest are already garbage-in-waiting). */
  reachableInstances: number;
  /** Dominant shortest retainer chains, highest instance count first. */
  chains: RetainerChainGroup[];
  /** One representative step list for the dominant chain (used to derive cut specs). */
  dominantSteps: RetainerStep[];
}

const MAX_CHAIN_HOPS = 40;

/**
 * Shortest-retainer-path analysis for one constructor. Each instance's path is
 * walked from the instance up to the root choosing, at every hop, the
 * predecessor with the smallest BFS distance (the same rule retainers.mjs
 * used). Element/hidden indices are normalised to `[n]` before grouping so
 * sibling collection entries form one chain.
 */
export function analyzeConstructorRetainers(
  graph: SnapshotGraph,
  target: string,
  options: { maxChains?: number } = {},
): ConstructorRetainerAnalysis {
  const maxChains = options.maxChains ?? 5;
  const targets: number[] = [];
  for (let i = 0; i < graph.nodeCount; i++) {
    if (nodeTypeName(graph, i) === 'object' && nodeName(graph, i) === target) targets.push(i);
  }
  const reachableInstances = targets.filter((t) => graph.dist[t] >= 0).length;

  const pathCounts = new Map<string, number>();
  const pathSteps = new Map<string, RetainerStep[]>();
  for (const targetNode of targets) {
    const steps: RetainerStep[] = [];
    let current = targetNode;
    for (let hops = 0; current !== 0 && hops < MAX_CHAIN_HOPS; hops++) {
      let best = -1;
      let bestEdge = -1;
      for (let r = graph.revStart[current]; r < graph.revStart[current + 1]; r++) {
        const from = graph.revFrom[r];
        const edge = graph.revEdge[r];
        if (graph.edgeTypes[graph.edges[edge + graph.eT]] === 'weak') continue;
        if (graph.dist[from] >= 0 && graph.dist[from] < graph.dist[current] && (best < 0 || graph.dist[from] < graph.dist[best])) {
          best = from;
          bestEdge = edge;
        }
      }
      if (best < 0) break;
      steps.push({ from: nodeLabel(graph, best), edge: edgeLabel(graph, bestEdge) });
      current = best;
    }
    steps.reverse();
    const normalized = steps.map((s) => `${s.from} --${s.edge}-->`).join('\n   ').replace(/\[\d+\]/g, '[n]').replace(/internal:\d+/g, 'internal:[n]');
    pathCounts.set(normalized, (pathCounts.get(normalized) ?? 0) + 1);
    if (!pathSteps.has(normalized)) pathSteps.set(normalized, steps);
  }

  const chains = [...pathCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxChains)
    .map(([chain, instances]) => ({ chain, instances }));

  return {
    constructor: target,
    instances: targets.length,
    reachableInstances,
    chains,
    dominantSteps: chains.length > 0 ? (pathSteps.get([...pathCounts.entries()].sort((a, b) => b[1] - a[1])[0][0]) ?? []) : [],
  };
}

/**
 * Derive `Ctor.prop` cut specs from the named-property hops of the dominant
 * chain NEAREST THE TARGET (walking the chain from the target end). The hops
 * closest to a leaked instance are the ones whose removal actually frees it:
 * in A1 those are `PiService.sessions` and `process._events`, not the noisy
 * singleton hops nearest the GC root.
 */
export function deriveCutSpecs(analysis: ConstructorRetainerAnalysis, maxSpecs = 3): string[] {
  const specs: string[] = [];
  for (let i = analysis.dominantSteps.length - 1; i >= 0; i--) {
    const step = analysis.dominantSteps[i];
    const match = step.edge.match(/^property:(.+)$/);
    if (!match) continue;
    const colon = step.from.indexOf(':');
    const constructorName = colon >= 0 ? step.from.slice(colon + 1) : step.from;
    const spec = `${constructorName}.${match[1]}`;
    if (!specs.includes(spec)) specs.push(spec);
    if (specs.length >= maxSpecs) break;
  }
  return specs;
}

export interface CutTestResult {
  cuts: string[];
  /** The subset of `cuts` that matched at least one real edge (so no-op specs are not implied). */
  appliedCuts: string[];
  /** Total self-size bytes still reachable from the root after the cuts. */
  reachableBytes: number;
  /** Instances of the target constructor still reachable after the cuts. */
  reachableInstances: number;
  /** Instances of the target constructor in the whole snapshot. */
  targetInstances: number;
  /** Dominant retainer chains among the still-reachable target instances. */
  targetPaths: RetainerChainGroup[];
}

/**
 * BFS from the root with the chosen structures cut, reporting reachable bytes
 * and (optionally) a target constructor's instances. A `Ctor.prop` cut removes
 * the object reached through that property edge — the same semantics as
 * cut2.mjs, which is what A1's sufficiency test used.
 */
export function runCutTest(
  graph: SnapshotGraph,
  cutSpecs: readonly string[],
  target = 'AgentSession',
  options: { maxPaths?: number } = {},
): CutTestResult {
  const maxPaths = options.maxPaths ?? 3;
  const cuts = new Set<number>();
  const appliedCuts: string[] = [];
  for (const spec of cutSpecs) {
    const dot = spec.indexOf('.');
    if (dot <= 0) continue;
    const constructorName = spec.slice(0, dot);
    const property = spec.slice(dot + 1);
    let matched = false;
    for (let i = 0; i < graph.nodeCount; i++) {
      if (nodeTypeName(graph, i) !== 'object' || nodeName(graph, i) !== constructorName) continue;
      for (let e = graph.firstEdge[i]; e < graph.firstEdge[i + 1]; e += graph.ef) {
        if (graph.edgeTypes[graph.edges[e + graph.eT]] === 'weak') continue;
        if (edgePropertyName(graph, e) === property) { cuts.add(graph.edges[e + graph.eTo] / graph.nf); matched = true; }
      }
    }
    if (matched) appliedCuts.push(spec);
  }

  const seen = new Int32Array(graph.nodeCount).fill(-1);
  const via = new Int32Array(graph.nodeCount).fill(-1);
  const queue = new Int32Array(graph.nodeCount);
  let head = 0;
  let tail = 0;
  seen[0] = 0;
  queue[tail++] = 0;
  while (head < tail) {
    const node = queue[head++];
    if (cuts.has(node)) continue;
    for (let e = graph.firstEdge[node]; e < graph.firstEdge[node + 1]; e += graph.ef) {
      if (graph.edgeTypes[graph.edges[e + graph.eT]] === 'weak') continue;
      const to = graph.edges[e + graph.eTo] / graph.nf;
      if (seen[to] < 0) {
        seen[to] = node;
        via[to] = e;
        queue[tail++] = to;
      }
    }
  }

  let reachableBytes = 0;
  let targetInstances = 0;
  let reachableInstances = 0;
  const pathCounts = new Map<string, number>();
  for (let i = 0; i < graph.nodeCount; i++) {
    const isTarget = nodeTypeName(graph, i) === 'object' && nodeName(graph, i) === target;
    if (isTarget) targetInstances += 1;
    if (seen[i] < 0) continue;
    reachableBytes += graph.nodes[i * graph.nf + graph.nS];
    if (!isTarget) continue;
    reachableInstances += 1;
    const steps: string[] = [];
    let current = i;
    for (let hops = 0; current !== 0 && hops < MAX_CHAIN_HOPS; hops++) {
      const parent = seen[current];
      if (parent < 0) break;
      steps.push(`${nodeLabel(graph, parent)} --${edgeLabel(graph, via[current])}-->`);
      current = parent;
    }
    steps.reverse();
    const normalized = steps.join('\n   ').replace(/\[\d+\]/g, '[n]').replace(/internal:\d+/g, 'internal:[n]');
    pathCounts.set(normalized, (pathCounts.get(normalized) ?? 0) + 1);
  }

  const targetPaths = [...pathCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxPaths)
    .map(([chain, instances]) => ({ chain, instances }));

  return { cuts: [...cutSpecs], appliedCuts, reachableBytes, reachableInstances, targetInstances, targetPaths };
}
