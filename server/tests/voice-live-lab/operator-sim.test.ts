/**
 * L6 operator-simulator tests (plan §23; intent §14.1, §14.3, §14.5).
 *
 * The simulator is an instrument, not a convenience: these tests pin the prompt
 * it is given, the re-ask protocol, the beat-ending failure attribution and —
 * most importantly — the fact that its own reaction latency is stamped on a
 * separate event flagged as excluded from candidate latency. A simulator that
 * leaks its own thinking time into a candidate number would corrupt the one
 * measurement the whole lab exists to take.
 */
import { describe, expect, it } from 'vitest';

import { EVENT, EventLog, createMonotonicClock } from '../../../scripts/voice-live-lab/lib/scheduler.js';
import type { ScenarioBeat } from '../../../scripts/voice-live-lab/lib/scenario.js';
import type { HeardSegment } from '../../../scripts/voice-live-lab/lib/director.js';
import { Director } from '../../../scripts/voice-live-lab/lib/director.js';
import {
  AdaptiveOperator,
  DEFAULT_OPERATOR_MODEL,
  DEFAULT_OPERATOR_TEMPERATURE,
  DEFAULT_OPERATOR_THINKING,
  DEFAULT_PERSONA,
  ENTRY_GATE_AGREEMENT_FLOOR,
  MAX_PROPOSAL_ATTEMPTS,
  OPERATOR_EVENT,
  ScriptedSimulatorClient,
  assembleTurnPrompt,
  formatHeardSegment,
  lineAgreement,
  operatorLatencyFromEvents,
  operatorLatencyIsSegregated,
  parseSimulatorReply,
  renderPermissionsInPlainWords,
  runAdaptiveBeat,
  runInstrumentEntryGate,
  type BeatPort,
  type EntryGateCase,
  type SpokenLine,
  type SyntheticFixtureRef,
} from '../../../scripts/voice-live-lab/lib/operator-sim.js';

function beat(overrides: Partial<ScenarioBeat> = {}): ScenarioBeat {
  return {
    id: 'b9-adaptive-tail',
    mode: 'adaptive',
    goal: 'Find out whether child two is blocked, then get it un-gated.',
    trigger: { after: 'candidate-silence', silenceMs: 800 },
    permissions: ['confirm:draft-proposed-in-this-beat'],
    maxTurns: 4,
    expect: {},
    ...overrides,
  };
}

function heard(text: string, overrides: Partial<HeardSegment> = {}): HeardSegment {
  return { index: 0, text, atSeconds: 2.5, ...overrides };
}

function move(
  say: string | null,
  overrides: Partial<{ interrupt: boolean; waitMs: number; beatDone: boolean; why: string }> = {}
): string {
  return JSON.stringify({ say, interrupt: false, waitMs: 0, beatDone: false, why: 'for the record', ...overrides });
}

function testLog(): EventLog {
  return new EventLog({ clock: createMonotonicClock() });
}

function newOperator(
  replies: Array<string | { text: string; latencyMs?: number }>,
  options: Partial<ConstructorParameters<typeof AdaptiveOperator>[0]> = {}
): { operator: AdaptiveOperator; scripted: ScriptedSimulatorClient; log: EventLog } {
  const scripted = new ScriptedSimulatorClient(replies);
  const log = options.log ?? testLog();
  const operator = new AdaptiveOperator({
    director: new Director({ scenarioId: 't1-s1', language: 'en-GB' }),
    client: scripted.client,
    log,
    now: () => 0,
    ...options,
  });
  return { operator, scripted, log };
}

// ---------------------------------------------------------------------------
// Persona and prompt assembly
// ---------------------------------------------------------------------------

describe('operator-sim: persona', () => {
  it('ships the persona verbatim, as a versioned artefact', () => {
    expect(DEFAULT_PERSONA).toContain('playing the role of a busy senior software engineer');
    expect(DEFAULT_PERSONA).toContain('You are British, direct, informal, and you think out loud');
    expect(DEFAULT_PERSONA).toContain('You never speak markdown or paths');
    expect(DEFAULT_PERSONA).toContain('Speak as a person, not as a test.');
  });

  it('defaults to the DeepSeek twin at high thinking', () => {
    expect(DEFAULT_OPERATOR_MODEL).toBe('commandcode/deepseek/deepseek-v4.1-flash');
    expect(DEFAULT_OPERATOR_THINKING).toBe('high');
    expect(DEFAULT_OPERATOR_TEMPERATURE).toBe(0.7);
  });
});

