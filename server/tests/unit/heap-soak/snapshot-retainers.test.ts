import { describe, expect, it } from 'vitest';
import {
  analyzeConstructorRetainers,
  buildSnapshotGraph,
  deriveCutSpecs,
  runCutTest,
  type ParsedHeapSnapshot,
} from '../../../src/live-validation/heap-soak/snapshot-retainers.js';

/**
 * Small synthetic `.heapsnapshot` (B0 defect 2). Shape:
 *
 *   root --PiService--> PiService --sessions--> Map --element 0..3--> 4x AgentSession
 *   root --Other------> Other     --sessions--> 1x AgentSession
 *
 * So five AgentSession instances in total; four are retained only through
 * `PiService.sessions`, one only through `Other.sessions`.
 */
export function fixtureSnapshot(): ParsedHeapSnapshot {
  const strings = ['', 'root', 'PiService', 'Map', 'AgentSession', 'Other', 'sessions'];
  const NF = 5;
  const nodes = [
    // type, name, id, self_size, edge_count
    0, 1, 1, 0, 2, // 0: hidden root
    3, 2, 2, 100, 1, // 1: PiService
    3, 3, 3, 50, 4, // 2: Map
    3, 4, 4, 200, 0, // 3: AgentSession
    3, 4, 5, 200, 0, // 4: AgentSession
    3, 5, 6, 30, 1, // 5: Other
    3, 4, 7, 200, 0, // 6: AgentSession
    3, 4, 8, 200, 0, // 7: AgentSession
    3, 4, 9, 200, 0, // 8: AgentSession
  ];
  const edges = [
    // type, name_or_index, to_node(offset = nodeIndex * NF)
    2, 2, 1 * NF, // root --property:PiService--> PiService
    2, 5, 5 * NF, // root --property:Other--> Other
    2, 6, 2 * NF, // PiService --property:sessions--> Map
    1, 0, 3 * NF, // Map --element:0--> AgentSession
    1, 1, 4 * NF, // Map --element:1--> AgentSession
    1, 2, 6 * NF, // Map --element:2--> AgentSession
    1, 3, 7 * NF, // Map --element:3--> AgentSession
    2, 6, 8 * NF, // Other --property:sessions--> AgentSession
  ];
  return {
    snapshot: {
      meta: {
        node_fields: ['type', 'name', 'id', 'self_size', 'edge_count'],
        node_types: [['hidden', 'array', 'string', 'object', 'code']],
        edge_fields: ['type', 'name_or_index', 'to_node'],
        edge_types: [['context', 'element', 'property', 'internal', 'shortcut', 'weak']],
      },
      node_count: nodes.length / NF,
      edge_count: edges.length / 3,
    },
    nodes,
    edges,
    strings,
  };
}

describe('analyzeConstructorRetainers', () => {
  it('names the dominant shortest retainer chain (PiService.sessions) with an instance count', () => {
    const graph = buildSnapshotGraph(fixtureSnapshot());
    const analysis = analyzeConstructorRetainers(graph, 'AgentSession');
    expect(analysis.constructor).toBe('AgentSession');
    expect(analysis.instances).toBe(5);
    expect(analysis.reachableInstances).toBe(5);
    // Four of the five hang off PiService.sessions; element indices are
    // normalised ([n]) so they group as one dominant chain.
    expect(analysis.chains[0].instances).toBe(4);
    expect(analysis.chains[0].chain).toContain('PiService');
    expect(analysis.chains[0].chain).toContain('sessions');
    expect(deriveCutSpecs(analysis)).toContain('PiService.sessions');
  });

  it('reports zero instances for a constructor that does not exist', () => {
    const graph = buildSnapshotGraph(fixtureSnapshot());
    const analysis = analyzeConstructorRetainers(graph, 'NoSuchThing');
    expect(analysis.instances).toBe(0);
    expect(analysis.chains).toEqual([]);
  });
});

describe('runCutTest', () => {
  it('reports full reachability with no cuts (baseline)', () => {
    const graph = buildSnapshotGraph(fixtureSnapshot());
    const result = runCutTest(graph, [], 'AgentSession');
    expect(result.targetInstances).toBe(5);
    expect(result.reachableInstances).toBe(5);
    expect(result.reachableBytes).toBe(1180);
  });

  it('cutting PiService.sessions frees everything held only through it', () => {
    const graph = buildSnapshotGraph(fixtureSnapshot());
    const result = runCutTest(graph, ['PiService.sessions'], 'AgentSession');
    // The cut removes what hangs BELOW PiService.sessions (cut2.mjs semantics:
    // the cut node itself — the Map — is still counted, but not expanded). So
    // only the AgentSession held via Other.sessions remains reachable:
    // root(0) + PiService(100) + Map(50) + Other(30) + that AgentSession(200) = 380.
    expect(result.reachableInstances).toBe(1);
    expect(result.reachableBytes).toBe(380);
    expect(result.targetInstances).toBe(5);
  });

  it('reports only the cuts that matched a real structure', () => {
    const graph = buildSnapshotGraph(fixtureSnapshot());
    const result = runCutTest(graph, ['PiService.sessions', 'NoSuch.prop'], 'AgentSession');
    expect(result.appliedCuts).toEqual(['PiService.sessions']);
    expect(result.reachableInstances).toBe(1);
  });
});
