/**
 * E2a-4 harness configuration tests: production-settings parsing and the
 * mirrored disposable-server env, systemd unit argv builders (names, caps,
 * placement routing), and the fan-out spawn plans (routes, limits, owner).
 */
import { describe, expect, it } from 'vitest';
import { parseSystemctlEnvironment, mirrorServerEnv, type ProductionSettingsSnapshot } from '../lib/settings.ts';
import { buildAnchorUnitArgs, buildServerUnitArgs, anchorStartScript } from '../lib/units.ts';
import { buildArmAPlan, buildArmBPlan, spawnArgv, promptArgv, cleanupArgv, waitAllArgv, NEVER_PLAIN_OPENAI } from '../lib/spawn-plan.ts';

const SNAPSHOT: ProductionSettingsSnapshot = {
  readAtMs: 1_759_459_200_000,
  mainPid: 3717595,
  source: 'unit-env + /capacity',
  values: {
    INTERNAL_API_ADMISSION_MAX_ACTIVE_TURNS: '16',
    INTERNAL_API_ADMISSION_INTERACTIVE_RESERVE: '2',
    INTERNAL_API_ADMISSION_MIN_HEADROOM_MB: '1536',
    INTERNAL_API_ADMISSION_RESERVED_MB_PER_TURN: '512',
    INTERNAL_API_ADMISSION_RESERVED_PIDS_PER_TURN: '96',
    NODE_OPTIONS: '--max-old-space-size=4096',
    PI_TOOLS_PLACEMENT: 'on',
    PI_TOOLS_SLICE: 'pi-web-ui-tools-anchor.service',
    PI_MAX_SESSIONS: '20',
  },
  capacity: {
    lagThresholdMs: 300, lagRecoveryMs: 150, lagSustainedReadings: 2,
    heapPressureFraction: 0.75, heapRecoveryFraction: 0.65, heapReservedBytesPerTurn: 67_108_864,
    maxActiveTurns: 16,
  },
};

describe('parseSystemctlEnvironment', () => {
  it('parses the real production Environment= line shape (quoted values, dots in paths)', () => {
    const env = parseSystemctlEnvironment(
      'Environment=NODE_ENV=production NODE_OPTIONS="--max-old-space-size=4096" PATH=/root/.opencode/bin:/root/.local/bin:/usr/bin:/bin PI_TOOLS_PLACEMENT=on PI_TOOLS_SLICE=pi-web-ui-tools-anchor.service',
    );
    expect(env['NODE_ENV']).toBe('production');
    expect(env['NODE_OPTIONS']).toBe('--max-old-space-size=4096');
    expect(env['PI_TOOLS_SLICE']).toBe('pi-web-ui-tools-anchor.service');
    expect(env['PATH']).toBe('/root/.opencode/bin:/root/.local/bin:/usr/bin:/bin');
  });

  it('handles single quotes and escaped spaces', () => {
    const env = parseSystemctlEnvironment(`Environment=A='x y' B=plain C="a \\"quoted\\""`);
    expect(env['A']).toBe('x y');
    expect(env['B']).toBe('plain');
    expect(env['C']).toBe('a "quoted"');
  });
});

describe('mirrorServerEnv', () => {
  const env = mirrorServerEnv(SNAPSHOT, { anchorUnit: 'e2a-4-tools-anchor.service', metricsIntervalMs: 1000, maxSessions: 40 });

  it('mirrors every production admission knob by name', () => {
    expect(env['INTERNAL_API_ADMISSION_MAX_ACTIVE_TURNS']).toBe('16');
    expect(env['INTERNAL_API_ADMISSION_INTERACTIVE_RESERVE']).toBe('2');
    expect(env['INTERNAL_API_ADMISSION_MIN_HEADROOM_MB']).toBe('1536');
    expect(env['INTERNAL_API_ADMISSION_RESERVED_MB_PER_TURN']).toBe('512');
    expect(env['INTERNAL_API_ADMISSION_RESERVED_PIDS_PER_TURN']).toBe('96');
  });

  it('pins the lag gate explicitly to the production /capacity values', () => {
    expect(env['INTERNAL_API_ADMISSION_LAG_P99_MS']).toBe('300');
    expect(env['INTERNAL_API_ADMISSION_LAG_RECOVERY_MS']).toBe('150');
    expect(env['INTERNAL_API_ADMISSION_LAG_SUSTAINED_READINGS']).toBe('2');
    expect(env['INTERNAL_API_ADMISSION_HEAP_RESERVED_MB_PER_TURN']).toBe('64');
  });

  it('routes placement at our OWN anchor, not production’s', () => {
    expect(env['PI_TOOLS_PLACEMENT']).toBe('on');
    expect(env['PI_TOOLS_SLICE']).toBe('e2a-4-tools-anchor.service');
    expect(env['PI_TOOLS_SLICE']).not.toBe(SNAPSHOT.values['PI_TOOLS_SLICE']);
  });

  it('keeps production’s heap cap and states its measurement deviations', () => {
    expect(env['NODE_OPTIONS']).toBe('--max-old-space-size=4096');
    expect(env['OBSERVABILITY_METRICS_INTERVAL_MS']).toBe('1000'); // production runs 30000
    expect(env['PI_MAX_SESSIONS']).toBe('40'); // headroom so session-count refusals cannot masquerade as lag-gate refusals
  });
});

