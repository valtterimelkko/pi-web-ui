/** Fan-out plans: which children, on which routes, with which tasks. */
export interface ChildSpec {
  name: string;
  route: 'glm' | 'luna';
  modelSelector: string;
  thinking: string;
  cwd: string;
  owner: string;
  routeLimit: string;
  label: string;
  goalObjective?: string;
  worktreeLike?: boolean;
  taskText: string;
}

export interface Connection {
  piOrchBin: string;
  socketPath: string;
  tokenPath: string;
}

/** Plain `openai` is pay-as-you-go and forbidden by the E2 routing. */
export const NEVER_PLAIN_OPENAI = /^openai\//;

export const GLM_MODEL = 'zai/glm-5.3-flash';
export const LUNA_MODEL = 'openai-codex/gpt-6-luna';
export const GLM_ROUTE_LIMIT = `${GLM_MODEL}=10`;

const GLM_TASK =
  'Tiny task: read the file task.txt in your current working directory, then write its first line into result.txt. End your turn immediately after.';

const ARMB_GLM_TASK =
  'Work in this repository: (1) run `npm test` and note the result; ' +
  '(2) add one small function `greet(name)` that returns `hello <name>` in a new file src/greet.ts, with a test for it in test/greet.test.ts following the existing test style; ' +
  '(3) run `npm test` again and make sure the suite passes with your new test; ' +
  '(4) `git add -A && git commit -m "add greet function with test"` on the current branch. Do not push. Then end your turn.';

const ARMB_LUNA_TASK =
  'Review the last commit of this repository (git log -1 --stat plus the diff), then run the full test suite (`npm test`) TWICE and report both results. ' +
  'Write a short review of the commit (correctness, tests, risks) to review.md. Do not change any source files beyond writing review.md. Then end your turn.';

function tinyGoal(childName: string): string {
  return `Read task.txt in your cwd and write its first line to result.txt, then end. (E2a-4 harness child ${childName})`;
}

export interface ArmAPlan {
  pass1: ChildSpec[];
  pass2: ChildSpec[];
  fixtures: Array<{ dir: string; taskText: string }>;
}

/**
 * Arm A: one parent fan-out, two passes. Pass 1 is 10 sequential creates as
 * fast as pi-orch allows; pass 2 is the same 10 launched in parallel. Child 0
 * of each pass follows the owner's real pattern (goal-armed child in a
 * worktree-like cwd with the real extension set); the rest are plain.
 */
export function buildArmAPlan(opts: { passSize: number; fixtureRoot: string; owner: string }): ArmAPlan {
  const mk = (pass: 'pass1' | 'pass2', index: number): ChildSpec => {
    const name = `${pass}-${index}`;
    const cwd = `${opts.fixtureRoot}/${pass}/child-${index}`;
    const realPattern = index === 0;
    return {
      name,
      route: 'glm',
      modelSelector: GLM_MODEL,
      thinking: 'high',
      cwd,
      owner: opts.owner,
      routeLimit: GLM_ROUTE_LIMIT,
      label: `e2a-4-${name}`,
      goalObjective: realPattern ? tinyGoal(name) : undefined,
      worktreeLike: realPattern,
      taskText: GLM_TASK,
    };
  };
  const pass1 = Array.from({ length: opts.passSize }, (_, i) => mk('pass1', i));
  const pass2 = Array.from({ length: opts.passSize }, (_, i) => mk('pass2', i));
  const fixtures = [...pass1, ...pass2].map((c) => ({ dir: c.cwd, taskText: `E2a-4 harness fixture for ${c.name}\n` }));
  return { pass1, pass2, fixtures };
}

export interface ArmBPlan {
  children: ChildSpec[];
  fixtures: Array<{ dir: string; taskText: string }>;
}

/**
 * Arm B: ONE 10-child fan-out on production — 8 GLM implementers (route
 * limit 10, so the client cap is never what refuses) + 2 Luna reviewers on
 * the openai-codex route. Never plain `openai`.
 */