describe('operator-sim: permission rendering', () => {
  it('says plainly that an empty beat authorises nothing', () => {
    expect(renderPermissionsInPlainWords([])).toContain('cannot authorise anything');
  });

  it('renders a known confirm grant with its condition', () => {
    expect(renderPermissionsInPlainWords(['confirm:draft-proposed-in-this-beat'])).toBe(
      'confirm a send ONLY if the assistant has clearly proposed one and read it back to you'
    );
  });

  it('keeps the base meaning of a suffixed grant', () => {
    expect(renderPermissionsInPlainWords(['answer:permission-request-1'])).toContain("answer the worker's permission request");
  });

  it('humanises an unknown verb rather than dropping it', () => {
    expect(renderPermissionsInPlainWords(['level:headlines', 'custom:thing'])).toContain('custom thing');
  });
});

describe('operator-sim: turn prompt assembly (§14.5)', () => {
  it('opens with the persona and states the goal', () => {
    const prompt = assembleTurnPrompt({
      beatGoal: 'Get the worker to un-gate child two.',
      permissions: [],
      heard: [],
      earlierLines: [],
    });
    expect(prompt.startsWith(DEFAULT_PERSONA)).toBe(true);
    expect(prompt).toContain('GOAL FOR THIS BEAT: Get the worker to un-gate child two.');
  });

  it('states what the operator may and may not do', () => {
    const prompt = assembleTurnPrompt({
      beatGoal: 'g',
      permissions: ['confirm:draft-proposed-in-this-beat'],
      heard: [],
      earlierLines: [],
    });
    expect(prompt).toContain('YOU MAY: confirm a send ONLY if the assistant has clearly proposed one');
    expect(prompt).toContain('YOU MAY NOT: authorise anything else, invent facts about the worker, or claim to have seen a screen.');
  });

  it('lists heard segments one per line with seconds and an interrupted marker', () => {
    const prompt = assembleTurnPrompt({
      beatGoal: 'g',
      permissions: [],
      heard: [heard('shall I send that to the worker?', { atSeconds: 3.2 }), heard('go on then', { atSeconds: 9, interrupted: true })],
      earlierLines: [],
    });
    expect(prompt).toContain('WHAT YOU HAVE HEARD SO FAR (newest last; [interrupted] marks where you cut in):');
    expect(prompt).toContain('[3.2s] assistant: shall I send that to the worker?');
    expect(prompt).toContain('[9.0s] assistant: go on then [interrupted]');
  });

  it('marks an empty history rather than leaving it blank', () => {
    const prompt = assembleTurnPrompt({ beatGoal: 'g', permissions: [], heard: [], earlierLines: [] });
    expect(prompt).toContain('(nothing yet)');
    expect(prompt).toContain('YOUR EARLIER LINES:\n(none)');
  });

  it('lists the operator’s own earlier lines', () => {
    const prompt = assembleTurnPrompt({
      beatGoal: 'g',
      permissions: [],
      heard: [],
      earlierLines: ['hold phase three', 'and tell it to wait'],
    });
    expect(prompt).toContain('- hold phase three');
    expect(prompt).toContain('- and tell it to wait');
  });

  it('ends with the exact JSON contract', () => {
    const prompt = assembleTurnPrompt({ beatGoal: 'g', permissions: [], heard: [], earlierLines: [] });
    expect(prompt).toContain('Decide your next move. Reply ONLY with JSON:');
    expect(prompt).toContain('"say": "<what you say next, or null to stay silent>"');
    expect(prompt).toContain('"waitMs": <how long to wait before speaking, 0-4000>');
    expect(prompt).toContain('"beatDone": <true when the goal is met or clearly impossible>');
    expect(prompt).toContain('"why": "<one sentence, for the record only>"');
  });

  it('formats a single heard segment with its speaker and seconds', () => {
    expect(formatHeardSegment(heard('hello there', { atSeconds: 1.25 }))).toBe('[1.3s] assistant: hello there');
  });
});

