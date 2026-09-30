import { describe, expect, it } from 'vitest';
import { planSpawnForSession, planSpawnOwn, placementBashEnv, placementBashPrefixLine } from '../../../src/placement/spawn-wrap.js';
import { resolvePlacementConfig } from '../../../src/placement/config.js';
import { sessionGroupName } from '../../../src/placement/keys.js';

const GiB = 1024 * 1024 * 1024;
const on = () => resolvePlacementConfig({ PI_TOOLS_PLACEMENT: 'on', PI_TOOLS_CGROUP_ROOT: '/cg', PI_TOOLS_SLICE: '/cg/t.slice', PI_TOOLS_RUNTIME_DIR: '/tmp/d0-rt' });

describe('placement spawn planning', () => {
  it('returns null when placement is off (byte-identical argv contract)', () => {
    const off = resolvePlacementConfig({});
    expect(planSpawnForSession(off, { runtime: 'claude', id: 's1' }, ['/usr/bin/claude', '-p'], {})).toBeNull();
    expect(planSpawnOwn(off, ['/bin/opencode', 'serve'], {})).toBeNull();
    expect(placementBashEnv(off, 's1')).toBeNull();
  });

  it('plans a session-bound runtime spawn: wrapper argv, group env, deterministic group', () => {
    const plan = planSpawnForSession(on(), { runtime: 'claude', id: 'sess-9' }, ['/usr/bin/claude', '-p', 'hi'], { FOO: '1' });
    expect(plan).not.toBeNull();
    expect(plan!.file).toBe('/tmp/d0-rt/placement-wrapper.sh');
    expect(plan!.args).toEqual(['/usr/bin/claude', '-p', 'hi']);
    const group = sessionGroupName('rt', 'claude', 'sess-9');
    expect(plan!.group).toBe(group);
    expect(plan!.env.PI_TOOLS_CG).toBe(`/cg/t.slice/${group}`);
    expect(plan!.env.PI_TOOLS_ROOT).toBe('/cg/t.slice');
    expect(plan!.env.PI_TOOLS_MEM_MAX).toBe(String(8 * GiB));
    expect(plan!.env.PI_TOOLS_PIDS_MAX).toBe('2048');
    expect(plan!.env.FOO).toBe('1');
  });

  it('plans an own-group spawn with a unique group and a cleanup that removes it', () => {
    const cfg = on();
    const a = planSpawnOwn(cfg, ['/bin/opencode', 'serve'], {});
    const b = planSpawnOwn(cfg, ['/bin/opencode', 'serve'], {});
    expect(a!.group).not.toBe(b!.group);
    expect(a!.group.startsWith('own-')).toBe(true);
    expect(typeof a!.cleanup).toBe('function');
    // cleanup must not throw even though the group never existed
    expect(() => a!.cleanup()).not.toThrow();
  });

  it('refuses to plan a spawn whose argv would escape via the wrapper (no shell string)', () => {
    // The wrapper is exec'd directly (no shell), so argv elements are passed verbatim;
    // the guard here is that we never accept an argv containing NUL or empty file.
    expect(() => planSpawnForSession(on(), { runtime: 'claude', id: 's' }, ['', '-p'], {})).toThrow();
  });
});

describe('placement bash prefix line', () => {
  it('produces a static POSIX line driven entirely by env', () => {
    const line = placementBashPrefixLine(on());
    expect(line).toContain('PI_TOOLS_CG');
    expect(line).toContain('cgroup.procs');
    expect(line).toContain('PI_TOOLS_DEGRADE_FILE');
  });

  it('env carries the session group, limits and degrade file', () => {
    const env = placementBashEnv(on(), 'abc123');
    expect(env).not.toBeNull();
    expect(env!.PI_TOOLS_GROUP).toBe(sessionGroupName('pi', undefined, 'abc123'));
    expect(env!.PI_TOOLS_CG).toContain(env!.PI_TOOLS_GROUP);
    expect(env!.PI_TOOLS_SHELL).toBe('/bin/bash');
  });
});
