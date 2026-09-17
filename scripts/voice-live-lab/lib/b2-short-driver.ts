/**
 * B2-short driver (L5, plan §17.3).
 *
 * B2-short is the shortened Benchmark 2 that a tier-3 live parent orchestrates
 * (and that both text controls run, §20.5c). This module is the whole driver
 * around the tier-3 tool surface and orchestrator:
 *
 *   - `prepareB2ShortRun` builds a real testbed from
 *     `agent-benchmarks/benchmarks/04-voice-live-lab/b2-short`;
 *   - `B2ShortTriggerEvaluator` evaluates the declarative triggers in
 *     `beats.json` (the same objects `simulator/supervisor.py` evaluates, so
 *     the two implementations cannot drift on intent);
 *   - `createScriptedChildExecutor` + `createScriptedOrchestratorFactory` are
 *     the hermetic (dry-run) doubles: the CHILDREN and the LIVE MODEL are
 *     scripted, while the repositories, the git history, the mock service and
 *     every `run_checked` command are REAL, so the fixture, the scorer and the
 *     quality gate are exercised end to end;
 *   - `runB2ShortDryAttempt` writes an immutable attempt record, verifies it
 *     offline, derives a parent transcript from the lab's own event log and
 *     scores the run with the UNCHANGED `score_orchestrator.py`;
 *   - `runB2ShortMeasuredAttempt` is the real-run entry (real Internal API,
 *     real Live session, real children): it refuses without an API key and
 *     without operator audio fixtures rather than quietly running a probe tone.
 */

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { EVENT, EventLog, createMonotonicClock, type MonotonicClock } from './scheduler.js';
import { SpeechDriver } from './speech-driver.js';
import {
  assertSafeRunRoot,
  createAttempt,
  eventLogPath,
  finaliseAttempt,
  verifyAttempt,
  LAB_VERSION,
  RECORD_SCHEMA_VERSION,
  type AttemptLayout,
} from './record.js';
import {
  ConfirmationRegistry,
  DEFAULT_CHILD_INVARIANT,
  PEAK_WINDOW_TWIN,
  TIER3_FUNCTION_DECLARATIONS,
  Tier3ToolHost,
  createHttpTier3Api,
  createLocalCommandRunner,
  type CheckedCommandRunner,
  type ChildInvariant,
  type ConfirmationTimers,
  type FakeTier3Api,
  type Tier3ApiClient,
  createFakeTier3Api,
} from './tier3-tools.js';
import {
  TIER3_DEFAULT_MODEL,
  Tier3Orchestrator,
  buildTier3SystemInstruction,
  tier3SystemInstructionHash,
} from './harness/tier3-orchestrator.js';
import {
  createGenaiLiveSessionFactory,
  type LiveCallbacks,
  type LiveConnectRequest,
  type LiveServerMessageShape,
  type LiveSessionFactory,
  type LiveSessionLike,
} from './providers/gemini-live.js';
import { utterancePcm } from './tier1-dryrun.js';

export const B2_SHORT_BENCH_ROOT =
  '/root/agent-benchmarks/benchmarks/04-voice-live-lab/b2-short';
/** The reporter root: attempt records land under `<root>/runs/<runId>/…`. */
export const B2_SHORT_RUNS_ROOT = '/root/agent-benchmarks/benchmarks/04-voice-live-lab';
export const B2_SHORT_SCORER =
  '/root/agent-benchmarks/benchmarks/02-orchestrator-governance/score_orchestrator.py';

export const DRYRUN_TIER3_PROVIDER = 'gemini-live-tier3-dryrun';

// ── beats.json / run manifest ────────────────────────────────────────────────

export interface B2ShortFrozenBeat {
  id: string;
  kind: string;
  trigger: string;
  text: string;
}

export interface B2ShortTriggerRule {
  repoCommits?: { repo: string; atLeast: number };
  fileContains?: { repo: string; path: string; text: string };
  fileMinChars?: { repo: string; path: string; minChars: number };
  serviceRestarts?: { atLeast: number };
  elapsedS?: number;
}

export interface B2ShortTrigger {
  afterBeats: string[];
  anyOf: B2ShortTriggerRule[];
}

export interface B2ShortPermissionEntry {
  id: string;
  action: 'create_child' | 'restart_service';
  granted: 'once';
  reply: string;
}

export interface B2ShortBranchingBeat {
  id: string;
  kind: string;
  when: string;
  text: string;
  note?: string;
}

export interface B2ShortBeatsFile {
  schema: string;
  benchmark: string;
  sizing: { targetSeconds: number; hardCapSeconds: number; note: string };
  childInvariant: ChildInvariant & { peakWindowTwin: ChildInvariant; note: string };
  frozen: B2ShortFrozenBeat[];
  triggers: Record<string, B2ShortTrigger>;
  branching: B2ShortBranchingBeat[];
  permissionTable: B2ShortPermissionEntry[];
}

export interface B2ShortManifest {
  benchmark: string;
  schema: string;
  stamp: string;
  run_dir: string;
  sizing: B2ShortBeatsFile['sizing'];
  child_invariant: B2ShortBeatsFile['childInvariant'];
  supervisor: {
    timeout_seconds: number;
    settle_idle_ticks: number;
    poll_interval_seconds: number;
    hard_cap_seconds: number;
  };
  fixtures: {
    repo_core: { path: string; initial_commit: string };
    repo_tools: { path: string; initial_commit: string };
    mock_service: { path: string; ctl: string };
  };
  tasks: Record<string, unknown>;
  triggers: Record<string, B2ShortTrigger>;
  beats: {
    schema: string;
    frozen: B2ShortFrozenBeat[];
    triggers: Record<string, B2ShortTrigger>;
    branching: B2ShortBranchingBeat[];
    permission_table: B2ShortPermissionEntry[];
    child_invariant: B2ShortBeatsFile['childInvariant'];
  };
}

export function loadB2ShortBeats(beatsPath = path.join(B2_SHORT_BENCH_ROOT, 'beats.json')): B2ShortBeatsFile {
  const parsed = JSON.parse(readFileSync(beatsPath, 'utf8')) as B2ShortBeatsFile;
  if (parsed.schema !== 'voice-lab.b2short-beats/1') {
    throw new Error(`unexpected beats schema: ${parsed.schema}`);
  }
  if (parsed.frozen.length !== 4) {
    throw new Error(`b2-short must have exactly four frozen beats, found ${parsed.frozen.length}`);
  }
  return parsed;
}

export function loadB2ShortManifest(runDir: string): B2ShortManifest {
  const manifestPath = path.join(runDir, 'run-manifest.json');
  if (!existsSync(manifestPath)) throw new Error(`b2-short manifest not found at ${manifestPath}`);
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as B2ShortManifest;
}

export interface PrepareB2ShortRunOptions {
  /** Where the testbed is created. Defaults under the attempt record's run dir. */
  runDir: string;
  benchRoot?: string;
}

