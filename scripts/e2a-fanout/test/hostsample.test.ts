/**
 * E2a-4 harness host-sampling parser tests: /proc/meminfo, /proc/pressure,
 * `ps -eo pid,cgroup,args` lines and cgroup memory files. These feed arm B's
 * D0-under-load record (server cgroup vs tools slice, placement proof).
 */
import { describe, expect, it } from 'vitest';
import { parseMemAvailableKb, parsePressure, parsePsCgroupLine, filterPlacedProcs, type ProcRow } from '../lib/hostsample.ts';

describe('parseMemAvailableKb', () => {
  it('reads MemAvailable from real /proc/meminfo text', () => {
    const text = 'MemTotal:       32859295 kB\nMemFree:         1020304 kB\nMemAvailable:   18866144 kB\nSwapTotal:       8388604 kB\n';
    expect(parseMemAvailableKb(text)).toBe(18_866_144);
  });
  it('returns null when the field is missing', () => {
    expect(parseMemAvailableKb('MemTotal: 1 kB')).toBeNull();
  });
});

describe('parsePressure', () => {
  it('parses both some and full lines', () => {
    const text = 'some avg10=0.00 avg60=0.04 avg300=0.12\nfull avg10=1.52 avg60=1.30 avg300=0.88\n';
    expect(parsePressure(text)).toEqual({
      some: { avg10: 0, avg60: 0.04, avg300: 0.12 },
      full: { avg10: 1.52, avg60: 1.3, avg300: 0.88 },
    });
  });
});

const PS_SAMPLE = [
  '  PID CGROUP                                     COMMAND',
  '12345 0::/system.slice/pi-web-ui.service               node server.js',
  '12346 0::/e2a.slice/e2a-4.slice/e2a-4-tools-anchor.service/pi-abc-123  npm test',
  '12347 0::/e2a.slice/e2a-4.slice/e2a-4-tools-anchor.service/pi-def-456/supervisor vitest run',
  '  999 0::/init.scope                                 systemd',
].join('\n');

describe('ps cgroup parsing (placement proof)', () => {
  const rowsOf = (text: string): ProcRow[] =>
    text.split('\n').slice(1).map(parsePsCgroupLine).filter((r): r is ProcRow => r !== null);

  it('parses pid, cgroup and args from ps output', () => {
    const rows = rowsOf(PS_SAMPLE);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toEqual({ pid: 12_345, cgroup: '0::/system.slice/pi-web-ui.service', args: 'node server.js' });
  });

  it('filters to processes placed under the anchor fragment', () => {
    const placed = filterPlacedProcs(rowsOf(PS_SAMPLE), 'e2a-4-tools-anchor.service');
    expect(placed.map((p) => p.pid)).toEqual([12_346, 12_347]);
  });

  it('production anchor never matches the lane anchor fragment', () => {
    expect(filterPlacedProcs(rowsOf(PS_SAMPLE), 'pi-web-ui-tools-anchor.service')).toHaveLength(0);
  });
});
