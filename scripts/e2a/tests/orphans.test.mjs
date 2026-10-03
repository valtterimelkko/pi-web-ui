// E2a-3 harness tests — orphan reconciliation + cgroup parsing (arm 4) and the topology unit argv builders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProcCgroupPath, parseCgroupProcs, reconcileSurvivors, interpretSweepEffect } from '../lib/orphans.mjs';
import { buildAnchorUnitArgv, buildServerUnitArgv, buildPlacementEnvFile, serverUnitName, anchorUnitName, sliceName } from '../lib/topology.mjs';

test('parseProcCgroupPath extracts the v2 unified path', () => {
  assert.equal(parseProcCgroupPath('12:pids:/e2a-3.slice/x.service\n0::/e2a-3.slice/y.service\n'), '/e2a-3.slice/y.service');
  assert.throws(() => parseProcCgroupPath('12:pids:/only-legacy\n'), Error);
});

test('parseCgroupProcs reads pid lists', () => {
  assert.deepEqual(parseCgroupProcs('101\n202\n'), [101, 202]);
  assert.deepEqual(parseCgroupProcs(''), []);
  assert.deepEqual(parseCgroupProcs('\n'), []);
});

test('reconcileSurvivors diffs before/after pid sets per cgroup', () => {
  const before = { '/a/g1': [11, 12], '/a/g2': [13] };
  const after = { '/a/g1': [11], '/a/g2': [13, 14] };
  const r = reconcileSurvivors(before, after);
  assert.deepEqual(r.stillAlive.sort(), [11, 13]);
  assert.deepEqual(r.gone.sort(), [12]);
  assert.deepEqual(r.newcomers, [14]);
});

test('interpretSweepEffect: sweep after restart removes previously-orphaned groups', () => {
  assert.deepEqual(
    interpretSweepEffect({ orphanedBeforeRestart: [101, 102], presentAfterRestart: [] }),
    { swept: [101, 102], survived: [] },
  );
  assert.deepEqual(
    interpretSweepEffect({ orphanedBeforeRestart: [101], presentAfterRestart: [101] }),
    { swept: [], survived: [101] },
  );
});

test('topology unit names carry the e2a-3- prefix and the lane slice', () => {
  assert.match(serverUnitName(), /^e2a-3-/);
  assert.match(anchorUnitName(), /^e2a-3-/);
  assert.equal(sliceName(), 'e2a-3.slice');
});

test('buildAnchorUnitArgv pins the production-mirroring properties', () => {
  const argv = buildAnchorUnitArgv({ anchorUnit: 'e2a-3-tools-anchor.service', slice: 'e2a-3.slice' });
  const text = argv.join(' ');
  assert.ok(argv.some((a) => a.startsWith('--unit=')));
  assert.ok(text.includes('Delegate=cpu memory pids'));
  assert.ok(text.includes('DelegateSubgroup=supervisor'));
  assert.ok(text.includes('OOMPolicy=continue'));
  assert.ok(text.includes('OOMScoreAdjust=-1000'));
  assert.ok(text.includes('ExitType=cgroup'));
  assert.ok(text.includes('Restart=always'));
  assert.ok(text.includes('Slice=e2a-3.slice'));
  // the ExecStart payload re-enables controllers itself (no-internal-processes rule)
  assert.ok(text.includes('subtree_control'));
});

test('buildServerUnitArgv is contained, strips production placement env, and loads placement via env file', () => {
  const argv = buildServerUnitArgv({
    unit: 'e2a-3-server.service',
    slice: 'e2a-3.slice',
    memoryMax: '2G',
    runtimeMaxSec: 300,
    workdir: '/root/.worktrees/orch-scaling/e2-a3-pi-web-ui',
    validationDir: '/root/e2a-runs/a3/smoke/validation',
    port: 45678,
    env: { HOME: '/root/e2a-runs/a3/smoke/home', PI_CODING_AGENT_DIR: '/root/e2a-runs/a3/smoke/agent' },
    envFile: '/root/e2a-runs/a3/smoke/placement.env',
    envKeys: ['PI_TOOLS_PLACEMENT', 'PI_TOOLS_SLICE'],
  });
  const text = argv.join(' ');
  assert.ok(text.includes('MemoryMax=2G'));
  assert.ok(text.includes('RuntimeMaxSec=300'));
  assert.ok(text.includes('MemorySwapMax=1G'));
  assert.ok(text.includes('UnsetEnvironment=PI_TOOLS_PLACEMENT PI_TOOLS_SLICE PI_TOOLS_CGROUP_ROOT PI_TOOLS_RUNTIME_DIR'));
  const dirIdx = argv.indexOf('--dir');
  const portIdx = argv.indexOf('--port');
  const envFileIdx = argv.indexOf('--env-file');
  assert.equal(argv[dirIdx + 1], '/root/e2a-runs/a3/smoke/validation');
  assert.equal(argv[portIdx + 1], '45678');
  assert.equal(argv[envFileIdx + 1], '/root/e2a-runs/a3/smoke/placement.env');
  assert.equal(argv.indexOf('--compiled') > envFileIdx, true);
  assert.deepEqual(argv.filter((a) => a === '--env-key'), ['--env-key', '--env-key']);
  assert.ok(argv.includes('PI_TOOLS_PLACEMENT'));
  assert.ok(argv.includes('PI_TOOLS_SLICE'));
  // the disposable server entrypoint is referenced only as argv, never printed raw by drivers
  assert.ok(argv.includes('--compiled'));
});

test('buildPlacementEnvFile turns placement on for the lane anchor only', () => {
  const text = buildPlacementEnvFile({ slice: 'e2a-3-tools-anchor.service' });
  assert.equal(text, 'PI_TOOLS_PLACEMENT=on\nPI_TOOLS_SLICE=e2a-3-tools-anchor.service\n');
});