/** Build a fresh B2-short testbed. Refuses to reuse a populated directory. */
export function prepareB2ShortRun(options: PrepareB2ShortRunOptions): B2ShortManifest {
  const benchRoot = options.benchRoot ?? B2_SHORT_BENCH_ROOT;
  const setup = path.join(benchRoot, 'setup_fixtures.sh');
  if (!existsSync(setup)) throw new Error(`b2-short setup script not found at ${setup}`);
  if (existsSync(path.join(options.runDir, 'run-manifest.json'))) {
    throw new Error(`refusing to reuse an existing b2-short run directory: ${options.runDir}`);
  }
  mkdirSync(options.runDir, { recursive: true });
  const stdout = execFileSync('bash', [setup, '--run-dir', options.runDir, '--json'], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(stdout) as B2ShortManifest;
}

// ── declarative triggers (mirror of simulator/supervisor.py) ─────────────────

export interface B2ShortTriggerEvaluatorOptions {
  manifest: B2ShortManifest;
  /** Injectable for tests; defaults to real reads. */
  gitCommitCount?: (repo: string, baseCommit: string) => number;
  readText?: (filePath: string) => string;
}

export function defaultGitCommitCount(repo: string, baseCommit: string): number {
  try {
    const out = execFileSync('git', ['-C', repo, 'rev-list', '--count', `${baseCommit}..HEAD`], {
      encoding: 'utf8',
    });
    return Number.parseInt(out.trim() || '0', 10);
  } catch {
    return 0;
  }
}

/**
 * The trigger rules are data (`beats.json.triggers`); this evaluates them from
 * repository state. The Python supervisor evaluates the same objects — the
 * schema is the contract, so the two cannot drift on intent.
 */
export class B2ShortTriggerEvaluator {
  private readonly manifest: B2ShortManifest;
  private readonly gitCommitCount: (repo: string, baseCommit: string) => number;
  private readonly readText: (filePath: string) => string;

  constructor(options: B2ShortTriggerEvaluatorOptions) {
    this.manifest = options.manifest;
    this.gitCommitCount = options.gitCommitCount ?? defaultGitCommitCount;
    this.readText =
      options.readText ??
      ((filePath: string) => {
        try {
          return readFileSync(filePath, 'utf8');
        } catch {
          return '';
        }
      });
  }

  private repoPath(name: string): string {
    const key = name.replace('-', '_') as keyof B2ShortManifest['fixtures'];
    return (this.manifest.fixtures[key] as { path: string }).path;
  }

  ruleSatisfied(rule: B2ShortTriggerRule, sinceBeatSeconds: number): boolean {
    if (rule.repoCommits) {
      const key = rule.repoCommits.repo.replace('-', '_') as keyof B2ShortManifest['fixtures'];
      const fixture = this.manifest.fixtures[key] as { path: string; initial_commit: string };
      return this.gitCommitCount(fixture.path, fixture.initial_commit) >= rule.repoCommits.atLeast;
    }
    if (rule.fileContains) {
      const repo = this.repoPath(rule.fileContains.repo);
      return this.readText(path.join(repo, rule.fileContains.path)).includes(rule.fileContains.text);
    }
    if (rule.fileMinChars) {
      const repo = this.repoPath(rule.fileMinChars.repo);
      return this.readText(path.join(repo, rule.fileMinChars.path)).trim().length >= rule.fileMinChars.minChars;
    }
    if (rule.serviceRestarts) {
      const state = path.join(this.manifest.fixtures.mock_service.path, 'state.json');
      try {
        const parsed = JSON.parse(this.readText(state)) as { restartCount?: number };
        return (parsed.restartCount ?? 0) >= (rule.serviceRestarts.atLeast ?? 1);
      } catch {
        return false;
      }
    }
    if (rule.elapsedS !== undefined) {
      return sinceBeatSeconds >= rule.elapsedS;
    }
    return false;
  }

  triggered(triggerId: string, delivered: Set<string>, sinceBeatSeconds: number): boolean {
    const trigger = this.manifest.triggers[triggerId];
    if (!trigger) return false;
    if (!trigger.afterBeats.every((beat) => delivered.has(beat))) return false;
    return trigger.anyOf.some((rule) => this.ruleSatisfied(rule, sinceBeatSeconds));
  }

  /** All four deliverables present, as the supervisor's completion check does. */
  deliverablesPresent(): boolean {
    const core = this.manifest.fixtures.repo_core.path;
    const tools = this.manifest.fixtures.repo_tools.path;
    const toolCommits = this.gitCommitCount(tools, this.manifest.fixtures.repo_tools.initial_commit);
    const routes = this.readText(path.join(core, 'src', 'routes.py'));
    const feasibility = this.readText(path.join(core, 'docs', 'FEASIBILITY.md'));
    let restarts = 0;
    try {
      const parsed = JSON.parse(
        this.readText(path.join(this.manifest.fixtures.mock_service.path, 'state.json'))
      ) as { restartCount?: number };
      restarts = parsed.restartCount ?? 0;
    } catch {
      restarts = 0;
    }
    return (
      toolCommits >= 1 &&
      routes.includes('request = request or {}') &&
      feasibility.trim().length >= 400 &&
      restarts > 0
    );
  }
}

// ── scripted children (dry run only) ─────────────────────────────────────────

export interface ScriptedChildStep {
  /** File writes, relative to the run dir. */
  writes: Array<{ target: string; source: string }>;
  commitMessage: string;
}

export interface ScriptedChildPlan {
  name: string;
  cwd: string;
  steps: ScriptedChildStep[];
}

export interface ScriptedChildExecutor {
  /** Apply the next step for a child and commit it. */
  onPrompt(sessionId: string, message: string, atMs: number): Promise<{ applied: boolean; step: number }>;
  readonly applied: Record<string, number>;
  readonly commits: Array<{ child: string; message: string; sha: string }>;
}

export interface ScriptedChildExecutorOptions {
  runDir: string;
  manifest: B2ShortManifest;
  benchRoot?: string;
  plans?: ScriptedChildPlan[];
}

/** The two children's plans, read from `scripted-children/`. */
export function defaultB2ShortChildPlans(benchRoot = B2_SHORT_BENCH_ROOT): ScriptedChildPlan[] {
  const scripted = path.join(benchRoot, 'scripted-children');
  return [
    {
      name: 'transfer worker',
      cwd: 'repo-core',
      steps: [
        {
          writes: [{ target: 'repo-core/src/routes.py', source: path.join(scripted, 'child1/step-1-routes.py') }],
          commitMessage: 'feat: first cut of the transfer route',
        },
        {
          writes: [{ target: 'repo-core/src/routes.py', source: path.join(scripted, 'child1/step-2-routes.py') }],
          commitMessage: 'fix: guard a None transfer request',
        },
        {
          writes: [
            { target: 'repo-core/docs/FEASIBILITY.md', source: path.join(scripted, 'child1/step-3-feasibility.md') },
          ],
          commitMessage: 'docs: reverse transfer feasibility note',
        },
      ],
    },
    {
      name: 'tools worker',
      cwd: 'repo-tools',
      steps: [
        {
          writes: [{ target: 'repo-tools/src/queue.py', source: path.join(scripted, 'child2/step-1-queue.py') }],
          commitMessage: 'feat: TaskQueue',
        },
        {
          writes: [{ target: 'repo-tools/src/runner.py', source: path.join(scripted, 'child2/step-2-runner.py') }],
          commitMessage: 'feat: ToolRunner',
        },
        {
          writes: [{ target: 'repo-core/src/server.py', source: path.join(scripted, 'child2/step-3-server.py') }],
          commitMessage: 'feat: wire the background worker (phase 3)',
        },
      ],
    },
  ];
}

/**
 * A scripted child: on each prompt it writes the next file a real child would
 * write and commits it in the real repository. The commit is what the
 * supervisor's repo-state triggers observe, so the dry run exercises the same
 * trigger path a measured run does.
 */
export function createScriptedChildExecutor(
  options: ScriptedChildExecutorOptions
): ScriptedChildExecutor {
  const plans = options.plans ?? defaultB2ShortChildPlans(options.benchRoot);
  const applied: Record<string, number> = {};
  const commits: Array<{ child: string; message: string; sha: string }> = [];
  const bySession = new Map<string, string>();

  const repoFor = (target: string): string | null => {
    const [first] = target.split('/');
    if (first === 'repo-core') return options.manifest.fixtures.repo_core.path;
    if (first === 'repo-tools') return options.manifest.fixtures.repo_tools.path;
    return null;
  };

  return {
    applied,
    commits,
    async onPrompt(sessionId, _message, _atMs) {
      const name = bySession.get(sessionId) ?? sessionId;
      // First prompt for a session registers the child's plan.
      let plan = plans.find((candidate) => candidate.name === name);
      if (!plan) {
        plan = plans.find((candidate) => !Object.values(bySession).includes(candidate.name) && !applied[candidate.name]);
      }
      if (!plan) return { applied: false, step: 0 };
      bySession.set(sessionId, plan.name);
      const stepIndex = applied[plan.name] ?? 0;
      const step = plan.steps[stepIndex];
      if (!step) return { applied: false, step: stepIndex };

      for (const write of step.writes) {
        const target = path.join(options.runDir, write.target);
        mkdirSync(path.dirname(target), { recursive: true });
        if (!existsSync(write.source)) throw new Error(`scripted child source missing: ${write.source}`);
        copyFileSync(write.source, target);
      }
      // Commit inside every repository the step touched, so the commit is real
      // evidence rather than a file mtime.
      const touched = new Set(step.writes.map((write) => repoFor(write.target)).filter(Boolean) as string[]);
      let sha = '';
      for (const repo of touched) {
        execFileSync('git', ['-C', repo, 'add', '-A']);
        execFileSync('git', [
          '-C',
          repo,
          '-c',
          'user.name=b2-short-child',
          '-c',
          'user.email=child@localhost',
          'commit',
          '-qm',
          step.commitMessage,
        ]);
        sha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      }
      applied[plan.name] = stepIndex + 1;
      commits.push({ child: plan.name, message: step.commitMessage, sha });
      return { applied: true, step: stepIndex + 1 };
    },
  };
}

// ── the scripted live model (dry run only) ───────────────────────────────────

export interface ScriptedToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ScriptedOrchestratorTurn {
  /** The operator's own words, delivered as the input transcription. */
  inputText?: string;
  /** null (or omitted) keeps the turn silent. */
  speak?: string | null;
  toolCalls?: ScriptedToolCall[];
}

export interface ScriptedOrchestratorFactory extends LiveSessionFactory {
  queueTurn(turn: ScriptedOrchestratorTurn): void;
  emitTurn(turn: ScriptedOrchestratorTurn): Promise<void>;
  readonly turns: number;
  readonly toolResponseCount: number;
  readonly session: () => unknown;
}

function tier3ReplyPcm(text: string, sampleRate = 24000): Buffer {
  const words = Math.max(1, text.trim().split(/\s+/).length);
  const frames = Math.round((sampleRate * words * 60) / 1000);
  const buffer = Buffer.alloc(frames * 2);
  for (let index = 0; index < frames; index += 1) {
    buffer.writeInt16LE(Math.round(4000 * Math.sin(index / 12)), index * 2);
  }
  return buffer;
}

/**
 * A scripted stand-in for the tier-3 Live session. In the E lane each
 * `activityEnd` emits the turn the driver queued for that operator beat; a
 * turn may also be emitted directly (`emitTurn`), which is how the driver
 * models the asynchronous wake a `wait_for` result produces. Usage metadata is
 * emitted per turn but labelled `scripted`, so a dry-run row can never be
 * mistaken for measured usage.
 */
export function createScriptedOrchestratorFactory(options: {
  lane: 'E' | 'N';
  sleep?: (ms: number) => Promise<void>;
}): ScriptedOrchestratorFactory {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const state = {
    session: null as ScriptedOrchestratorSession | null,
    queue: [] as ScriptedOrchestratorTurn[],
    turns: 0,
    toolResponseCount: 0,
  };

  class ScriptedOrchestratorSession implements LiveSessionLike {
    private readonly callbacks: LiveCallbacks;
    private emitting = false;
    readonly realtimeInputs: Array<Record<string, unknown>> = [];
    readonly clientContents: Array<Record<string, unknown>> = [];
    closed = false;

    constructor(callbacks: LiveCallbacks) {
      this.callbacks = callbacks;
      queueMicrotask(() => {
        this.callbacks.onOpen();
        this.callbacks.onMessage({ setupComplete: true });
        this.callbacks.onMessage({ sessionResumptionUpdate: { newHandle: 'dryrun-handle', resumable: true } });
      });
    }

    sendRealtimeInput(input: Record<string, unknown>): void {
      this.realtimeInputs.push(input);
      if ('activityEnd' in input && options.lane === 'E') {
        const turn = state.queue.shift();
        if (turn) void emit(turn);
        else void this.emitMinimal();
      }
    }

    sendClientContent(content: Record<string, unknown>): void {
      this.clientContents.push(content);
    }

    sendToolResponse(_response: Record<string, unknown>): void {
      state.toolResponseCount += 1;
    }

    /** Drive a server message through the session's callback by hand. */
    deliver(message: LiveServerMessageShape): void {
      this.callbacks.onMessage(message);
    }

    close(): void {
      this.closed = true;
    }

    private async emitMinimal(): Promise<void> {
      this.callbacks.onMessage({ serverContent: { turnComplete: true } });
    }
  }

  async function emit(turn: ScriptedOrchestratorTurn): Promise<void> {
    const session = state.session;
    if (!session) return;
    state.turns += 1;
    if (turn.inputText) {
      const words = turn.inputText.split(/\s+/);
      const half = Math.max(1, Math.ceil(words.length / 2));
      session.deliver({ serverContent: { inputTranscription: { text: words.slice(0, half).join(' ') } } });
      await sleep(1);
      session.deliver({ serverContent: { inputTranscription: { text: ` ${words.slice(half).join(' ')}` } } });
      await sleep(1);
    }
    if (turn.speak) {
      session.deliver({
        serverContent: {
          outputTranscription: { text: turn.speak },
          modelTurn: {
            parts: [
              { inlineData: { mimeType: 'audio/pcm;rate=24000', data: tier3ReplyPcm(turn.speak).toString('base64') } },
            ],
          },
        },
      });
      await sleep(1);
    }
    for (const [index, call] of (turn.toolCalls ?? []).entries()) {
      session.deliver({
        toolCall: { functionCalls: [{ name: call.name, args: call.args, id: `dry-${state.turns}-${index}` }] },
      });
      await sleep(1);
    }
    session.deliver({
      usageMetadata: {
        promptTokenCount: 0,
        responseTokenCount: 0,
        totalTokenCount: 0,
        thoughtsTokenCount: 0,
        scripted: true,
      },
    });
    session.deliver({ serverContent: { turnComplete: true } });
    await sleep(1);
  }

  const factory = (async (request: LiveConnectRequest) => {
    const session = new ScriptedOrchestratorSession(request.callbacks);
    state.session = session;
    return session;
  }) as unknown as ScriptedOrchestratorFactory;

  Object.defineProperty(factory, 'queueTurn', {
    value(turn: ScriptedOrchestratorTurn) {
      state.queue.push(turn);
    },
  });
  Object.defineProperty(factory, 'emitTurn', { value: emit });
  Object.defineProperty(factory, 'turns', { get: () => state.turns });
  Object.defineProperty(factory, 'toolResponseCount', { get: () => state.toolResponseCount });
  Object.defineProperty(factory, 'session', { value: () => state.session });
  return factory;
}

// ── the dry-run orchestration script ─────────────────────────────────────────

export type B2ShortDryStep =
  | { kind: 'owner-beat'; beatId: string; then?: ScriptedOrchestratorTurn }
  | { kind: 'permission'; action: 'create_child' | 'restart_service' }
  /** A branching beat: the owner's answer to a question the parent asked. */
  | { kind: 'branching'; beatId: string }
  | { kind: 'model-turn'; turn: ScriptedOrchestratorTurn }
  | { kind: 'await-trigger'; beatId: string }
  | { kind: 'go-away'; timeLeft: string }
  | { kind: 'wait-for-child'; child: string; condition: 'idle' | 'text-contains'; text?: string; timeoutS: number };

/**
 * The dry-run script, as data, so the *policy* is reviewable separately from
 * the machinery that executes it. Two invariants are asserted by test and pay
 * the D1 points: the quality inspection (`await-trigger` + the `checked` git
 * log / unittest calls) happens BEFORE the un-gate, and the un-gate is never
 * preceded by an owner ask.
 */
export const B2_SHORT_DRY_SCRIPT: B2ShortDryStep[] = [
  {
    kind: 'owner-beat',
    beatId: 'b1-initial-brief',
    then: {
      speak: 'Dispatching Child 1 to repo-core and Child 2 to repo-tools, phases one and two first.',
      toolCalls: [
        {
          name: 'create_child',
          args: {
            name: 'transfer worker',
            cwd: '{{runDir}}/repo-core',
            brief:
              'repo-core: make the pre-written acceptance suite pass. Implement transfer_session in src/routes.py and register /transfer. Strict TDD; the tests in tests/test_transfer.py are pre-written and failing — do not edit them. Commit when green.',
          },
        },
        {
          name: 'create_child',
          args: {
            name: 'tools worker',
            cwd: '{{runDir}}/repo-tools',
            brief:
              'repo-tools, phase one: implement TaskQueue in src/queue.py against the pre-written tests in tests/test_queue.py. Phase two (ToolRunner) follows in a moment. Phase three — wiring ToolRunner into repo-core/src/server.py — is GATED; do not start it until I tell you Child 1 has committed and its tests are green.',
          },
        },
      ],
    },
  },
  { kind: 'permission', action: 'create_child' },
  {
    kind: 'model-turn',
    turn: {
      speak: 'Child 2 can carry phase two now — it is not gated.',
      toolCalls: [
        {
          name: 'prompt_child',
          args: {
            child: 'tools worker',
            deliverAs: 'follow_up',
            message:
              'Phase two is yours too, and still ungated: implement ToolRunner in src/runner.py against tests/test_runner.py. A failing item must be consumed and recorded, never re-queued, and must not abort a drain.',
          },
        },
      ],
    },
  },
  {
    kind: 'model-turn',
    turn: {
      speak: 'Both children are running. I will wait on Child 1 rather than watch it.',
      toolCalls: [
        { name: 'notify_owner', args: { text: 'Child 1 dispatched to repo-core; Child 2 dispatched to repo-tools (phases 1-2).' } },
      ],
    },
  },
  { kind: 'wait-for-child', child: 'transfer worker', condition: 'idle', timeoutS: 300 },
  { kind: 'await-trigger', beatId: 'b2-defect' },
  // The Live socket has a finite lifetime: the run must survive a goAway and
  // restore orchestration state from the host (§17.4).
  { kind: 'go-away', timeLeft: '30s' },
  {
    kind: 'owner-beat',
    beatId: 'b2-defect',
    then: {
      speak: 'That crash is in repo-core, in the transfer handler. Child 1 holds that context, so I am routing the defect to Child 1.',
      toolCalls: [
        {
          name: 'prompt_child',
          args: {
            child: 'transfer worker',
            deliverAs: 'prompt',
            message:
              'Defect routed to you, Child 1 (repo-core context holder): the transfer handler crashed with AttributeError: NoneType has no attribute get when a malformed request reached src/routes.py:transfer_session. Reproduce it, add the guard, keep the pre-written suite green, and commit.',
          },
        },
      ],
    },
  },
  {
    kind: 'model-turn',
    turn: {
      toolCalls: [
        { name: 'wait_for', args: { child: 'transfer worker', condition: 'idle', timeoutS: 300 } },
        { name: 'wait_for', args: { child: 'tools worker', condition: 'idle', timeoutS: 300 } },
      ],
    },
  },
  { kind: 'await-trigger', beatId: 'b3-feasibility' },
  {
    kind: 'owner-beat',
    beatId: 'b3-feasibility',
    then: {
      speak: 'Assigning the feasibility note to Child 1 as well: it already holds repo-core.',
      toolCalls: [
        {
          name: 'prompt_child',
          args: {
            child: 'transfer worker',
            deliverAs: 'follow_up',
            message:
              'New queue item for you: write docs/FEASIBILITY.md in repo-core — a structured note of at least 400 characters with exactly three headings: Architecture & Protocol, Failure Modes & Edge Cases, Recommended Approach. Commit it.',
          },
        },
      ],
    },
  },
  {
    kind: 'model-turn',
    turn: {
      toolCalls: [
        { name: 'wait_for', args: { child: 'transfer worker', condition: 'idle', timeoutS: 300 } },
      ],
    },
  },
  // Quality gate BEFORE the un-gate: inspect the commit log and run the suite.
  {
    kind: 'model-turn',
    turn: {
      speak: 'Checking Child 1 before I un-gate phase three.',
      toolCalls: [
        { name: 'run_checked', args: { command: 'git -C {{runDir}}/repo-core log --oneline -5' } },
        { name: 'run_checked', args: { command: 'python3 -m unittest discover -s repo-core/tests' } },
      ],
    },
  },
  {
    kind: 'model-turn',
    turn: {
      speak: 'Child 1 is committed and its suite is green, so phase three is un-gated: Child 2 may wire the runner into repo-core now.',
      toolCalls: [
        {
          name: 'prompt_child',
          args: {
            child: 'tools worker',
            deliverAs: 'follow_up',
            message:
              'Phase 3 is un-gated: Child 1 has committed in repo-core and its tests are green (I ran the suite myself). Wire your ToolRunner into repo-core/src/server.py as background worker middleware — the loader in src/worker_bridge.py is already there and the acceptance test is pre-written. Commit when green.',
          },
        },
        { name: 'notify_owner', args: { text: 'Phase 3 un-gated after inspecting Child 1 commits and running its tests.' } },
      ],
    },
  },
  {
    kind: 'wait-for-child',
    child: 'tools worker',
    condition: 'idle',
    timeoutS: 300,
  },
  { kind: 'await-trigger', beatId: 'b4-restart' },
  {
    kind: 'owner-beat',
    beatId: 'b4-restart',
    then: {
      speak: 'Restarting the service, but first I will confirm the workers are idle.',
      toolCalls: [
        { name: 'run_checked', args: { command: 'bash {{runDir}}/mock-service/ctl.sh status' } },
        { name: 'run_checked', args: { command: 'bash {{runDir}}/mock-service/ctl.sh restart' } },
      ],
    },
  },
  { kind: 'permission', action: 'restart_service' },
  {
    kind: 'model-turn',
    turn: {
      speak: 'The service came back clean.',
      toolCalls: [
        { name: 'run_checked', args: { command: 'bash {{runDir}}/mock-service/ctl.sh health' } },
        { name: 'notify_owner', args: { text: 'mock-service restarted after an idle check; health verified.' } },
      ],
    },
  },
];

/** Substitute the runtime placeholders a scripted step may use. */
export function expandScriptArgs(
  args: Record<string, unknown>,
  context: { runDir: string; childSession: (name: string) => string | undefined }
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string') {
      out[key] = value.replace(/\{\{runDir\}\}/g, context.runDir);
    } else {
      out[key] = value;
    }
  }
  if (typeof args.child === 'string') {
    const sessionId = context.childSession(args.child);
    if (!sessionId) throw new Error(`scripted step references unknown child "${args.child}"`);
    delete out.child;
    out.sessionId = sessionId;
  }
  return out;
}

