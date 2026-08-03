import { describe, expect, it } from 'vitest';
import {
  parseSelfCgroupV2,
  resolveCgroupFsPath,
  readServiceMemoryCapacity,
  readServicePidsCapacity,
} from '../../../src/internal-api/cgroup-capacity.js';

const G = 1024 * 1024 * 1024;
const ROOT = '/sys/fs/cgroup';
const SVC = `${ROOT}/system.slice/pi-web-ui.service`;

/** Builds an injected reader over a virtual file map. */
const fakeRead = (files: Record<string, string>) => (p: string): string | undefined => files[p];

describe('parseSelfCgroupV2', () => {
  it('parses a cgroup-v2 unified self line', () => {
    expect(parseSelfCgroupV2('0::/system.slice/pi-web-ui.service\n')).toBe('/system.slice/pi-web-ui.service');
  });

  it('returns undefined for v1 / non-cgroup / empty content', () => {
    expect(parseSelfCgroupV2('12:memory:/system.slice/x\n11:net_cls:/x\n')).toBeUndefined();
    expect(parseSelfCgroupV2(undefined)).toBeUndefined();
    expect(parseSelfCgroupV2('')).toBeUndefined();
  });

  it('rejects parent-directory traversal in the path', () => {
    expect(parseSelfCgroupV2('0::/system.slice/../etc/passwd')).toBeUndefined();
  });
});

describe('resolveCgroupFsPath', () => {
  it('joins the cgroup root with a nested service path', () => {
    expect(resolveCgroupFsPath(ROOT, '/system.slice/pi-web-ui.service')).toBe(SVC);
  });

  it('rejects traversal that would escape the cgroup root', () => {
    expect(resolveCgroupFsPath(ROOT, '/system.slice/../../etc')).toBeUndefined();
    expect(resolveCgroupFsPath(ROOT, '/../etc/passwd')).toBeUndefined();
    expect(resolveCgroupFsPath(ROOT, '/system.slice/..')).toBeUndefined();
  });
});

describe('readServiceMemoryCapacity', () => {
  it('prefers the service cgroup current/max over cgroup-root / host values', () => {
    const r = readServiceMemoryCapacity({
      selfCgroup: '0::/system.slice/pi-web-ui.service',
      cgroupRoot: ROOT,
      read: fakeRead({
        [`${SVC}/memory.current`]: String(3 * G),
        [`${SVC}/memory.max`]: String(12 * G),
        [`${ROOT}/memory.current`]: String(20 * G),
        [`${ROOT}/memory.max`]: String(64 * G),
      }),
    });
    expect(r).toMatchObject({ currentBytes: 3 * G, limitBytes: 12 * G, source: 'service' });
  });

  it('reports ~12 GiB for a 12 GiB service rather than host RAM', () => {
    const r = readServiceMemoryCapacity({
      selfCgroup: '0::/system.slice/pi-web-ui.service',
      cgroupRoot: ROOT,
      read: fakeRead({
        [`${SVC}/memory.current`]: String(4 * G),
        [`${SVC}/memory.max`]: String(12 * G),
      }),
    });
    expect(r.limitBytes).toBe(12 * G);
    expect(r.source).toBe('service');
  });

  it('handles memory.max=max by falling back rather than treating it as a numeric limit', () => {
    const r = readServiceMemoryCapacity({
      selfCgroup: '0::/system.slice/pi-web-ui.service',
      cgroupRoot: ROOT,
      read: fakeRead({
        [`${SVC}/memory.current`]: String(1 * G),
        [`${SVC}/memory.max`]: 'max',
        [`${ROOT}/memory.current`]: String(2 * G),
        [`${ROOT}/memory.max`]: String(48 * G),
      }),
    });
    expect(r.source).toBe('root');
    expect(r.limitBytes).toBe(48 * G);
  });

  it('falls back to cgroup-root when no service path is resolvable', () => {
    const r = readServiceMemoryCapacity({
      selfCgroup: undefined,
      cgroupRoot: ROOT,
      read: fakeRead({
        [`${ROOT}/memory.current`]: String(5 * G),
        [`${ROOT}/memory.max`]: String(30 * G),
      }),
    });
    expect(r).toMatchObject({ currentBytes: 5 * G, limitBytes: 30 * G, source: 'root' });
  });

  it('falls back to process RSS / host RAM when no cgroup telemetry is available', () => {
    const r = readServiceMemoryCapacity({ selfCgroup: undefined, cgroupRoot: ROOT, read: () => undefined });
    expect(r.source).toBe('process-rss');
    expect(r.currentBytes).toBeGreaterThan(0);
  });

  it('ignores invalid (non-numeric) telemetry instead of fabricating a limit', () => {
    const r = readServiceMemoryCapacity({
      selfCgroup: '0::/system.slice/pi-web-ui.service',
      cgroupRoot: ROOT,
      read: fakeRead({
        [`${SVC}/memory.current`]: 'garbage',
        [`${SVC}/memory.max`]: String(12 * G),
        [`${ROOT}/memory.current`]: 'nope',
        [`${ROOT}/memory.max`]: 'also-nope',
      }),
    });
    expect(r.source).toBe('process-rss');
  });

  it('exposes the service memory.high soft boundary when readable', () => {
    const r = readServiceMemoryCapacity({
      selfCgroup: '0::/system.slice/pi-web-ui.service',
      cgroupRoot: ROOT,
      read: fakeRead({
        [`${SVC}/memory.current`]: String(3 * G),
        [`${SVC}/memory.max`]: String(12 * G),
        [`${SVC}/memory.high`]: String(9 * G),
      }),
    });
    expect(r.highBytes).toBe(9 * G);
  });
});

describe('readServicePidsCapacity', () => {
  it('reads pids.current / pids.max from the service cgroup', () => {
    const r = readServicePidsCapacity({
      selfCgroup: '0::/system.slice/pi-web-ui.service',
      cgroupRoot: ROOT,
      read: fakeRead({
        [`${SVC}/pids.current`]: '622',
        [`${SVC}/pids.max`]: '768',
      }),
    });
    expect(r).toMatchObject({ current: 622, max: 768, source: 'service' });
  });

  it('surfaces pids.max=max as an unbounded (undefined) budget', () => {
    const r = readServicePidsCapacity({
      selfCgroup: '0::/system.slice/pi-web-ui.service',
      cgroupRoot: ROOT,
      read: fakeRead({ [`${SVC}/pids.current`]: '622', [`${SVC}/pids.max`]: 'max' }),
    });
    expect(r).toMatchObject({ current: 622, max: undefined, source: 'service' });
  });

  it('returns process-rss source when no PID telemetry exists', () => {
    const r = readServicePidsCapacity({ selfCgroup: undefined, cgroupRoot: ROOT, read: () => undefined });
    expect(r.source).toBe('process-rss');
  });
});
