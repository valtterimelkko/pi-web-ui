/**
 * Tier 3 tool surface (L5, plan §17.2) — contract tests.
 *
 * Everything here runs offline: no socket, no model, no child session and no
 * service. What is pinned:
 *
 *   - the seven declared functions, all NON_BLOCKING, with a stable condition
 *     hash and Zod-validated arguments (a bad argument is a refusal, never a
 *     throw);
 *   - the `run_checked` allow-list grammar — including every refusal that
 *     matters (metacharacters, paths outside the run dir, `git` without `-C`,
 *     `ctl.sh` verbs);
 *   - the polling rule (two reads inside 30 s without an intervening
 *     `wait_for`), and that a `wait_for` clears it;
 *   - the confirmation protocol: the model's claim grants nothing, only a
 *     committed `confirm` does, and the 60 s window lapses to
 *     `refused: no-confirmation`;
 *   - the tool host's ledger, forced child invariant, brief recording and
 *     reconnect snapshot.
 */
import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  CONFIRMATION_WINDOW_MS,
  ConfirmationRegistry,
  DEFAULT_CHILD_INVARIANT,
  PEAK_WINDOW_TWIN,
  POLL_WINDOW_MS,
  PollTracker,
  TIER3_FUNCTION_DECLARATIONS,
  TIER3_RESPONSE_SCHEDULING,
  TIER3_TOOL_NAMES,
  Tier3ToolHost,
  createFakeTier3Api,
  createHttpTier3Api,
  createScriptedCommandRunner,
  parseCheckedCommand,
  tier3ToolConditionHash,
  tokeniseCommand,
  validateToolArgs,
  type CheckedCommandRunner,
  type Tier3ApiClient,
} from '../../../scripts/voice-live-lab/lib/tier3-tools.js';
import { EventLog, createMonotonicClock } from '../../../scripts/voice-live-lab/lib/scheduler.js';

const RUN_DIR = '/tmp/voice-live-b2short/run-1';

function harness() {
  const clock = createMonotonicClock();
  const log = new EventLog({ clock });
  return { clock, log };
}