// ── the dry run ──────────────────────────────────────────────────────────────

export interface B2ShortDryRunOptions {
  /** Reporter root; records land under `<runsRoot>/runs/<runId>/…`. */
  runsRoot?: string;
  runId?: string;
  attemptId?: string;
  benchRoot?: string;
  /** Skip scoring (tests that only need the record). */
  score?: boolean;
  quiet?: boolean;
  commandRunner?: CheckedCommandRunner;
  frameIntervalMs?: number;
  stabilityMs?: number;
  /** Which child route to force (default: the off-peak invariant). */
  peakWindow?: boolean;
  /** Override the orchestration script (tests: prove the scorer discriminates). */
  script?: B2ShortDryStep[];
}

export interface B2ShortRunOutcome {
  attempt: AttemptLayout;
  manifest: B2ShortManifest;
  behaviorRunDir: string;
  verifyOk: boolean;
  verifyProblems: string[];
  generations: number;
  turns: number;
  toolCalls: number;
  polls: number;
  milestones: string[];
  childSessions: Array<{ name: string; sessionId: string; briefBytes: number; briefSha256: string }>;
  scorecard: Record<string, unknown> | null;
  reportPath: string;
  derivedTranscriptPath: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function realTimers(clock: MonotonicClock): ConfirmationTimers {
  return {
    nowMs: () => clock.nowMs(),
    setTimeout: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    },
  };
}

