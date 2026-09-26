import { describe, expect, it } from 'vitest';
import { hasEnoughFreeDisk, MIN_FREE_DISK_GB, parseDfAvailableGB } from '../../../src/live-validation/heap-soak/disk.js';

describe('disk check', () => {
  it('parses `df -Pk` output into available GB', () => {
    const output = [
      'Filesystem     1024-blocks      Used Available Capacity Mounted on',
      '/dev/sda1      1000000000 200000000 800000000      21% /',
    ].join('\n');
    expect(parseDfAvailableGB(output)).toBeCloseTo(800000000 / (1024 * 1024), 3);
  });

  it('throws on an unparseable df line', () => {
    expect(() => parseDfAvailableGB('Filesystem\n')).toThrow();
    expect(() => parseDfAvailableGB('only one line')).toThrow(/no data line/);
  });

  it('hasEnoughFreeDisk compares against the 20GB default threshold', () => {
    expect(hasEnoughFreeDisk(25)).toBe(true);
    expect(hasEnoughFreeDisk(19.9)).toBe(false);
    expect(hasEnoughFreeDisk(MIN_FREE_DISK_GB)).toBe(true);
  });
});