describe('unit argv builders', () => {
  it('anchor mirrors the D0 deploy unit and stays inside the lane slice', () => {
    const argv = buildAnchorUnitArgs({ unit: 'e2a-4-tools-anchor.service', slice: 'e2a-4.slice', scriptPath: '/run/root/anchor-start.sh' });
    const text = argv.join(' ');
    expect(argv[0]).toBe('systemd-run');
    expect(text).toContain('--unit=e2a-4-tools-anchor.service');
    expect(text).toContain('--slice=e2a-4.slice');
    expect(text).toContain('DelegateSubgroup=supervisor');
    expect(text).toContain('OOMPolicy=continue');
    expect(text).toContain('OOMScoreAdjust=-1000');
    expect(text).toContain('ExitType=cgroup');
    // The start script lives in a file: a transient unit's ExecStart argv must
    // carry no `$` (systemd would expand it); the file content carries it.
    expect(text).not.toContain('$');
    const script = anchorStartScript();
    expect(script).toContain('cgroup.subtree_control');
    expect(script).toContain('sleep infinity');
    expect(script).toContain('r=/sys/fs/cgroup$(sed');
    expect(script).toContain('/supervisor$');
  });

  it('server unit is bounded, named e2a-4-*, placement-routed at the own anchor, and strips inherited PI_TOOLS_*', () => {
    const env = mirrorServerEnv(SNAPSHOT, { anchorUnit: 'e2a-4-tools-anchor.service', metricsIntervalMs: 1000, maxSessions: 40 });
    const argv = buildServerUnitArgs({
      unit: 'e2a-4-arm-a-server', slice: 'e2a-4.slice', worktreeRoot: '/root/.worktrees/orch-scaling/e2-a4-pi-web-ui',
      validationDir: '/root/e2a-runs/a4/arm-a/server', httpPort: 45671, memoryMax: '8G', runtimeMaxSec: 3600, env,
    });
    const text = argv.join(' ');
    expect(text).toContain('--unit=e2a-4-arm-a-server');
    expect(text).toContain('--slice=e2a-4.slice');
    expect(text).toContain('MemoryMax=8G');
    expect(text).toContain('MemorySwapMax=1G');
    expect(text).toContain('RuntimeMaxSec=3600');
    expect(text).toContain('TasksMax=8192');
    expect(text).toContain('UnsetEnvironment=PI_TOOLS_PLACEMENT PI_TOOLS_SLICE PI_TOOLS_CGROUP_ROOT PI_TOOLS_RUNTIME_DIR');
    expect(text).toContain('--setenv=PI_TOOLS_SLICE=e2a-4-tools-anchor.service');
    expect(text).toContain('--compiled');
    expect(text).toMatch(/--dir \/root\/e2a-runs\/a4\/arm-a\/server/);
    expect(text).toMatch(/--port 45671/);
  });
});