export function buildArmBPlan(opts: { fixtureRoot: string; owner: string }): ArmBPlan {
  const children: ChildSpec[] = [];
  for (let i = 0; i < 8; i += 1) {
    children.push({
      name: `armb-glm-${i}`,
      route: 'glm',
      modelSelector: GLM_MODEL,
      thinking: 'high',
      cwd: `${opts.fixtureRoot}/child-${i}`,
      owner: opts.owner,
      routeLimit: GLM_ROUTE_LIMIT,
      label: `e2a-4-armb-glm-${i}`,
      goalObjective: i === 0 ? 'Implement the greet function task described in your dispatch, commit, then end.' : undefined,
      worktreeLike: i === 0,
      taskText: ARMB_GLM_TASK,
    });
  }
  for (let i = 0; i < 2; i += 1) {
    children.push({
      name: `armb-luna-${i}`,
      route: 'luna',
      modelSelector: LUNA_MODEL,
      thinking: 'max',
      cwd: `${opts.fixtureRoot}/child-${8 + i}`,
      owner: opts.owner,
      routeLimit: GLM_ROUTE_LIMIT, // keeps the client GLM cap irrelevant; Luna is on its own route
      label: `e2a-4-armb-luna-${i}`,
      taskText: ARMB_LUNA_TASK,
    });
  }
  const fixtures = children.map((c) => ({ dir: c.cwd, taskText: `E2a-4 arm-B fixture for ${c.name}\n` }));
  return { children, fixtures };
}

export function spawnArgv(spec: ChildSpec, conn: Connection): string[] {
  const argv = [
    conn.piOrchBin,
    'spawn',
    '--runtime=pi',
    `--socket=${conn.socketPath}`,
    `--token-path=${conn.tokenPath}`,
    `--cwd=${spec.cwd}`,
    `--model-selector=${spec.modelSelector}`,
    `--thinking=${spec.thinking}`,
    `--owner=${spec.owner}`,
    // Space form: pi-orch's parser truncates equals-form values that
    // itself contain '=' (smoke-found: --route-limit=X=10 became X).
    '--route-limit',
    spec.routeLimit,
    `--label=${spec.label}`,
    '--no-completion-template',
    // --id-only WITHOUT --json: output() prefers --json, so --json would
    // suppress the bare-id rendering (smoke-found).
    '--id-only',
  ];
  if (spec.goalObjective !== undefined) {
    argv.push('--goal-objective', spec.goalObjective);
  }
  return argv;
}

export function promptArgv(sessionId: string, message: string, idempotencyKey: string, conn: Connection): string[] {
  return [
    conn.piOrchBin,
    'prompt',
    sessionId,
    `--socket=${conn.socketPath}`,
    `--token-path=${conn.tokenPath}`,
    // Space form: task text carries spaces and must survive parser splitting.
    '--message',
    message,
    `--idempotency-key=${idempotencyKey}`,
    '--id-only',
  ];
}

export function cleanupArgv(sessionId: string, conn: Connection, owner?: string): string[] {
  return [
    conn.piOrchBin,
    'cleanup',
    sessionId,
    ...(owner ? [`--owner=${owner}`] : []),
    `--socket=${conn.socketPath}`,
    `--token-path=${conn.tokenPath}`,
    '--json',
  ];
}

export function waitAllArgv(sessionIds: string[], deadlineS: number, conn: Connection): string[] {
  return [
    conn.piOrchBin,
    'wait',
    '--all',
    ...sessionIds,
    `--deadline=${String(deadlineS)}`,
    `--socket=${conn.socketPath}`,
    `--token-path=${conn.tokenPath}`,
    '--json',
  ];
}

export function statusByOwnerArgv(owner: string, conn: Connection): string[] {
  return [conn.piOrchBin, 'status', '--owner=' + owner, `--socket=${conn.socketPath}`, `--token-path=${conn.tokenPath}`, '--json'];
}