/** Deterministic confirmation timers: a manual clock and a manual expiry. */
function manualTimers(startMs = 0) {
  let now = startMs;
  const timers: Array<{ fn: () => void; atMs: number; cancelled: boolean }> = [];
  return {
    timers,
    nowMs: () => now,
    advance(ms: number) {
      now += ms;
      for (const timer of [...timers]) {
        if (!timer.cancelled && timer.atMs <= now) {
          timer.cancelled = true;
          timer.fn();
        }
      }
    },
    setTimeout(fn: () => void, ms: number) {
      const entry = { fn, atMs: now + ms, cancelled: false };
      timers.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
  };
}

function makeHost(
  options: {
    api?: Tier3ApiClient;
    runner?: CheckedCommandRunner;
    confirmations?: ConfirmationRegistry;
    peakWindow?: boolean;
    /** Grant every confirmation as soon as it is requested. */
    autoConfirm?: boolean;
  } = {}
) {
  const { clock, log } = harness();
  const timers = manualTimers();
  const requests: Array<{ action: string; text: string }> = [];
  const registryHolder: { current: ConfirmationRegistry | null } = { current: null };
  const confirmations =
    options.confirmations ??
    new ConfirmationRegistry(timers, (request) => {
      requests.push({ action: request.action, text: request.text });
      if (options.autoConfirm) {
        registryHolder.current?.noteOperatorUtterance({ text: 'Yes, go ahead.', kind: 'confirm' });
      }
    });
  registryHolder.current = confirmations;
  const api = options.api ?? createFakeTier3Api({ now: timers.nowMs });
  const runner = options.runner ?? createScriptedCommandRunner();
  const host = new Tier3ToolHost({
    log,
    clock,
    api,
    runDir: RUN_DIR,
    confirmations,
    commandRunner: runner,
    peakWindow: options.peakWindow,
  });
  return { host, api, runner, confirmations, timers, requests, log, clock };
}

// ── 1. Declarations and argument validation ─────────────────────────────────

describe('tier 3 declarations (§17.2)', () => {
  it('declares exactly the seven documented functions, all NON_BLOCKING', () => {
    expect(TIER3_FUNCTION_DECLARATIONS.map((declaration) => declaration.name)).toEqual([
      ...TIER3_TOOL_NAMES,
    ]);
    for (const declaration of TIER3_FUNCTION_DECLARATIONS) {
      expect(declaration.behavior).toBe('NON_BLOCKING');
      expect(declaration.description.length).toBeGreaterThan(40);
      expect(declaration.parameters).toMatchObject({ type: 'OBJECT' });
    }
    expect(TIER3_RESPONSE_SCHEDULING).toBe('WHEN_IDLE');
  });

  it('has a stable condition hash (a reworded description is a different condition)', () => {
    const hash = tier3ToolConditionHash();
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(tier3ToolConditionHash()).toBe(hash);
  });

  it('refuses invalid arguments with a human-readable reason instead of throwing', () => {
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ['create_child', { name: 'x', cwd: '/tmp', brief: '' }, /brief/],
      ['create_child', { name: '', cwd: '/tmp', brief: 'b' }, /name/],
      ['create_child', { name: 'x', cwd: '/tmp', brief: 'b'.repeat(4001) }, /4000|too big/i],
      ['read_child', { sessionId: 's', tail: 41 }, /tail/],
      ['wait_for', { sessionId: 's', condition: 'text-contains' }, /text is required/],
      ['wait_for', { sessionId: 's', condition: 'idle', timeoutS: 601 }, /timeoutS/],
      ['prompt_child', { sessionId: 's', message: 'm', deliverAs: 'shove' }, /deliverAs/],
      ['notify_owner', { text: 'x'.repeat(301) }, /300|too big/i],
      ['delete_everything', {}, /unknown tool/],
    ];
    for (const [name, args, pattern] of cases) {
      const result = validateToolArgs(name, args);
      expect(result.ok, `${name} ${JSON.stringify(args)} must be refused`).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(pattern);
    }
  });

  it('accepts well-formed arguments', () => {
    const result = validateToolArgs('create_child', {
      name: 'transfer worker',
      cwd: `${RUN_DIR}/repo-core`,
      brief: 'Make the transfer tests pass.',
    });
    expect(result.ok).toBe(true);
    expect(validateToolArgs('wait_for', { sessionId: 's', condition: 'idle' }).ok).toBe(true);
    expect(validateToolArgs('run_checked', { command: 'ls' }).ok).toBe(true);
  });
});

// ── 2. The run_checked allow-list ───────────────────────────────────────────