// ---------------------------------------------------------------------------
// Reply parsing and the scripted transport
// ---------------------------------------------------------------------------

describe('operator-sim: reply parsing and scripted client', () => {
  it('parses a bare JSON move', () => {
    const parsed = parseSimulatorReply(move('hello'));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect((parsed.value as { say: string }).say).toBe('hello');
  });

  it('tolerates a fenced JSON move', () => {
    const parsed = parseSimulatorReply('```json\n' + move('hello') + '\n```');
    expect(parsed.ok).toBe(true);
  });

  it('tolerates prose around the JSON object', () => {
    const parsed = parseSimulatorReply(`Sure thing.\n${move('hello')}\nHope that helps.`);
    expect(parsed.ok).toBe(true);
  });

  it('reports unparseable text instead of throwing', () => {
    expect(parseSimulatorReply('not json at all').ok).toBe(false);
    expect(parseSimulatorReply('   ').ok).toBe(false);
  });

  it('replays queued replies and records every request', async () => {
    const scripted = new ScriptedSimulatorClient(['a', { text: 'b', latencyMs: 12 }]);
    const first = await scripted.next({ model: 'm', thinking: 'high', temperature: 0.7, prompt: 'p', attempt: 0 });
    const second = await scripted.next({ model: 'm', thinking: 'high', temperature: 0.7, prompt: 'p', attempt: 1 });
    expect(first.text).toBe('a');
    expect(second.latencyMs).toBe(12);
    expect(scripted.calls).toHaveLength(2);
  });

  it('throws when the script is exhausted', async () => {
    const scripted = new ScriptedSimulatorClient([]);
    await expect(scripted.next({ model: 'm', thinking: 'high', temperature: 0.7, prompt: 'p', attempt: 0 })).rejects.toThrow(
      /exhausted/
    );
  });
});

// ---------------------------------------------------------------------------
// Turn execution
// ---------------------------------------------------------------------------

