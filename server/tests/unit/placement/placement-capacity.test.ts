import { describe, expect, it } from 'vitest';
import { readToolsSliceMemory, readDegradeCount } from '../../../src/placement/capacity.js';
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

  it('deducts inactive_file from memory.current to report working set', () => {
    const files: Record<string, string> = {
      '/cg/t.slice/memory.current': String(6.6 * 1024 * 1024 * 1024),
      '/cg/t.slice/memory.max': String(8 * 1024 * 1024 * 1024),
      '/cg/t.slice/memory.stat': 'anon 103000000\nfile 5900000000\ninactive_file 5680000000\n',
    };
    const r = readToolsSliceMemory(cfg, (f) => files[f]);
    expect(r.source).toBe('tools-slice');
    const expected = 6.6 * 1024 * 1024 * 1024 - 5680000000;
    expect(r.currentBytes).toBe(expected);
  });
});

describe('readDegradeCount (per boot)', () => {
  const bootTime = Date.parse('2026-10-02T10:00:00.000Z');
  const pastTime = '2026-10-02T09:30:00.000Z';
  const pastTime2 = '2026-10-02T09:45:00.000Z';
  const currentTime1 = '2026-10-02T10:05:00.000Z';
  const currentTime2 = '2026-10-02T10:15:00.000Z';

  it('returns 0 when file does not exist', () => {
    expect(readDegradeCount('/fake/path', () => undefined)).toBe(0);
  });

  it('filters out degrade lines from prior boots', () => {
    const content = [
      `${pastTime} group1 reason1`,
      `${pastTime2} group2 reason2`,
      `${currentTime1} group3 reason3`,
    ].join('\n');
    const count = readDegradeCount('/fake/degrade.log', { sinceMs: bootTime, read: () => content });
    expect(count).toBe(1);
  });

  it('counts all lines occurring on or after bootTime', () => {
    const content = [
      `${pastTime} group1 reason1`,
      `${currentTime1} group2 reason2`,
      `${currentTime2} group3 reason3`,
    ].join('\n');
    const count = readDegradeCount('/fake/degrade.log', { sinceMs: bootTime, read: () => content });
    expect(count).toBe(2);
  });

  it('supports sinceMs passed as 3rd arg with function 2nd arg', () => {
    const content = [
      `${pastTime} group1 reason1`,
      `${currentTime1} group2 reason2`,
    ].join('\n');
    const count = readDegradeCount('/fake/degrade.log', () => content, bootTime);
    expect(count).toBe(1);
  });
});