describe('run_checked allow-list (§17.2)', () => {
  const CORE = `${RUN_DIR}/repo-core`;

  it('tokenises quoting without a shell', () => {
    expect(tokeniseCommand('cat "repo-core/src/a b.py"')).toEqual(['cat', 'repo-core/src/a b.py']);
    expect(tokeniseCommand("ls 'repo-core'")).toEqual(['ls', 'repo-core']);
    expect(tokeniseCommand('cat "unclosed')).toBeNull();
  });

  it('allows the documented inspection commands', () => {
    const allowed: Array<[string, boolean]> = [
      [`git -C ${CORE} log --oneline -5`, false],
      [`git -C ${CORE} status --short`, false],
      [`git -C ${CORE} diff --stat`, false],
      [`git -C repo-core log`, false],
      ['python3 -m unittest discover -s repo-core/tests', false],
      ['python3 -m unittest tests.test_transfer', false],
      ['bash mock-service/ctl.sh health', false],
      ['bash ctl.sh status', false],
      ['bash mock-service/ctl.sh restart', true],
      [`cat ${CORE}/src/routes.py`, false],
      ['cat repo-core/src/routes.py', false],
      ['ls -la repo-core', false],
      ['ls', false],
    ];
    for (const [command, needsConfirmation] of allowed) {
      const parsed = parseCheckedCommand(command, RUN_DIR);
      expect(parsed.allowed, `${command} must be allowed`).toBe(true);
      if (parsed.allowed) {
        expect(parsed.parsed.requiresConfirmation, command).toBe(needsConfirmation);
        expect(parsed.parsed.command).toBe(command);
      }
    }
  });

  it('resolves `bash ctl.sh …` under the mock service and refuses other verbs', () => {
    const parsed = parseCheckedCommand('bash ctl.sh restart', RUN_DIR);
    expect(parsed.allowed).toBe(true);
    if (parsed.allowed) {
      expect(parsed.parsed.argv).toEqual(['bash', `${RUN_DIR}/mock-service/ctl.sh`, 'restart']);
      expect(parsed.parsed.requiresConfirmation).toBe(true);
    }
    const refused = parseCheckedCommand('bash ctl.sh stop', RUN_DIR);
    expect(refused.allowed).toBe(false);
    if (!refused.allowed) expect(refused.reason).toMatch(/restart, health or status/);
  });

  it('refuses everything outside the allow-list, with the reason', () => {
    const refused: Array<[string, RegExp]> = [
      ['rm -rf /tmp/x', /not on the allow-list/],
      ['curl http://example.com', /not on the allow-list/],
      ['git log', /git must be run as/],
      [`git -C /etc log`, /outside the run directory/],
      [`git -C ${CORE} push`, /only "git log", "git status" and "git diff"/],
      ['python3 -c "print(1)"', /only "python3 -m unittest/],
      ['python3 -m unittest /etc/x', /outside the run directory/],
      ['bash /etc/rc.local status', /outside the run directory/],
      ['bash some_other.sh health', /ctl\.sh/],
      ['cat /etc/passwd', /outside the run directory/],
      ['cat ../../etc/passwd', /outside the run directory/],
      ['cat repo-core/src/routes.py repo-tools/AGENTS.md', /exactly one path/],
      ['ls -R repo-core', /ls flag -R is not allowed/],
      ['cat repo-core/src/routes.py | head -3', /metacharacter/],
      ['python3 -m unittest ; rm -rf /', /metacharacter/],
      [`git -C ${CORE} diff > out.txt`, /metacharacter/],
      ['git -C $(pwd) log', /metacharacter/],
      ['   ', /empty/],
    ];
    for (const [command, pattern] of refused) {
      const parsed = parseCheckedCommand(command, RUN_DIR);
      expect(parsed.allowed, `${command} must be refused`).toBe(false);
      if (!parsed.allowed) expect(parsed.reason).toMatch(pattern);
    }
  });

  it('never lets a path escape the run directory by traversal', () => {
    const escaped = parseCheckedCommand(`cat ${RUN_DIR}/../secrets`, RUN_DIR);
    expect(escaped.allowed).toBe(false);
    const inside = parseCheckedCommand(`cat ${RUN_DIR}/repo-core/../repo-tools/AGENTS.md`, RUN_DIR);
    expect(inside.allowed).toBe(true);
  });
});

// ── 3. The polling rule ─────────────────────────────────────────────────────

describe('polling rule (§17.2)', () => {
  it('counts the second read inside 30 s as a poll, and clears after a wait_for', () => {
    const tracker = new PollTracker();
    expect(tracker.noteRead(0)).toBe(false); // first read is not a poll
    expect(tracker.noteRead(1_000)).toBe(true); // second within 30 s is
    expect(tracker.polls).toBe(1);
    tracker.noteWaitFor();
    expect(tracker.noteRead(2_000)).toBe(false); // wait_for intervenes
    expect(tracker.polls).toBe(1);
    expect(tracker.noteRead(2_000 + POLL_WINDOW_MS + 1)).toBe(false); // outside the window
    expect(tracker.polls).toBe(1);
  });

  it('counts a sleep command as a poll', () => {
    const tracker = new PollTracker();
    tracker.noteSleepCommand(0);
    expect(tracker.polls).toBe(1);
  });

  it('marks the ledger entry that was counted', async () => {
    const { host } = makeHost({
      api: createFakeTier3Api({
        sessions: [{ sessionId: 'child-1', status: 'running', busy: true }],
      }),
    });
    const first = await host.execute({ name: 'child_status', args: { sessionId: 'child-1' }, id: 'c1' });
    const second = await host.execute({ name: 'child_status', args: { sessionId: 'child-1' }, id: 'c2' });
    expect(first.response.countedAsPoll).toBe(false);
    // A real monotonic clock makes the second read land inside the 30 s window.
    expect(second.response.countedAsPoll).toBe(true);
    expect(host.polls).toBe(1);
    expect(host.ledger.find((entry) => entry.callId === 'c2')?.poll).toBe(true);
  });
});

// ── 4. The confirmation protocol ────────────────────────────────────────────

describe('confirmation protocol (§17.2)', () => {
  it('injects "the owner must confirm" and grants only on a committed confirm', async () => {
    const requests: Array<{ action: string; text: string }> = [];
    const timers = manualTimers();
    const registry = new ConfirmationRegistry(timers, (request) => requests.push(request));
    const pending = registry.request('create_child', 'create the first child worker');
    expect(requests).toHaveLength(1);
    expect(requests[0].text).toMatch(/owner must confirm/);

    // The model's own claim grants nothing; a question grants nothing.
    expect(registry.noteOperatorUtterance({ text: 'yes I confirmed already', kind: 'statement' })).toBe(false);
    expect(registry.noteOperatorUtterance({ text: 'shall I?', kind: 'question' })).toBe(false);

    // A committed `confirm` does.
    expect(registry.noteOperatorUtterance({ text: 'Yes, go ahead.', kind: 'confirm' })).toBe(true);
    await expect(pending).resolves.toEqual({ confirmed: true, text: 'Yes, go ahead.' });
    expect(registry.wasGranted('create_child')).toBe(true);
  });

  it('lapses to refused: no-confirmation after 60 s', async () => {
    const timers = manualTimers();
    const registry = new ConfirmationRegistry(timers, () => undefined);
    const pending = registry.request('restart_service', 'restart the service');
    timers.advance(CONFIRMATION_WINDOW_MS);
    await expect(pending).resolves.toEqual({ confirmed: false, reason: 'no-confirmation' });
    expect(registry.wasGranted('restart_service')).toBe(false);
    expect(registry.pending).toBeNull();
  });

  it('serialises requests: a different action never rides on another grant', async () => {
    const timers = manualTimers();
    const registry = new ConfirmationRegistry(timers, () => undefined);

    // Two requests for the SAME action queue behind each other and both are
    // satisfied by one grant (the permission table grants creation once).
    const first = registry.request('create_child', 'create a child');
    const second = registry.request('create_child', 'create another child');
    let secondSettled = false;
    void second.then(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    registry.noteOperatorUtterance({ text: 'Yes, go ahead.', kind: 'confirm' });
    await expect(first).resolves.toEqual({ confirmed: true, text: 'Yes, go ahead.' });
    await expect(second).resolves.toMatchObject({ confirmed: true });

    // A different action still needs its own confirmation, and lapses.
    const restart = registry.request('restart_service', 'restart the service');
    expect(registry.pending?.action).toBe('restart_service');
    timers.advance(CONFIRMATION_WINDOW_MS);
    await expect(restart).resolves.toEqual({ confirmed: false, reason: 'no-confirmation' });
    expect(registry.wasGranted('restart_service')).toBe(false);
  });
});

// ── 5. The tool host ────────────────────────────────────────────────────────

describe('Tier3ToolHost', () => {
  it('refuses a child whose cwd is outside the run directory', async () => {
    const { host } = makeHost();
    const result = await host.execute({
      name: 'create_child',
      args: { name: 'x', cwd: '/root/pi-web-ui', brief: 'do things' },
      id: 'c1',
    });
    expect(result.status).toBe('refused');
    expect(result.response.refused).toMatch(/outside the run directory/);
  });

  it('requires owner confirmation for the first child only, and forces the invariant', async () => {
    const { host, api, confirmations, timers } = makeHost();
    const call = () =>
      host.execute({
        name: 'create_child',
        args: { name: 'transfer worker', cwd: `${RUN_DIR}/repo-core`, brief: 'Make the transfer tests pass.' },
        id: 'c1',
      });

    const pending = call();
    // Nothing is created while the confirmation is outstanding.
    expect((api as ReturnType<typeof createFakeTier3Api>).created).toHaveLength(0);
    confirmations.noteOperatorUtterance({ text: 'not now', kind: 'question' });
    timers.advance(CONFIRMATION_WINDOW_MS);
    const refused = await pending;
    expect(refused.status).toBe('refused');
    expect(refused.response.refused).toMatch(/no-confirmation/);

    // A second attempt, this time confirmed.
    const granted = call();
    confirmations.noteOperatorUtterance({ text: 'Yes, you may create that child.', kind: 'confirm' });
    const created = await granted;
    expect(created.status).toBe('completed');
    expect(created.response.sessionId).toBe('child-1');

    const recorded = host.childBySessionId('child-1');
    expect(recorded?.briefBytes).toBe(Buffer.byteLength('Make the transfer tests pass.', 'utf8'));
    expect(recorded?.briefSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(recorded?.model).toBe(DEFAULT_CHILD_INVARIANT.model);
    expect(recorded?.thinkingLevel).toBe('high');

    const createdInput = (api as ReturnType<typeof createFakeTier3Api>).created[0];
    expect(createdInput).toMatchObject({
      runtime: 'pi',
      model: 'zai/glm-5.3-flash',
      thinkingLevel: 'high',
      cwd: `${RUN_DIR}/repo-core`,
    });

    // The second child needs no confirmation.
    const second = await host.execute({
      name: 'create_child',
      args: { name: 'tools worker', cwd: `${RUN_DIR}/repo-tools`, brief: 'Implement TaskQueue and ToolRunner.' },
      id: 'c2',
    });
    expect(second.status).toBe('completed');
    expect(second.response.sessionId).toBe('child-2');
    expect(host.createChildCalls).toBe(2);
  });

  it('uses the peak-window twin only when it is declared', async () => {
    const { host } = makeHost({ peakWindow: true });
    const { host: offPeak } = makeHost();
    expect(host.childInvariant.model).toBe(PEAK_WINDOW_TWIN.model);
    expect(offPeak.childInvariant.model).toBe(DEFAULT_CHILD_INVARIANT.model);
  });

  it('refuses to prompt a session the host did not create', async () => {
    const { host, api } = makeHost();
    const result = await host.execute({
      name: 'prompt_child',
      args: { sessionId: 'someone-elses-session', message: 'hello' },
      id: 'c1',
    });
    expect(result.status).toBe('refused');
    expect(result.response.refused).toMatch(/not a child created in this run/);
    expect((api as ReturnType<typeof createFakeTier3Api>).prompts).toHaveLength(0);
  });

  it('executes prompt_child with the requested delivery mode', async () => {
    const { host, api } = makeHost({ autoConfirm: true });
    await host.execute({
      name: 'create_child',
      args: { name: 'w', cwd: `${RUN_DIR}/repo-core`, brief: 'brief' },
      id: 'c0',
    });
    const fake = api as ReturnType<typeof createFakeTier3Api>;
    const result = await host.execute({
      name: 'prompt_child',
      args: { sessionId: 'child-1', message: 'phase three is un-gated', deliverAs: 'follow_up' },
      id: 'c1',
    });
    expect(result.status).toBe('completed');
    expect(fake.prompts.at(-1)).toMatchObject({ mode: 'follow_up' });
  });

  it('registers a watch for wait_for and returns when it fires', async () => {
    const { host, api } = makeHost({
      api: createFakeTier3Api({
        sessions: [{ sessionId: 'child-1', status: 'idle', busy: false }],
      }),
    });
    const fake = api as ReturnType<typeof createFakeTier3Api>;
    const result = await host.execute({
      name: 'wait_for',
      args: { sessionId: 'child-1', condition: 'idle', timeoutS: 120 },
      id: 'c1',
    });
    expect(result.status).toBe('completed');
    expect(result.response.fired).toBe(true);
    expect(fake.watches).toEqual([{ sessionId: 'child-1', condition: 'idle', text: undefined, timeoutS: 120 }]);
    // A wait_for clears the poll rule.
    const after = await host.execute({ name: 'child_status', args: { sessionId: 'child-1' }, id: 'c2' });
    expect(after.response.countedAsPoll).toBe(false);
    expect(host.polls).toBe(0);
  });

  it('reports a timed-out wait_for honestly', async () => {
    const { host } = makeHost({
      api: createFakeTier3Api({ watchOutcome: () => 'timeout' }),
    });
    const result = await host.execute({
      name: 'wait_for',
      args: { sessionId: 'child-1', condition: 'text-contains', text: 'green', timeoutS: 5 },
      id: 'c1',
    });
    expect(result.response.fired).toBe(false);
    expect(result.response.timedOut).toBe(true);
  });

  it('refuses a command outside the allow-list without running it', async () => {
    const runner = createScriptedCommandRunner();
    const { host } = makeHost({ runner });
    const result = await host.execute({ name: 'run_checked', args: { command: 'rm -rf /' }, id: 'c1' });
    expect(result.status).toBe('refused');
    expect(runner.calls).toHaveLength(0);
  });

  it('requires confirmation for ctl.sh restart and runs health without it', async () => {
    const runner = createScriptedCommandRunner();
    const { host, confirmations, timers } = makeHost({ runner });

    const health = await host.execute({ name: 'run_checked', args: { command: 'bash ctl.sh health' }, id: 'c1' });
    expect(health.status).toBe('completed');
    expect(runner.calls.map((call) => call.kind)).toEqual(['ctl']);

    const restart = host.execute({ name: 'run_checked', args: { command: 'bash ctl.sh restart' }, id: 'c2' });
    timers.advance(CONFIRMATION_WINDOW_MS);
    const refused = await restart;
    expect(refused.status).toBe('refused');
    expect(refused.response.refused).toMatch(/no-confirmation/);
    expect(runner.calls).toHaveLength(1);

    const restartAgain = host.execute({ name: 'run_checked', args: { command: 'bash ctl.sh restart' }, id: 'c3' });
    confirmations.noteOperatorUtterance({ text: 'Yes, you may restart the service.', kind: 'confirm' });
    const done = await restartAgain;
    expect(done.status).toBe('completed');
    expect(runner.calls.at(-1)?.requiresConfirmation).toBe(true);
  });

  it('records milestones and reports a failing command as an error, not a success', async () => {
    const { host } = makeHost({
      runner: createScriptedCommandRunner([
        { contains: 'unittest', exitCode: 1, stdout: 'FAILED (failures=3)', stderr: '' },
      ]),
    });
    const milestone = await host.execute({ name: 'notify_owner', args: { text: 'Child 1 dispatched.' }, id: 'c1' });
    expect(milestone.status).toBe('completed');
    expect(host.milestones).toEqual([{ text: 'Child 1 dispatched.', atMs: expect.any(Number) }]);

    const failing = await host.execute({
      name: 'run_checked',
      args: { command: 'python3 -m unittest discover -s repo-core/tests' },
      id: 'c2',
    });
    expect(failing.status).toBe('error');
    expect(failing.response.ok).toBe(false);
    expect(failing.response.stdout).toContain('FAILED');
  });

  it('ledgers every call with id, args, status, result and generation', async () => {
    let generation = 0;
    const { clock, log } = harness();
    const timers = manualTimers();
    const host = new Tier3ToolHost({
      log,
      clock,
      api: createFakeTier3Api({ now: timers.nowMs }),
      runDir: RUN_DIR,
      confirmations: new ConfirmationRegistry(timers, () => undefined),
      commandRunner: createScriptedCommandRunner(),
      generationProvider: () => generation,
    });
    await host.execute({ name: 'notify_owner', args: { text: 'one' }, id: 'c1' });
    generation = 2;
    await host.execute({ name: 'child_status', args: { sessionId: 'child-1' }, id: 'c2' });
    expect(host.ledger).toHaveLength(2);
    expect(host.ledger[0]).toMatchObject({ callId: 'c1', name: 'notify_owner', status: 'completed', generation: 0 });
    expect(host.ledger[1]).toMatchObject({ callId: 'c2', status: 'error', generation: 2 });
    expect(host.ledger[0].completedAtMs).toBeGreaterThanOrEqual(host.ledger[0].startedAtMs);
    expect(host.pendingCallIds()).toEqual([]);
  });

  it('builds the reconnect snapshot from HOST state, not from the model', async () => {
    const { host } = makeHost({ autoConfirm: true });
    await host.execute({
      name: 'create_child',
      args: { name: 'transfer worker', cwd: `${RUN_DIR}/repo-core`, brief: 'brief' },
      id: 'c0',
    });
    const snapshot = host.snapshotForReconnect();
    expect(snapshot).toContain('Reconnected.');
    expect(snapshot).toContain('transfer worker=child-1');
    expect(snapshot).toContain('No confirmation pending.');
  });

  it('never throws on a malformed tool call: the failure is a tool result', async () => {
    const { host } = makeHost();
    const result = await host.execute({ name: 'run_checked', args: {}, id: 'c1' });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('refused');
    expect(host.ledger.at(-1)?.status).toBe('refused');
  });
});

// ── 6. The real Internal API client over a Unix socket ───────────────────────

describe('createHttpTier3Api — the real Internal API surface', () => {
  it('drives sessions, prompts, transcripts and watches over a socket', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'voice-live-tier3-api-'));
    const socketPath = path.join(dir, 'api.sock');
    const requests: Array<{ method: string; url: string; body: unknown }> = [];
    let watchPolls = 0;

    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk.toString();
      });
      req.on('end', () => {
        requests.push({
          method: req.method ?? '',
          url: req.url ?? '',
          body: raw ? (JSON.parse(raw) as unknown) : null,
        });
        res.setHeader('content-type', 'application/json');
        const url = req.url ?? '';
        if (url === '/api/v1/sessions' && req.method === 'POST') {
          res.end(JSON.stringify({ data: { sessionId: 'child-9', model: 'zai/glm-5.3-flash' } }));
          return;
        }
        if (url.endsWith('/prompt')) {
          res.end(JSON.stringify({ data: { dispatchMode: 'prompt' } }));
          return;
        }
        if (url.endsWith('/transcript?view=screen')) {
          res.end(JSON.stringify({ data: { lines: ['one', 'two', 'three'] } }));
          return;
        }
        if (url.endsWith('/watch') && req.method === 'POST') {
          res.statusCode = 201;
          res.end(JSON.stringify({ watchId: 'watch-1' }));
          return;
        }
        if (url.endsWith('/watch') && req.method === 'DELETE') {
          res.end(JSON.stringify({ deleted: true }));
          return;
        }
        if (url.endsWith('/watch')) {
          watchPolls += 1;
          res.end(JSON.stringify(watchPolls >= 2 ? { allFired: true, firings: [{ at: 1 }] } : { allFired: false, firings: [] }));
          return;
        }
        if (req.method === 'GET') {
          res.end(JSON.stringify({ data: { busy: false, status: 'idle', lastText: 'done' } }));
          return;
        }
        res.end('{}');
      });
    });

    try {
      await new Promise<void>((resolve) => server.listen(socketPath, resolve));
      const api = createHttpTier3Api({ socketPath, token: 'test-token', watchPollIntervalMs: 1 });

      const created = await api.createSession({
        runtime: 'pi',
        cwd: '/tmp/run/repo-core',
        model: 'zai/glm-5.3-flash',
        thinkingLevel: 'high',
        source: 'voice-live-lab-tier3',
        label: 'voice-live-lab:transfer worker',
      });
      expect(created.sessionId).toBe('child-9');
      expect(requests[0]).toMatchObject({ method: 'POST', url: '/api/v1/sessions' });

      const dispatched = await api.prompt('child-9', 'brief', 'follow_up');
      expect(dispatched.status).toBe(200);
      expect(requests[1].body).toMatchObject({ message: 'brief', mode: 'follow_up', detach: true });

      const info = await api.childInfo('child-9');
      expect(info).toMatchObject({ busy: false, status: 'idle', lastText: 'done' });

      const tail = await api.transcriptTail('child-9', 2);
      expect(tail).toEqual(['two', 'three']);

      const watchIds: string[] = [];
      const outcome = await api.awaitWatch('child-9', { condition: 'idle', timeoutS: 5 }, (id) => watchIds.push(id));
      expect(watchIds).toEqual(['watch-1']);
      expect(outcome).toMatchObject({ fired: true, timedOut: false });
      expect(watchPolls).toBe(2);
      // The watch registration is released on the way out.
      expect(requests.at(-1)).toMatchObject({ method: 'DELETE' });
      const registration = requests.find((entry) => entry.url.endsWith('/watch') && entry.method === 'POST');
      expect(registration?.body).toMatchObject({
        conditions: [{ type: 'event_type', eventType: 'agent_end', once: true }],
      });

      await api.deleteSession('child-9');
      expect(requests.at(-1)).toMatchObject({ method: 'DELETE', url: '/api/v1/sessions/child-9' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
