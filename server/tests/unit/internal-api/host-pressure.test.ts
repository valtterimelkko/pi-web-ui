import { describe, it, expect } from 'vitest';
import { readHostPressure, parsePsiLine, parseMemInfoKb } from '../../../src/internal-api/host-pressure.js';

describe('host-pressure parser', () => {
  it('parses a PSI some/full line into avg10/avg60/avg300', () => {
    expect(parsePsiLine('some avg10=10.00 avg60=5.00 avg300=2.00 total=12345')).toEqual({
      avg10: 10, avg60: 5, avg300: 2,
    });
    expect(parsePsiLine('full avg10=0.50 avg60=0.25 avg300=0.10 total=999')).toEqual({
      avg10: 0.5, avg60: 0.25, avg300: 0.1,
    });
    expect(parsePsiLine('not a psi line')).toBeUndefined();
    expect(parsePsiLine(undefined)).toBeUndefined();
  });

  it('parses a meminfo value in kB → bytes', () => {
    expect(parseMemInfoKb('MemAvailable:  148639744 kB', 'MemAvailable')).toBe(148639744 * 1024);
    expect(parseMemInfoKb('MemTotal:       32768000 kB', 'MemTotal')).toBe(32768000 * 1024);
    expect(parseMemInfoKb('MemAvailable:  148639744 kB', 'MemTotal')).toBeUndefined();
  });
});

describe('readHostPressure', () => {
  it('reads host MemAvailable/MemTotal + memory PSI from injected files', () => {
    const files = new Map<string, string>([
      ['/proc/meminfo', 'MemTotal:       32768000 kB\nMemAvailable:  148639744 kB\n'],
      ['/proc/pressure/memory', 'some avg10=10.00 avg60=5.00 avg300=2.00 total=1\nfull avg10=1.00 avg60=0.50 avg300=0.10 total=2\n'],
      ['/proc/pressure/cpu', 'some avg10=20.00 avg60=10.00 avg300=4.00 total=3\n'],
      ['/proc/pressure/io', 'some avg10=30.00 avg60=15.00 avg300=6.00 total=4\nfull avg10=3.00 avg60=1.50 avg300=0.30 total=5\n'],
    ]);
    const r = readHostPressure({ read: (p) => files.get(p) });
    expect(r.memTotalBytes).toBe(32768000 * 1024);
    expect(r.memAvailableBytes).toBe(148639744 * 1024);
    expect(r.psi?.memory?.some).toEqual({ avg10: 10, avg60: 5, avg300: 2 });
    expect(r.psi?.memory?.full).toEqual({ avg10: 1, avg60: 0.5, avg300: 0.1 });
    expect(r.psi?.cpu?.some?.avg10).toBe(20);
    expect(r.psi?.io?.full?.avg10).toBe(3);
    expect(r.source).toBe('host');
  });

  it('does not fabricate values when files are missing', () => {
    const r = readHostPressure({ read: () => undefined });
    expect(r.memAvailableBytes).toBeUndefined();
    expect(r.memTotalBytes).toBeUndefined();
    expect(r.psi).toBeUndefined();
    expect(r.source).toBe('host');
  });

  it('parses partially — PSI present without meminfo, or vice versa', () => {
    const onlyMem = readHostPressure({ read: (p) => p === '/proc/meminfo' ? 'MemAvailable:  1000 kB\n' : undefined });
    expect(onlyMem.memAvailableBytes).toBe(1000 * 1024);
    expect(onlyMem.psi).toBeUndefined();
    const onlyPsi = readHostPressure({ read: (p) => p === '/proc/pressure/memory' ? 'some avg10=5.00 avg60=2.00 avg300=1.00 total=1\n' : undefined });
    expect(onlyPsi.psi?.memory?.some?.avg10).toBe(5);
    expect(onlyPsi.memAvailableBytes).toBeUndefined();
  });
});