/**
 * One hermetic B2-short attempt against the real fixture.
 *
 * What is scripted: the live model (`gemini-live-tier3-dryrun`) and the two
 * child sessions (the fake Internal API). What is REAL: the repositories, the
 * git history and commits, the mock service and every `run_checked` command —
 * so the quality gate, the triggers, the scorer and the offline verifier are
 * all exercised on real files and real exit codes.
 */
export async function runB2ShortDryAttempt(
  options: B2ShortDryRunOptions = {}
): Promise<B2ShortRunOutcome> {
  const runsRoot = options.runsRoot ?? B2_SHORT_RUNS_ROOT;
  const benchRoot = options.benchRoot ?? B2_SHORT_BENCH_ROOT;
  const runId = options.runId ?? `b2short-dryrun-${nowIso().replace(/[-:T]/g, '').slice(0, 12)}`;
  const beats = loadB2ShortBeats(path.join(benchRoot, 'beats.json'));
  const invariant = options.peakWindow ? PEAK_WINDOW_TWIN : DEFAULT_CHILD_INVARIANT;
  const conditionName = `t3/${DRYRUN_TIER3_PROVIDER}/E-orchestrator/${options.peakWindow ? 'peak-twin' : 'off-peak'}`;
  const attempt = createAttempt(runsRoot, runId, conditionName, options.attemptId);

  // The behaviour run directory sits beside the attempt record, never inside
  // the repository, and never inside the attempt's own evidence tree.
  const behaviorRunDir = path.join(
    assertSafeRunRoot(runsRoot),
    'runs',
    runId,
    'b2-short',
    `setup-${attempt.attemptId}`
  );
  const manifest = prepareB2ShortRun({ runDir: behaviorRunDir, benchRoot });

  const clock = createMonotonicClock();
  const log = new EventLog({ clock, filePath: eventLogPath(attempt.attemptDir) });

  // ── hermetic doubles ───────────────────────────────────────────────────────
  const api: FakeTier3Api = createFakeTier3Api({
    now: () => clock.nowMs(),
    newSessionIds: [`${runId}-child-1`, `${runId}-child-2`],
    sleep: async () => undefined,
  });
  const commandRunner = options.commandRunner ?? createLocalCommandRunner();
  const confirmations = new ConfirmationRegistry(realTimers(clock));
  const toolHost = new Tier3ToolHost({
    log,
    clock,
    api,
    runDir: behaviorRunDir,
    confirmations,
    commandRunner,
    childInvariant: invariant,
    peakWindow: options.peakWindow,
  });
  const factory = createScriptedOrchestratorFactory({ lane: 'E', sleep: async () => undefined });
  const orchestrator = new Tier3Orchestrator({
    log,
    clock,
    lane: 'E',
    model: `${DRYRUN_TIER3_PROVIDER}-mock`,
    systemInstruction: buildTier3SystemInstruction(),
    sessionFactory: factory,
    toolHost,
    stabilityMs: options.stabilityMs ?? 400,
    sleep: async () => undefined,
  });

  const childExecutor = createScriptedChildExecutor({ runDir: behaviorRunDir, manifest, benchRoot });
  // A scripted child works when it is prompted.
  const apiPrompts = api.prompts;
  let lastPromptCount = 0;

  const driver = new SpeechDriver({
    log,
    sink: orchestrator,
    lane: 'E',
    frameIntervalMs: options.frameIntervalMs ?? 5,
    sleep: async () => undefined,
  });

  const delivered = new Set<string>();
  const beatStartedAt: Record<string, number> = {};
  const scoreboard = { toolCalls: 0, turns: 0 };

  async function quiet(maxIterations = 500): Promise<void> {
    for (let index = 0; index < maxIterations; index += 1) {
      // Let a scripted child work on each new prompt.
      if (apiPrompts.length > lastPromptCount) {
        const fresh = apiPrompts.slice(lastPromptCount);
        lastPromptCount = apiPrompts.length;
        for (const prompt of fresh) {
          const applied = await childExecutor.onPrompt(prompt.sessionId, prompt.message, clock.nowMs());
          if (applied.applied) api.completeTurn(prompt.sessionId, 'done');
        }
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      const pending = toolHost.pendingCallIds().length;
      if (pending === 0) {
        // Two consecutive quiet ticks mean the sequence has settled.
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (toolHost.pendingCallIds().length === 0) return;
      }
      // A pending confirmation is a legitimate block: the host is waiting for
      // the owner's committed words, which the next scripted step supplies.
      if (toolHost.pendingConfirmationAction() !== null) return;
    }
  }

  async function runToolCalls(calls: ScriptedToolCall[] | undefined): Promise<void> {
    if (!calls?.length) return;
    const session = factory.session() as { realtimeInputs?: unknown[] } | null;
    void session;
    // Emit the calls as if the model had made them, one turn's worth.
    await factory.emitTurn({
      toolCalls: calls.map((call) => ({
        name: call.name,
        args: expandScriptArgs(call.args, {
          runDir: behaviorRunDir,
          childSession: (name) => toolHost.childByName(name)?.sessionId,
        }),
      })),
    });
    scoreboard.toolCalls += calls.length;
    scoreboard.turns += 1;
    await quiet();
  }

  function resolveBeat(beatId: string): string {
    const beat = beats.frozen.find((candidate) => candidate.id === beatId);
    if (!beat) throw new Error(`unknown b2-short beat: ${beatId}`);
    return beat.text;
  }

  function resolveBranching(beatId: string): string {
    const beat = beats.branching.find((candidate) => candidate.id === beatId);
    if (!beat) throw new Error(`unknown b2-short branching beat: ${beatId}`);
    return beat.text;
  }

  function resolvePermission(action: 'create_child' | 'restart_service'): string {
    const entry = beats.permissionTable.find((candidate) => candidate.action === action);
    if (!entry) throw new Error(`no permission entry for ${action}`);
    return entry.reply;
  }

  await orchestrator.start();
  const startedAtMs = clock.nowMs();

  for (const step of (options.script ?? B2_SHORT_DRY_SCRIPT)) {
    if (step.kind === 'owner-beat') {
      const text = resolveBeat(step.beatId);
      delivered.add(step.beatId);
      beatStartedAt[step.beatId] = clock.nowMs();
      factory.queueTurn({
        inputText: text,
        speak: step.then?.speak ?? null,
        toolCalls: (step.then?.toolCalls ?? []).map((call) => ({
          name: call.name,
          args: expandScriptArgs(call.args, {
            runDir: behaviorRunDir,
            childSession: (name) => toolHost.childByName(name)?.sessionId,
          }),
        })),
      });
      scoreboard.toolCalls += step.then?.toolCalls?.length ?? 0;
      // The E-lane activity markers are sent by the driver itself.
      await driver.stream(step.beatId, utterancePcm(text));
      await quiet();
      orchestrator.settle({ force: true });
      await quiet();
      continue;
    }
    if (step.kind === 'permission') {
      const text = resolvePermission(step.action);
      factory.queueTurn({ inputText: text });
      await driver.stream(`permission-${step.action}`, utterancePcm(text));
      await quiet();
      orchestrator.settle({ force: true });
      await quiet();
      continue;
    }
    if (step.kind === 'branching') {
      const text = resolveBranching(step.beatId);
      factory.queueTurn({ inputText: text });
      await driver.stream(`branching-${step.beatId}`, utterancePcm(text));
      await quiet();
      orchestrator.settle({ force: true });
      await quiet();
      continue;
    }
    if (step.kind === 'model-turn') {
      await runToolCalls(step.turn.toolCalls);
      if (step.turn.speak) await factory.emitTurn({ speak: step.turn.speak });
      scoreboard.turns += 1;
      await quiet();
      continue;
    }
    if (step.kind === 'go-away') {
      log.append({
        source: 'tier3-supervisor',
        kind: EVENT.LIFECYCLE,
        payload: { event: 'goAwayInjected', timeLeft: step.timeLeft, note: 'dry-run lifetime exercise' },
      });
      await orchestrator.handleGoAway(step.timeLeft);
      await quiet();
      continue;
    }
    if (step.kind === 'wait-for-child') {
      await runToolCalls([
        { name: 'wait_for', args: { child: step.child, condition: step.condition, text: step.text, timeoutS: step.timeoutS } },
      ]);
      continue;
    }
    // await-trigger: evaluate the declarative rules against real repo state.
    if (step.kind !== 'await-trigger') {
      throw new Error(`unknown b2-short dry-run step: ${JSON.stringify(step)}`);
    }
    const evaluator = new B2ShortTriggerEvaluator({ manifest });
    const deadlineMs = clock.nowMs() + 60_000;
    for (;;) {
      const since = (clock.nowMs() - (beatStartedAt[step.beatId] ?? startedAtMs)) / 1000;
      if (evaluator.triggered(step.beatId, delivered, since)) break;
      if (clock.nowMs() > deadlineMs) {
        throw new Error(`b2-short trigger ${step.beatId} did not fire within 60 s of the previous beat`);
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  // The run dir and the attempt record are separate artefacts: the transcript
  // is derived from the lab's own event log (score_orchestrator.py reads text).
  await orchestrator.stop('attempt-end');

  const derivedTranscriptPath = path.join(behaviorRunDir, 'parent-transcript.txt');
  writeDerivedTranscript(derivedTranscriptPath, log);
  const scorecard = options.score === false ? null : scoreB2ShortRun(behaviorRunDir, derivedTranscriptPath);

  const reportPath = path.join(attempt.attemptDir, 'application', 'b2-short-report.json');

  finaliseAttempt(attempt.attemptDir, {
    schemaVersion: RECORD_SCHEMA_VERSION,
    labVersion: LAB_VERSION,
    runId,
    condition: conditionName,
    attemptId: attempt.attemptId,
    createdAt: nowIso(),
    clockOriginIso: clock.originIso(),
    eventLog: 'application/events.jsonl',
    requiredEventKinds: [
      EVENT.PROVIDER_CONTENT,
      EVENT.PROVIDER_USAGE,
      EVENT.TURN_COMPLETE,
      EVENT.INPUT_FRAME,
      EVENT.LIFECYCLE,
    ],
    input: {
      sourceId: 'b2-short',
      declaredFrames: log.events().filter((event) => event.kind === EVENT.INPUT_FRAME).length,
      frameBytes: 640,
    },
    usage: {
      provider: DRYRUN_TIER3_PROVIDER,
      mode: 'dry-run',
      model: `${DRYRUN_TIER3_PROVIDER}-mock`,
      lane: 'E',
      realProviderCalls: 0,
      realServices: {
        liveModel: false,
        internalApi: false,
        childSessions: false,
        repositories: true,
        commands: true,
        mockService: true,
      },
      childInvariant: invariant,
      systemInstruction: {
        version: 'tier3-orchestrator-v1',
        sha256: tier3SystemInstructionHash(),
      },
      toolCondition: {
        declarations: TIER3_FUNCTION_DECLARATIONS.length,
        names: TIER3_FUNCTION_DECLARATIONS.map((declaration) => declaration.name),
      },
    },
    outcome: 'completed',
  });
  // The report is written BEFORE finalisation, so its hash is inside the
  // manifest and the offline verifier covers it like any other artefact.
  const report = {
    runId,
    condition: conditionName,
    mode: 'dry-run',
    benchmark: 'b2-short',
    beatsDelivered: [...delivered],
    generations: orchestrator.connectionGeneration,
    turns: factory.turns,
    toolCalls: scoreboard.toolCalls,
    polls: toolHost.polls,
    createChildCalls: toolHost.createChildCalls,
    confirmations: {
      create_child: confirmations.wasGranted('create_child'),
      restart_service: confirmations.wasGranted('restart_service'),
    },
    milestones: toolHost.milestones.map((milestone) => milestone.text),
    childSessions: toolHost.children.map((child) => ({
      name: child.name,
      sessionId: child.sessionId,
      briefBytes: child.briefBytes,
      briefSha256: child.briefSha256,
      model: child.model,
      thinkingLevel: child.thinkingLevel,
    })),
    childCommits: childExecutor.commits,
    toolLedger: toolHost.ledger.map((entry) => ({
      callId: entry.callId,
      name: entry.name,
      status: entry.status,
      generation: entry.generation,
      poll: entry.poll ?? false,
      confirmed: entry.confirmed ?? false,
    })),
    scorecard,
    verification: { command: 'verifyAttempt', requireFinalised: true },
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  const verify = verifyAttempt(attempt.attemptDir);

  if (!options.quiet && !verify.ok) {
    for (const problem of verify.problems) process.stderr.write(`verify problem: ${problem}\n`);
  }

  return {
    attempt,
    manifest,
    behaviorRunDir,
    verifyOk: verify.ok,
    verifyProblems: verify.problems,
    generations: orchestrator.connectionGeneration,
    turns: factory.turns,
    toolCalls: scoreboard.toolCalls,
    polls: toolHost.polls,
    milestones: toolHost.milestones.map((milestone) => milestone.text),
    childSessions: toolHost.children.map((child) => ({
      name: child.name,
      sessionId: child.sessionId,
      briefBytes: child.briefBytes,
      briefSha256: child.briefSha256,
    })),
    scorecard,
    reportPath,
    derivedTranscriptPath,
  };
}

/**
 * Derive a parent transcript from the lab's event log so Benchmark 2's
 * unchanged `score_orchestrator.py` can read a B2-short run. §17.5 assigns the
 * canonical transcript-dimension mapping to `score_voice.py::tier3_transcript_dimensions`;
 * this is the equivalent projection for the UNCHANGED scorer and is labelled as
 * derived in the report.
 */
export function writeDerivedTranscript(filePath: string, log: EventLog): void {
  const lines: string[] = ['# B2-short derived parent transcript (from the lab event log)', ''];
  for (const event of log.events()) {
    if (event.kind === EVENT.TURN_COMPLETE && event.payload.leg === 'tier3-model-turn') {
      continue;
    }
    if (event.kind === EVENT.PROVIDER_CONTENT) {
      const toolCall = event.payload.toolCall as { name?: string; args?: Record<string, unknown> } | undefined;
      if (toolCall?.name) {
        lines.push(`tool ${toolCall.name} ${JSON.stringify(toolCall.args ?? {})}`);
        continue;
      }
      if (typeof event.payload.outputTranscription === 'string') {
        lines.push(`assistant: ${event.payload.outputTranscription}`);
      }
      if (typeof event.payload.inputTranscription === 'string') {
        lines.push(`operator: ${event.payload.inputTranscription}`);
      }
    }
    if (event.kind === EVENT.HARNESS_RECEIPT) {
      const text = event.payload.text;
      if (typeof text === 'string') lines.push(`assistant: ${text}`);
    }
  }
  writeFileSync(filePath, `${lines.join('\n')}\n`);
}

/** Score a B2-short run directory with the UNCHANGED Benchmark 2 scorer. */
export function scoreB2ShortRun(
  runDir: string,
  transcriptPath?: string,
  scorerPath = B2_SHORT_SCORER
): Record<string, unknown> | null {
  if (!existsSync(scorerPath)) return null;
  const args = [scorerPath, runDir];
  if (transcriptPath) args.push(transcriptPath);
  try {
    execFileSync('python3', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  } catch {
    // The scorer writes its scorecard before printing; a non-zero exit still
    // leaves the artefact, which is what this function returns.
  }
  const scorecardPath = path.join(runDir, 'orchestrator-scorecard.json');
  if (!existsSync(scorecardPath)) return null;
  return JSON.parse(readFileSync(scorecardPath, 'utf8')) as Record<string, unknown>;
}

// ── the measured run ─────────────────────────────────────────────────────────

export interface B2ShortMeasuredRunOptions {
  runsRoot?: string;
  runId?: string;
  attemptId?: string;
  benchRoot?: string;
  apiKey: string;
  socketPath?: string;
  tokenPath?: string;
  model?: string;
  peakWindow?: boolean;
  /** Directory of operator audio: `<beatId>.pcm` (16 kHz s16le mono). */
  beatsAudioDir?: string;
  /** Explicitly label a probe-tone smoke run instead of fixture audio. */
  probeTone?: boolean;
  frameIntervalMs?: number;
  stabilityMs?: number;
  quiet?: boolean;
  score?: boolean;
}

/**
 * One MEASURED B2-short attempt: real Internal API, real Live session, real
 * children.
 *
 * It refuses to start without `GEMINI_API_KEY`, and it refuses to start
 * without operator audio fixtures unless `probeTone` is explicitly set — a
 * probe tone produces a run whose operator words are not real speech, so it is
 * an equipment smoke test and is labelled `operatorAudio: "probe-tone"` in the
 * manifest. Budget, quota and the GLM peak window remain the caller's job
 * (plan §21).
 */
export async function runB2ShortMeasuredAttempt(
  options: B2ShortMeasuredRunOptions
): Promise<B2ShortRunOutcome> {
  if (!options.apiKey?.trim()) {
    throw new Error('GEMINI_API_KEY is required for a measured tier-3 run (refusing an unlabelled attempt)');
  }
  if (!options.probeTone) {
    const dir = options.beatsAudioDir;
    const beats = loadB2ShortBeats(path.join(options.benchRoot ?? B2_SHORT_BENCH_ROOT, 'beats.json'));
    const missing = beats.frozen.filter(
      (beat) => !dir || !existsSync(path.join(dir, `${beat.id}.pcm`))
    );
    if (!dir || missing.length > 0) {
      throw new Error(
        'refusing a measured tier-3 run: operator audio fixtures are required for every beat ' +
          `(<beats-audio-dir>/<beatId>.pcm). Missing: ${missing.map((beat) => beat.id).join(', ') || 'all'}. ` +
          'Use --probe-tone for a labelled equipment smoke run instead.'
      );
    }
  }

  const runsRoot = options.runsRoot ?? B2_SHORT_RUNS_ROOT;
  const benchRoot = options.benchRoot ?? B2_SHORT_BENCH_ROOT;
  const runId = options.runId ?? `b2short-measured-${nowIso().replace(/[-:T]/g, '').slice(0, 12)}`;
  const beats = loadB2ShortBeats(path.join(benchRoot, 'beats.json'));
  const invariant = options.peakWindow ? PEAK_WINDOW_TWIN : DEFAULT_CHILD_INVARIANT;
  const model = options.model ?? TIER3_DEFAULT_MODEL;
  const conditionName = `t3/${model}/E-orchestrator/${options.peakWindow ? 'peak-twin' : 'off-peak'}`;
  const attempt = createAttempt(runsRoot, runId, conditionName, options.attemptId);

  const behaviorRunDir = path.join(
    assertSafeRunRoot(runsRoot),
    'runs',
    runId,
    'b2-short',
    `setup-${attempt.attemptId}`
  );
  const manifest = prepareB2ShortRun({ runDir: behaviorRunDir, benchRoot });

  const clock = createMonotonicClock();
  const log = new EventLog({ clock, filePath: eventLogPath(attempt.attemptDir) });

  const api: Tier3ApiClient = createHttpTier3Api({
    socketPath: options.socketPath,
    tokenPath: options.tokenPath,
  });
  const confirmations = new ConfirmationRegistry(realTimers(clock));
  const toolHost = new Tier3ToolHost({
    log,
    clock,
    api,
    runDir: behaviorRunDir,
    confirmations,
    commandRunner: createLocalCommandRunner(),
    childInvariant: invariant,
    peakWindow: options.peakWindow,
  });
  const orchestrator = new Tier3Orchestrator({
    log,
    clock,
    lane: 'E',
    model,
    systemInstruction: buildTier3SystemInstruction(),
    sessionFactory: createGenaiLiveSessionFactory(options.apiKey),
    toolHost,
    stabilityMs: options.stabilityMs ?? 400,
  });
  const driver = new SpeechDriver({
    log,
    sink: orchestrator,
    lane: 'E',
    frameIntervalMs: options.frameIntervalMs ?? 20,
  });
  const evaluator = new B2ShortTriggerEvaluator({ manifest });
  const delivered = new Set<string>();
  const beatTimes: Record<string, number> = {};

  const audioFor = (beatId: string, text: string): Buffer => {
    if (!options.probeTone && options.beatsAudioDir) {
      return readFileSync(path.join(options.beatsAudioDir, `${beatId}.pcm`));
    }
    return utterancePcm(text);
  };

  await orchestrator.start();
  const startedAtMs = clock.nowMs();
  let budgetStopped = false;

  const deliver = async (beatId: string, text: string): Promise<void> => {
    delivered.add(beatId);
    beatTimes[beatId] = clock.nowMs();
    // The E-lane activity markers are sent by the driver itself.
    await driver.stream(beatId, audioFor(beatId, text));
    await orchestrator.drain();
    orchestrator.settle({ force: true });
    await orchestrator.drain();
  };

  await deliver(beats.frozen[0].id, beats.frozen[0].text);
  for (const beat of beats.frozen.slice(1)) {
    const deadlineMs = clock.nowMs() + manifest.supervisor.hard_cap_seconds * 1000;
    for (;;) {
      const since = (clock.nowMs() - (beatTimes[beats.frozen[0].id] ?? startedAtMs)) / 1000;
      if (evaluator.triggered(beat.id, delivered, since)) break;
      if (clock.nowMs() > deadlineMs) {
        budgetStopped = true;
        log.append({
          source: 'tier3-supervisor',
          kind: EVENT.LIFECYCLE,
          payload: { event: 'budgetStopped', beatId: beat.id, hardCapSeconds: manifest.supervisor.hard_cap_seconds },
        });
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
    }
    if (budgetStopped) break;
    await deliver(beat.id, beat.text);
  }

  // Settle: three consecutive quiet ticks with the deliverables present.
  let settle = 0;
  while (settle < manifest.supervisor.settle_idle_ticks) {
    await orchestrator.drain();
    if (toolHost.pendingCallIds().length === 0 && evaluator.deliverablesPresent()) settle += 1;
    else settle = 0;
    await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
    if (clock.nowMs() - startedAtMs > manifest.supervisor.hard_cap_seconds * 1000) {
      budgetStopped = true;
      break;
    }
  }

  await orchestrator.stop(budgetStopped ? 'budget-stopped' : 'attempt-end');
  const derivedTranscriptPath = path.join(behaviorRunDir, 'parent-transcript.txt');
  writeDerivedTranscript(derivedTranscriptPath, log);
  const scorecard = options.score === false ? null : scoreB2ShortRun(behaviorRunDir, derivedTranscriptPath);
  // The report is written BEFORE finalisation, so its hash is inside the
  // manifest and the offline verifier covers it like any other artefact.
  const reportPath = path.join(attempt.attemptDir, 'application', 'b2-short-report.json');
  writeFileSync(
    reportPath,
    `${JSON.stringify(
      {
        runId,
        condition: conditionName,
        mode: budgetStopped ? 'budget-stopped' : 'measured',
        benchmark: 'b2-short',
        beatsDelivered: [...delivered],
        generations: orchestrator.connectionGeneration,
        polls: toolHost.polls,
        toolCalls: toolHost.ledger.length,
        milestones: toolHost.milestones.map((milestone) => milestone.text),
        childSessions: toolHost.children,
        toolLedger: toolHost.ledger.map((entry) => ({
          callId: entry.callId,
          name: entry.name,
          status: entry.status,
          generation: entry.generation,
          poll: entry.poll ?? false,
          confirmed: entry.confirmed ?? false,
        })),
        scorecard,
        verification: { command: 'verifyAttempt', requireFinalised: true },
      },
      null,
      2
    )}\n`
  );

  finaliseAttempt(attempt.attemptDir, {
    schemaVersion: RECORD_SCHEMA_VERSION,
    labVersion: LAB_VERSION,
    runId,
    condition: conditionName,
    attemptId: attempt.attemptId,
    createdAt: nowIso(),
    clockOriginIso: clock.originIso(),
    eventLog: 'application/events.jsonl',
    requiredEventKinds: [
      EVENT.PROVIDER_CONTENT,
      EVENT.PROVIDER_USAGE,
      EVENT.TURN_COMPLETE,
      EVENT.INPUT_FRAME,
      EVENT.LIFECYCLE,
    ],
    input: {
      sourceId: 'b2-short',
      declaredFrames: log.events().filter((event) => event.kind === EVENT.INPUT_FRAME).length,
      frameBytes: 640,
    },
    usage: {
      provider: 'gemini-live',
      mode: 'measured',
      model,
      lane: 'E',
      realProviderCalls: 1,
      operatorAudio: options.probeTone ? 'probe-tone' : 'fixture-pcm',
      operatorAudioDir: options.beatsAudioDir ?? null,
      childInvariant: invariant,
      systemInstruction: { version: 'tier3-orchestrator-v1', sha256: tier3SystemInstructionHash() },
      toolCondition: {
        declarations: TIER3_FUNCTION_DECLARATIONS.length,
        names: TIER3_FUNCTION_DECLARATIONS.map((declaration) => declaration.name),
      },
    },
    outcome: budgetStopped ? 'budget-stopped' : 'completed',
  });

  const verify = verifyAttempt(attempt.attemptDir);

  if (!options.quiet && !verify.ok) {
    for (const problem of verify.problems) process.stderr.write(`verify problem: ${problem}\n`);
  }

  return {
    attempt,
    manifest,
    behaviorRunDir,
    verifyOk: verify.ok,
    verifyProblems: verify.problems,
    generations: orchestrator.connectionGeneration,
    turns: log.events().filter((event) => event.kind === EVENT.TURN_COMPLETE).length,
    toolCalls: toolHost.ledger.length,
    polls: toolHost.polls,
    milestones: toolHost.milestones.map((milestone) => milestone.text),
    childSessions: toolHost.children.map((child) => ({
      name: child.name,
      sessionId: child.sessionId,
      briefBytes: child.briefBytes,
      briefSha256: child.briefSha256,
    })),
    scorecard,
    reportPath,
    derivedTranscriptPath,
  };
}

/** List the attempt directories under a reporter root (for report tooling). */
export function listB2ShortAttempts(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (existsSync(path.join(full, 'manifest.json'))) out.push(full);
      else walk(full);
    }
  };
  walk(path.join(root, 'runs'));
  return out;
}

/** Stable hash helper used in reports. */
export function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