describe('operator-sim: turn execution', () => {
  it('speaks an accepted line and reports the configured seat', async () => {
    const { operator } = newOperator([move('Tell it to hold phase three.')]);
    const outcome = await operator.nextTurn({ beat: beat(), heard: [], earlierLines: [] });
    expect(outcome.kind).toBe('spoken');
    if (outcome.kind === 'spoken') {
      expect(outcome.line.text).toBe('Tell it to hold phase three.');
      expect(outcome.line.model).toBe(DEFAULT_OPERATOR_MODEL);
      expect(outcome.line.thinking).toBe('high');
      expect(outcome.line.proposalAttempts).toBe(1);
    }
  });

  it('honours a configured model and thinking level', async () => {
    const { operator, scripted } = newOperator([move('hello there')], {
      model: 'zai/glm-5.3-flash',
      thinking: 'high',
      temperature: 0.7,
    });
    await operator.nextTurn({ beat: beat(), heard: [], earlierLines: [] });
    expect(scripted.calls[0].model).toBe('zai/glm-5.3-flash');
    expect(scripted.calls[0].thinking).toBe('high');
  });

  it('returns a silent turn when the model stays quiet without finishing', async () => {
    const { operator } = newOperator([move(null, { waitMs: 900 })]);
    const outcome = await operator.nextTurn({ beat: beat(), heard: [], earlierLines: [] });
    expect(outcome.kind).toBe('silent');
    if (outcome.kind === 'silent') expect(outcome.waitMs).toBe(900);
  });

  it('returns beat-done when the model finishes without speaking', async () => {
    const { operator } = newOperator([move(null, { beatDone: true, why: 'goal met' })]);
    const outcome = await operator.nextTurn({ beat: beat(), heard: [], earlierLines: [] });
    expect(outcome.kind).toBe('beat-done');
  });

  it('logs a hashed prompt, the proposal, the line and the reaction', async () => {
    const { operator, log } = newOperator([move('Tell it to hold phase three.', { interrupt: false })]);
    await operator.nextTurn({ beat: beat(), heard: [], earlierLines: [] });
    const kinds = log.events().map((event) => event.kind);
    expect(kinds).toContain(OPERATOR_EVENT.BEAT_START);
    expect(kinds).toContain(OPERATOR_EVENT.TURN_PROMPT);
    expect(kinds).toContain(OPERATOR_EVENT.PROPOSAL);
    expect(kinds).toContain(OPERATOR_EVENT.LINE);
    expect(kinds).toContain(OPERATOR_EVENT.REACTION);
    const prompt = log.events().find((event) => event.kind === OPERATOR_EVENT.TURN_PROMPT);
    expect(typeof prompt?.payload.promptSha256).toBe('string');
    expect(prompt?.payload.promptSha256).not.toBe(log.events()[0].payload.promptSha256);
  });

  it('carries the synthetic provenance tag on the spoken line event', async () => {
    const { operator, log } = newOperator([move('Tell it to hold phase three.')]);
    await operator.nextTurn({ beat: beat(), heard: [], earlierLines: [] });
    const line = log.events().find((event) => event.kind === OPERATOR_EVENT.LINE);
    expect(line?.payload.provenance).toBe('synthetic');
    expect(line?.payload.beatId).toBe('b9-adaptive-tail');
  });

  it('runs the optional TTS leg and records the synthetic fixture', async () => {
    const fixture: SyntheticFixtureRef = { id: 'synthetic:b9:1', sha256: 'abc', bytes: 640, durationMs: 1200 };
    const { operator, log } = newOperator([{ text: move('Tell it to hold phase three.'), latencyMs: 40 }], {
      now: (() => {
        let t = 0;
        return () => (t += 5);
      })(),
      synthesise: async () => ({ latencyMs: 25, ...fixture }),
    });
    const outcome = await operator.nextTurn({ beat: beat(), heard: [], earlierLines: [] });
    expect(outcome.kind).toBe('spoken');
    if (outcome.kind === 'spoken') {
      expect(outcome.line.modelMs).toBe(40);
      expect(outcome.line.ttsMs).toBe(25);
      expect(outcome.line.reactionLatencyMs).toBe(65);
      expect(outcome.line.fixture?.sha256).toBe('abc');
    }
    const line = log.events().find((event) => event.kind === OPERATOR_EVENT.LINE);
    expect(line?.payload.fixtureId).toBe('synthetic:b9:1');
    expect(line?.payload.fixtureDurationMs).toBe(1200);
  });
});

// ---------------------------------------------------------------------------
// Latency segregation
// ---------------------------------------------------------------------------

