import { describe, expect, it } from 'vitest';
import { readToolsSliceMemory } from '../../../src/placement/capacity.js';
import { resolvePlacementConfig } from '../../../src/placement/config.js';

const cfg = resolvePlacementConfig({ PI_TOOLS_PLACEMENT: 'on', PI_TOOLS_CGROUP_ROOT: '/cg', PI_TOOLS_SLICE: '/cg/t.slice' });

describe('tools slice memory reader', () => {
  it('reads current/high/max/events from the slice path', () => {
    const files: Record<string, string> = {
      '/cg/t.slice/memory.current': '1073741824\n',
      '/cg/t.slice/memory.high': '15032385536\n',
      '/cg/t.slice/memory.max': '19327352832\n',
      '/cg/t.slice/memory.events': 'low 0\nhigh 2\nmax 9\noom 1\noom_kill 1\n',
    };
    const r = readToolsSliceMemory(cfg, (f) => files[f]);
    expect(r.source).toBe('tools-slice');
    expect(r.currentBytes).toBe(1073741824);
    expect(r.highBytes).toBe(15032385536);
    expect(r.maxBytes).toBe(19327352832);
    expect(r.oomKill).toBe(1);
    expect(r.highEvents).toBe(2);
  });

  it('reports unavailable when the slice cannot be read (never fabricates)', () => {
    const r = readToolsSliceMemory(cfg, () => undefined);
    expect(r.source).toBe('unavailable');
    expect(r.currentBytes).toBeUndefined();
    expect(r.oomKill).toBeUndefined();
  });

  it('tolerates a missing events file but keeps memory figures', () => {
    const files: Record<string, string> = { '/cg/t.slice/memory.current': '5\n', '/cg/t.slice/memory.max': '10\n' };
    const r = readToolsSliceMemory(cfg, (f) => files[f]);
    expect(r.source).toBe('tools-slice');
    expect(r.oomKill).toBeUndefined();
  });
});
