import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePlacementConfig } from '../../../src/placement/config.js';
import { applyStartupPlacement, placementForSpawn, resetAppliedPlacement, getAppliedPlacement } from '../../../src/placement/apply-startup.js';
import { planSpawnForSession, placementBashEnv } from '../../../src/placement/spawn-wrap.js';
import { sessionGroupName } from '../../../src/placement/keys.js';

/**
 * Correction-08 finding 1: with the ROLLOUT setting (PI_TOOLS_SLICE=<slice NAME>),
 * every spawn path must run on the root resolved at start-up. RED (pre-fix): no
 * production call site consumed the applied resolution — placement reported "on"
 * while every server-spawned command stayed unplaced.
 *
 * The host's systemctl guard refuses mutating verbs during test runs, so REAL
 * systemd name resolution is exercised by the decisive LIVE check (correction-08
 * item 5). This test injects the resolution dependency; the WIRING under test —
 * the actual start-up function (applyStartupPlacement, as called by index.ts),
 * pi-service's real bash-tool builder and the runtime launch helpers — is
 * identical to production.
 */

const SLICE_NAME = 'd0-test-tools.slice';
const RESOLVED = '/sys/fs/cgroup/pi.slice/d0.slice/d0-test.slice/d0-test-tools.slice';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

function fakeDeps() {
  return {
    systemctlShowControlGroup: () => '/pi.slice/d0.slice/d0-test.slice/d0-test-tools.slice',
    exists: (p: string) => p === RESOLVED || p.startsWith(RESOLVED + '/'),
    readFirstLine: (f: string) =>
      f.endsWith('d0-test-tools.slice/cgroup.controllers')
        ? 'cpu memory pids\n'
        : f.endsWith('d0-test-tools.slice/memory.max')
          ? '1073741824\n'
          : undefined,
  };
}

describe('correction-08 finding 1: the resolved root reaches every spawn path', () => {
  beforeEach(() => {
    resetAppliedPlacement();
  });
  afterAll(() => {
    resetAppliedPlacement();
  });

  it('REAL CALL PATH: name → resolution → every spawn site wrapped', async () => {
    const cfg = resolvePlacementConfig({ PI_TOOLS_PLACEMENT: 'on', PI_TOOLS_SLICE: SLICE_NAME });
    expect(cfg.toolsRoot).toBeUndefined(); // a name alone resolves nothing

    // the actual start-up function used by index.ts
    const applied = applyStartupPlacement(cfg, fakeDeps());
    expect(applied.active).toBe(true);
    expect(applied.config.toolsRoot).toBe(RESOLVED);
    expect(placementForSpawn()).not.toBeNull();

    // (i) the Pi session's bash tool through pi-service's real builder
    const { buildPlacementBashTools } = await import('../../../src/pi/pi-service.js');
    const tools = buildPlacementBashTools('01a0f2a6-real-call', '/tmp', undefined);
    expect(tools).toBeDefined();
    expect(tools!.length).toBe(1);
    expect(tools![0].name).toBe('bash');
    const env = placementBashEnv(applied.config, '01a0f2a6-real-call');
    expect(env?.PI_TOOLS_CG).toBe(`${RESOLVED}/${sessionGroupName('pi', undefined, '01a0f2a6-real-call')}`);

    // (ii) the runtime launch helpers on the same applied config
    for (const runtime of ['claude', 'opencode', 'antigravity', 'commandcode', 'pi-parallel']) {
      const plan = planSpawnForSession(placementForSpawn()!, { kind: 'rt', runtime, id: 'sess-9' }, ['/bin/true', '--x'], {});
      expect(plan, runtime).not.toBeNull();
      expect(plan!.env.PI_TOOLS_CG).toBe(`${RESOLVED}/${sessionGroupName('rt', runtime, 'sess-9')}`);
      expect(plan!.env.PI_TOOLS_ROOT).toBe(RESOLVED);
    }
  }, 30_000);

  it('before start-up applies, spawn paths are unavailable (null → byte-identical fallback)', () => {
    resetAppliedPlacement(); // order-independent: no application in this test
    expect(placementForSpawn()).toBeNull();
    // A NAME-based env still must not spawn: without the applied resolution there is no root.
    expect(planSpawnForSession(resolvePlacementConfig({ PI_TOOLS_PLACEMENT: 'on', PI_TOOLS_SLICE: SLICE_NAME }), { kind: 'rt', runtime: 'claude', id: 's' }, ['/bin/true'], {})).toBeNull();
  });

  it('SOURCE PIN: no spawn-path file re-resolves the config (E1: claims every path, wires one)', () => {
    const spawnPathFiles = [
      'server/src/pi/pi-service.ts',
      'server/src/claude/claude-process-pool.ts',
      'server/src/claude/claude-channel-process-manager.ts',
      'server/src/opencode/opencode-process-manager.ts',
      'server/src/opencode/opencode-service.ts',
      'server/src/command-code/command-code-process-runner.ts',
      'server/src/command-code/command-code-model-catalog.ts',
      'server/src/antigravity/agy-stream-process.ts',
      'server/src/antigravity/antigravity-service.ts',
      'server/src/pi/parallel/session-orchestrator.ts',
      'server/src/pi/multi-session-manager.ts',
    ];
    const offenders = spawnPathFiles.filter((f) => fs.readFileSync(path.join(REPO_ROOT, f), 'utf8').includes('resolvePlacementConfig('));
    expect(offenders).toEqual([]);
  });
});