describe('operator-sim: latency segregation', () => {
  it('flags the simulator reaction as excluded from candidate latency', async () => {
    const { operator, log } = newOperator([{ text: move('Tell it to hold phase three.'), latencyMs: 120 }], {
      synthesise: async () => ({ latencyMs: 30 }),
    });
    await operator.nextTurn({ beat: beat(), heard: [], earlierLines: [] });
    const reaction = log.events().find((event) => event.kind === OPERATOR_EVENT.REACTION);
    expect(reaction?.payload.totalMs).toBe(150);
    expect(reaction?.payload.excludedFromCandidateLatency).toBe(true);
    expect(operatorLatencyIsSegregated(log.events())).toBe(true);
  });

  it('reads the segregated samples back from the record', async () => {
    const { operator, log } = newOperator([{ text: move('Tell it to hold phase three.'), latencyMs: 12 }]);
    await operator.nextTurn({ beat: beat(), heard: [], earlierLines: [] });
    const samples = operatorLatencyFromEvents(log.events());
    expect(samples).toEqual([{ beatId: 'b9-adaptive-tail', modelMs: 12, ttsMs: 0, totalMs: 12 }]);
  });

  it('treats an unflagged reaction as a broken segregation', () => {
    const log = new EventLog({ clock: createMonotonicClock() });
    log.append({ source: 'operator', kind: OPERATOR_EVENT.REACTION, payload: { totalMs: 10 } });
    expect(operatorLatencyIsSegregated(log.events())).toBe(false);
  });

  it('does not mix simulator latency into candidate-side events', async () => {
    const { operator, log } = newOperator([{ text: move('Tell it to hold phase three.'), latencyMs: 7 }]);
    await operator.nextTurn({ beat: beat(), heard: [], earlierLines: [] });
    const inputFrames = log.events().filter((event) => event.kind === EVENT.INPUT_FRAME);
    expect(inputFrames).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Re-ask protocol and failure attribution
// ---------------------------------------------------------------------------

describe('operator-sim: re-ask protocol', () => {
  it('re-asks once with the rejection reason appended', async () => {
    const { operator, scripted, log } = newOperator([
      move('run `npm test` and tell me'),
      move('Tell it to run the tests and tell me.'),
    ]);
    const outcome = await operator.nextTurn({ beat: beat(), heard: [], earlierLines: [] });
    expect(outcome.kind).toBe('spoken');
    if (outcome.kind === 'spoken') expect(outcome.line.proposalAttempts).toBe(2);
    expect(scripted.calls).toHaveLength(2);
    expect(scripted.calls[0].attempt).toBe(0);
    expect(scripted.calls[1].attempt).toBe(1);
    expect(scripted.calls[1].prompt).toContain('rejected by the director because: style-violation');
    expect(scripted.calls[1].prompt).toContain('Please revise your response to respect the rules.');
    expect(log.events().some((event) => event.kind === OPERATOR_EVENT.REJECTION)).toBe(true);
  });

  it('re-asks after unparseable JSON', async () => {
    const { operator, scripted, log } = newOperator(['not json', move('Tell it to hold phase three.')]);
    const outcome = await operator.nextTurn({ beat: beat(), heard: [], earlierLines: [] });
    expect(outcome.kind).toBe('spoken');
    expect(scripted.calls).toHaveLength(2);
    const rejection = log.events().find((event) => event.kind === OPERATOR_EVENT.REJECTION);
    expect(rejection?.payload.reason).toBe('json-shape');
  });

  it('ends the beat as simulator-failure after a second consecutive rejection', async () => {
    const { operator, scripted, log } = newOperator([move('run `npm test`'), move('again `npm test`')]);
    const outcome = await operator.nextTurn({ beat: beat(), heard: [], earlierLines: [] });
    expect(outcome.kind).toBe('simulator-failure');
    if (outcome.kind === 'simulator-failure') {
      expect(outcome.reason).toBe('style-violation');
      expect(outcome.rejections).toBe(2);
    }
    expect(scripted.calls).toHaveLength(MAX_PROPOSAL_ATTEMPTS);
    const failures = log.events().filter((event) => event.kind === OPERATOR_EVENT.SIMULATOR_FAILURE);
    expect(failures).toHaveLength(1);
    expect(failures[0].payload.beatId).toBe('b9-adaptive-tail');
  });

  it('rejects an unauthorised confirmation and records the reason', async () => {
    const { operator, log } = newOperator([move('yes, go ahead'), move('yes, send it')], {});
    const strict = beat({ permissions: [] });
    const outcome = await operator.nextTurn({ beat: strict, heard: [], earlierLines: [] });
    expect(outcome.kind).toBe('simulator-failure');
    if (outcome.kind === 'simulator-failure') expect(outcome.reason).toBe('permissions-violation');
    const rejections = log.events().filter((event) => event.kind === OPERATOR_EVENT.REJECTION);
    expect(rejections).toHaveLength(2);
    expect(rejections[0].payload.reason).toBe('permissions-violation');
  });

  it('never writes the leaked fact into the trace', async () => {
    const world = {
      schema: 'voice-lab.world/1',
      id: 'w',
      runtime: 'pi',
      initial: { activity: 'idle' },
      timeline: [],
      hiddenTruth: { x: 'the release branch is hold-phase-3' },
    };
    const scripted = new ScriptedSimulatorClient([
      move('the release branch is hold-phase-3'),
      move('the release branch is hold-phase-3 again'),
    ]);
    const log = testLog();
    const operator = new AdaptiveOperator({
      director: new Director({ scenarioId: 't1-s1', language: 'en-GB', world: world as never }),
      client: scripted.client,
      log,
      now: () => 0,
    });
    const outcome = await operator.nextTurn({ beat: beat(), heard: [], earlierLines: [] });
    expect(outcome.kind).toBe('simulator-failure');
    const serialised = JSON.stringify(log.events());
    expect(serialised).not.toContain('hold-phase-3');
  });
});

// ---------------------------------------------------------------------------
// Beat loop
// ---------------------------------------------------------------------------

function port(heardQueue: HeardSegment[][]): { port: BeatPort; spoken: SpokenLine[]; waits: number[] } {
  const spoken: SpokenLine[] = [];
  const waits: number[] = [];
  let index = 0;
  return {
    spoken,
    waits,
    port: {
      async speak(line) {
        spoken.push(line);
      },
      async wait(ms) {
        waits.push(ms);
      },
      heard() {
        const next = heardQueue[index] ?? [];
        index += 1;
        return next;
      },
    },
  };
}

describe('operator-sim: adaptive beat loop', () => {
  it('completes when the model reports the goal is done', async () => {
    const { operator } = newOperator([
      move('Is child two blocked?'),
      move('Right, un-gate it then.', { beatDone: true, why: 'goal met' }),
    ]);
    const harness = port([[], [heard('yes, child two is blocked on phase three')]]);
    const run = await runAdaptiveBeat(operator, harness.port, { beat: beat() });
    expect(run.status).toBe('completed');
    expect(run.turns).toBe(2);
    expect(harness.spoken.map((line) => line.text)).toEqual(['Is child two blocked?', 'Right, un-gate it then.']);
  });

  it('stops the whole beat on a simulator failure', async () => {
    const { operator } = newOperator([move('run `npm test`'), move('run `npm test` again')]);
    const harness = port([[]]);
    const run = await runAdaptiveBeat(operator, harness.port, { beat: beat() });
    expect(run.status).toBe('simulator-failure');
    expect(harness.spoken).toHaveLength(0);
  });

  it('stops at the beat turn budget', async () => {
    const { operator } = newOperator([move('one'), move('two')]);
    const harness = port([[heard('something said')], [heard('something said')], []]);
    const run = await runAdaptiveBeat(operator, harness.port, { beat: beat({ maxTurns: 2 }) });
    expect(run.status).toBe('budget-stopped');
    expect(run.turns).toBe(2);
  });

  it('waits out a silent turn without spending a turn', async () => {
    const { operator } = newOperator([move(null, { waitMs: 700 }), move('Now I speak.', { beatDone: true })]);
    const harness = port([[], []]);
    const run = await runAdaptiveBeat(operator, harness.port, { beat: beat() });
    expect(run.status).toBe('completed');
    expect(run.turns).toBe(1);
    expect(harness.waits[0]).toBe(700);
  });

  it('waits the model’s requested gap before speaking', async () => {
    const { operator } = newOperator([move('Tell it to hold.', { waitMs: 400, beatDone: true })]);
    const harness = port([[]]);
    await runAdaptiveBeat(operator, harness.port, { beat: beat() });
    expect(harness.waits).toEqual([400]);
  });

  it('feeds the operator’s own lines back into the next prompt', async () => {
    const { operator, scripted } = newOperator([move('First line.'), move('Second line.', { beatDone: true })]);
    const harness = port([[], []]);
    await runAdaptiveBeat(operator, harness.port, { beat: beat() });
    expect(scripted.calls[1].prompt).toContain('YOUR EARLIER LINES:\n- First line.');
  });
});

// ---------------------------------------------------------------------------
// Gate 4 instrument entry gate (§14.5 rule 1)
// ---------------------------------------------------------------------------

describe('operator-sim: Gate 4 entry gate', () => {
  it('scores token-F1 agreement between the known line and what was said', () => {
    expect(lineAgreement('hold phase three', 'hold phase three')).toBe(1);
    expect(lineAgreement('hold phase three', 'hold phase four')).toBeCloseTo(2 / 3, 5);
    expect(lineAgreement('hold phase three', 'something else entirely')).toBe(0);
    expect(lineAgreement('hold phase three', null)).toBe(0);
    expect(lineAgreement('hold phase three', 'three phase hold')).toBe(1);
  });

  function gateCase(id: string, goal: string, expected: string, extra: Partial<EntryGateCase> = {}): EntryGateCase {
    return { id, goal, expected, beat: beat({ id, permissions: [], maxTurns: 1 }), heard: [], ...extra };
  }

  it('passes when the simulator reproduces known owner behaviour legally', async () => {
    const { operator } = newOperator([
      move('Is child two blocked on phase three?'),
      move('hold phase three until my review'),
    ]);
    const report = await runInstrumentEntryGate(operator, [
      gateCase('f1', 'Ask whether child two is blocked.', 'Is child two blocked on phase three?'),
      gateCase('f2', 'Instruct the worker to hold phase three for review.', 'hold phase three until my review'),
    ]);
    expect(report.passed).toBe(true);
    expect(report.agreementRate).toBe(1);
    expect(report.rejectionRate).toBe(0);
    expect(report.cases.every((result) => result.outcome === 'spoken')).toBe(true);
  });

  it('fails when the simulator cannot reproduce the known line', async () => {
    const { operator } = newOperator([move('elephants are large'), move('bicycles have wheels')]);
    const report = await runInstrumentEntryGate(operator, [
      gateCase('f1', 'Ask whether child two is blocked.', 'Is child two blocked on phase three?'),
      gateCase('f2', 'Instruct the worker to hold phase three for review.', 'hold phase three until my review'),
    ]);
    expect(report.passed).toBe(false);
    expect(report.agreementRate).toBeLessThan(ENTRY_GATE_AGREEMENT_FLOOR);
  });

  it('counts a declared alternative as agreement', async () => {
    const { operator } = newOperator([move('hold phase three, do not release it')]);
    const report = await runInstrumentEntryGate(operator, [
      gateCase('f1', 'Instruct the worker to hold phase three.', 'hold phase three until my review', {
        alsoAcceptable: ['hold phase three, do not release it'],
      }),
    ]);
    expect(report.agreement).toBe(1);
    expect(report.passed).toBe(true);
  });

  it('reports a simulator failure as no line and no agreement', async () => {
    const { operator } = newOperator([move('run `npm test`'), move('run `npm test` again')]);
    const report = await runInstrumentEntryGate(operator, [
      gateCase('f1', 'Ask about the tests.', 'how did the tests go?'),
    ]);
    expect(report.cases[0].outcome).toBe('simulator-failure');
    expect(report.cases[0].spoken).toBeNull();
    expect(report.agreement).toBe(0);
    expect(report.passed).toBe(false);
  });

  it('fails the gate when the rejection rate exceeds the pre-registered ceiling', async () => {
    const { operator } = newOperator(['yes', 'yes, go ahead']);
    const report = await runInstrumentEntryGate(operator, [
      gateCase('f1', 'Ask whether child two is blocked.', 'Is child two blocked?'),
    ]);
    expect(report.rejected).toBe(2);
    expect(report.rejectionRate).toBe(1);
    expect(report.insufficientEvidence).toBe(true);
    expect(report.passed).toBe(false);
  });

  it('never hands the known line (or a frozen golden utterance) to the model', async () => {
    const { operator, scripted } = newOperator([move('Is child two blocked on phase three?')]);
    await runInstrumentEntryGate(operator, [
      gateCase('f1', 'Ask whether child two is blocked.', 'Is child two blocked on phase three?', {
        beat: beat({ id: 'f1', permissions: [], maxTurns: 1, utterance: 'GOLDEN-ANSWER-SENTENCE' }),
      }),
    ]);
    const prompt = scripted.calls[0].prompt;
    expect(prompt).not.toContain('GOLDEN-ANSWER-SENTENCE');
    expect(prompt).toContain('GOAL FOR THIS BEAT: Ask whether child two is blocked.');
  });

  it('aggregates the rejection rate across every case in the gate', async () => {
    const { operator } = newOperator([move('hold phase three'), move('run `npm test`'), move('run `npm test` again')]);
    const report = await runInstrumentEntryGate(operator, [
      gateCase('f1', 'Hold phase three.', 'hold phase three'),
      gateCase('f2', 'Check the tests.', 'how did the tests go?'),
    ]);
    expect(report.totalProposals).toBe(3);
    expect(report.rejected).toBe(2);
    expect(report.rejectionRate).toBeCloseTo(2 / 3, 5);
  });
});