describe('arm-A spawn plan', () => {
  const plan = buildArmAPlan({ passSize: 10, fixtureRoot: '/root/e2a-runs/a4/arm-a/fixtures', owner: 'orch-e2-0798cc10-E2a-4-fan' });

  it('has two passes of 10 children each, with distinct fixture dirs', () => {
    expect(plan.pass1).toHaveLength(10);
    expect(plan.pass2).toHaveLength(10);
    const dirs = [...plan.pass1, ...plan.pass2].map((c) => c.cwd);
    expect(new Set(dirs).size).toBe(20);
  });

  it('uses the zai route at high effort with the route cap raised out of the way', () => {
    for (const child of [...plan.pass1, ...plan.pass2]) {
      expect(child.modelSelector).toBe('zai/glm-5.3-flash');
      expect(child.thinking).toBe('high');
      expect(child.routeLimit).toBe('zai/glm-5.3-flash=10');
      expect(child.owner).toBe('orch-e2-0798cc10-E2a-4-fan');
    }
  });

  it('puts child 0 of each pass in the owner’s real pattern (goal-armed, worktree-like cwd)', () => {
    for (const pass of [plan.pass1, plan.pass2]) {
      expect(pass[0]?.goalObjective).toBeTruthy();
      expect(pass[0]?.worktreeLike).toBe(true);
      expect(pass[1]?.goalObjective).toBeUndefined();
    }
  });

  it('spawn argv goes through pi-orch with socket/token, json output and no completion template', () => {
    const argv = spawnArgv(plan.pass1[0]!, {
      piOrchBin: '/root/pi-orch/bin/pi-orch', socketPath: '/tmp/s.sock', tokenPath: '/tmp/s.tok',
    });
    const text = argv.join(' ');
    expect(argv[0]).toBe('/root/pi-orch/bin/pi-orch');
    expect(text).toContain('spawn');
    expect(text).toContain('--socket=/tmp/s.sock');
    expect(text).toContain('--token-path=/tmp/s.tok');
    expect(text).toContain("--model-selector=zai/glm-5.3-flash");
    expect(text).toContain('--thinking=high');
    expect(text).toMatch(/--route-limit zai\/glm-5\.3-flash=10( |$)/);
    expect(text).toContain('--owner=orch-e2-0798cc10-E2a-4-fan');
    expect(text).toContain('--no-completion-template');
    expect(text).toContain('--id-only');
    expect(text).not.toContain(' --json');
  });

  it('prompt/cleanup/wait argv target the right session and dispatch detached with idempotency keys', () => {
    const conn = { piOrchBin: '/root/pi-orch/bin/pi-orch', socketPath: '/tmp/s.sock', tokenPath: '/tmp/s.tok' };
    const prompt = promptArgv('sess-1', 'do the tiny task', 'e2a4-prompt-1', conn).join(' ');
    expect(prompt).toContain('prompt sess-1');
    expect(prompt).toContain('--message do the tiny task');
    expect(prompt).toContain('--idempotency-key=e2a4-prompt-1');
    expect(prompt).not.toContain('--no-detach');
    expect(cleanupArgv('sess-1', conn, 'orch-e2-0798cc10-E2a-4-fan').join(' ')).toContain('--owner=orch-e2-0798cc10-E2a-4-fan');
    const wait = waitAllArgv(['a', 'b'], 120, conn).join(' ');
    expect(wait).toContain('--all a b');
    expect(wait).toContain('--deadline=120');
  });
});

describe('arm-B spawn plan (E2a-2 production fan-out)', () => {
  const plan = buildArmBPlan({ fixtureRoot: '/root/e2a-runs/a4/fixtures', owner: 'orch-e2-0798cc10-E2a-4-fan' });

  it('is 8 GLM children + 2 Luna children on their own routes', () => {
    const glm = plan.children.filter((c) => c.route === 'glm');
    const luna = plan.children.filter((c) => c.route === 'luna');
    expect(glm).toHaveLength(8);
    expect(luna).toHaveLength(2);
    for (const c of glm) {
      expect(c.modelSelector).toBe('zai/glm-5.3-flash');
      expect(c.thinking).toBe('high');
    }
    for (const c of luna) {
      expect(c.modelSelector).toBe('openai-codex/gpt-6-luna');
      expect(c.thinking).toBe('max');
    }
    expect(new Set(plan.children.map((c) => c.cwd)).size).toBe(10);
  });

  it('never uses the plain openai (PAYG) provider', () => {
    for (const c of plan.children) {
      expect(NEVER_PLAIN_OPENAI.test(c.modelSelector)).toBe(false);
    }
  });

  it('GLM children get the implement task, Luna children the review task', () => {
    expect(plan.children.filter((c) => c.route === 'glm').every((c) => c.taskText.includes('npm test') && c.taskText.includes('commit'))).toBe(true);
    expect(plan.children.filter((c) => c.route === 'luna').every((c) => c.taskText.includes('review') && c.taskText.toLowerCase().includes('twice'))).toBe(true);
  });
});
