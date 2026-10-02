import { describe, expect, it } from 'vitest';
import {
  parseSelfCgroupV2,
  resolveCgroupFsPath,
  readServiceMemoryCapacity,
  readServicePidsCapacity,
  readServiceMemoryEvents,
  readSplitMemoryCapacity,
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

describe('readServiceMemoryEvents', () => {
  it('parses oom / oom_kill / high counters from the service cgroup', () => {
    const r = readServiceMemoryEvents({
      selfCgroup: '0::/system.slice/pi-web-ui.service',
      cgroupRoot: ROOT,
      read: fakeRead({ [`${SVC}/memory.events`]: 'low 0\nhigh 12\noom 5\noom_kill 3\n' }),
    });
    expect(r).toMatchObject({ oom: 5, oomKill: 3, high: 12, source: 'service' });
  });

  it('returns undefined when the service cgroup cannot be resolved', () => {
    expect(readServiceMemoryEvents({ selfCgroup: undefined, cgroupRoot: ROOT, read: () => undefined })).toBeUndefined();
  });

  it('does not fabricate counters when memory.events is missing', () => {
    const r = readServiceMemoryEvents({
      selfCgroup: '0::/system.slice/pi-web-ui.service',
      cgroupRoot: ROOT,
      read: () => undefined,
    });
    expect(r).toBeUndefined();
  });
});

describe('working-set memory capacity (Criterion 5)', () => {
  it('deducts inactive_file cache from currentBytes so admission headroom is not consumed by reclaimable cache', () => {
    // 7 GiB current, 8 GiB max. Of the 7 GiB, 5.68 GiB is inactive_file cache (reclaimable).
    // Working set is 7 GiB - 5.68 GiB = 1.839... GiB.
    // Headroom against 8 GiB limit should be > 6 GiB, NOT ~1 GiB.
    const r = readServiceMemoryCapacity({
      selfCgroup: '0::/system.slice/pi-web-ui.service',
      cgroupRoot: ROOT,
      read: fakeRead({
        [`${SVC}/memory.current`]: String(7 * G),
        [`${SVC}/memory.max`]: String(8 * G),
        [`${SVC}/memory.stat`]: [
          'anon 103000000',
          'file 5900000000',
          'inactive_file 5680000000',
          'active_file 220000000',
        ].join('\n'),
      }),
    });
    expect(r.limitBytes).toBe(8 * G);
    const expectedWorkingSet = 7 * G - 5680000000;
    expect(r.currentBytes).toBe(expectedWorkingSet);
    const headroom = r.limitBytes - r.currentBytes;
    expect(headroom).toBeGreaterThan(6 * G);
  });

  it('reports high working set when anon memory is genuinely high (small inactive_file)', () => {
    // 7.5 GiB current, 8 GiB max. Anon is 7.2 GiB, inactive_file is only 100 MiB.
    // Working set is 7.5 GiB - 100 MiB = 7.4 GiB. Headroom is only ~0.6 GiB (under pressure).
    const r = readServiceMemoryCapacity({
      selfCgroup: '0::/system.slice/pi-web-ui.service',
      cgroupRoot: ROOT,
      read: fakeRead({
        [`${SVC}/memory.current`]: String(7.5 * G),
        [`${SVC}/memory.max`]: String(8 * G),
        [`${SVC}/memory.stat`]: [
          'anon 7200000000',
          'file 300000000',
          'inactive_file 100000000',
          'active_file 200000000',
        ].join('\n'),
      }),
    });
    const expectedWorkingSet = 7.5 * G - 100000000;
    expect(r.currentBytes).toBe(expectedWorkingSet);
    const headroom = r.limitBytes - r.currentBytes;
    expect(headroom).toBeLessThan(1 * G);
  });

  it('floors working set at 0 if inactive_file ever exceeds memory.current', () => {
    const r = readServiceMemoryCapacity({
      selfCgroup: '0::/system.slice/pi-web-ui.service',
      cgroupRoot: ROOT,
      read: fakeRead({
        [`${SVC}/memory.current`]: '1000',
        [`${SVC}/memory.max`]: String(8 * G),
        [`${SVC}/memory.stat`]: 'inactive_file 2000\n',
      }),
    });
    expect(r.currentBytes).toBe(0);
  });

  it('readSplitMemoryCapacity computes working set for both service and tools slice', () => {
    const TOOLS = `${ROOT}/pi-web-ui-tools.slice`;
    const r = readSplitMemoryCapacity({
      selfCgroup: '0::/system.slice/pi-web-ui.service',
      cgroupRoot: ROOT,
      toolsCgroupPath: TOOLS,
      read: fakeRead({
        [`${SVC}/memory.current`]: String(1 * G),
        [`${SVC}/memory.max`]: String(4 * G),
        [`${SVC}/memory.stat`]: 'inactive_file 200000000\n',
        [`${TOOLS}/memory.current`]: String(6.6 * G),
        [`${TOOLS}/memory.max`]: String(8 * G),
        [`${TOOLS}/memory.stat`]: 'inactive_file 5680000000\n',
      }),
    });
    const serviceWs = 1 * G - 200000000;
    const toolsWs = 6.6 * G - 5680000000;
    expect(r.tools?.currentBytes).toBe(toolsWs);
    expect(r.currentBytes).toBe(serviceWs + toolsWs);
  });
});
