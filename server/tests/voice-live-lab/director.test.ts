/**
 * L6 director tests (plan §23; intent §14.5).
 *
 * The director is the only mechanical guard on an otherwise oracle-less
 * instrument, so these tests are written to fail loudly on the *dangerous*
 * direction of every rule: an unauthorised confirmation, a leaked world fact, a
 * line spoken while the beat is over. The permissive direction is asserted too
 * (a clean instruction is accepted), because an instrument that rejects
 * everything also produces no evidence and would look like a clean run.
 */
import { describe, expect, it } from 'vitest';

import type { ScenarioBeat } from '../../../scripts/voice-live-lab/lib/scenario.js';
import type { WorkerWorld } from '../../../scripts/voice-live-lab/lib/worlds.js';
import {
  Director,
  MAX_REJECTION_RATE,
  MAX_SAY_WORDS,
  REJECTION_REASONS,
  RejectionLedger,
  emptyReasonCounts,
  evaluateInstrument,
  formatReAsk,
  heardHasPendingProposal,
  isConfirmationShaped,
  containsWordRun,
  type BeatOutcome,
  type DirectorProposal,
  type HeardSegment,
  type ProposalContext,
} from '../../../scripts/voice-live-lab/lib/director.js';

const HIDDEN_FACT = 'the release branch is hold-phase-3';

function world(): WorkerWorld {
  return {
    schema: 'voice-lab.world/1',
    id: 'orchestrating-two-children',
    runtime: 'pi',
    initial: { activity: 'idle' },
    timeline: [],
    hiddenTruth: { releasePlan: HIDDEN_FACT },
  } as unknown as WorkerWorld;
}

function beat(overrides: Partial<ScenarioBeat> = {}): ScenarioBeat {
  return {
    id: 'b9-adaptive-tail',
    mode: 'adaptive',
    goal: 'Find out whether child 2 is blocked.',
    trigger: { after: 'candidate-silence', silenceMs: 800 },
    permissions: [],
    expect: {},
    ...overrides,
  };
}

function proposal(say: string | null, overrides: Partial<DirectorProposal> = {}): DirectorProposal {
  return { say, interrupt: false, waitMs: 0, beatDone: false, why: 'because', ...overrides };
}

function context(overrides: Partial<ProposalContext> = {}): ProposalContext {
  return { beat: beat(), heard: [], earlierLines: [], ...overrides };
}

function heard(text: string, overrides: Partial<HeardSegment> = {}): HeardSegment {
  return { index: 0, text, atSeconds: 1, ...overrides };
}

function director(): Director {
  return new Director({ scenarioId: 't1-s1', language: 'en-GB', world: world() });
}

// ---------------------------------------------------------------------------
// JSON shape
// ---------------------------------------------------------------------------

describe('director: JSON shape', () => {
  it('accepts a complete, valid move', () => {
    const decision = director().validate(proposal('Right, hold phase three until I say so.'), context());
    expect(decision.ok).toBe(true);
  });

  it('accepts a null say (staying silent is legal)', () => {
    const decision = director().validate(proposal(null), context());
    expect(decision.ok).toBe(true);
  });

  it('rejects a missing field as json-shape', () => {
    const decision = director().validate({ say: 'hello', interrupt: false, waitMs: 0, beatDone: false }, context());
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe('json-shape');
      expect(decision.detail).toContain('why');
    }
  });

  it('rejects a wrong type as json-shape', () => {
    const decision = director().validate({ ...proposal('hello'), interrupt: 'yes' }, context());
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe('json-shape');
  });

  it('rejects waitMs below zero', () => {
    const decision = director().validate(proposal('hello', { waitMs: -1 }), context());
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe('json-shape');
  });

  it('rejects waitMs above 4000', () => {
    const decision = director().validate(proposal('hello', { waitMs: 4001 }), context());
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe('json-shape');
  });

  it('rejects a non-integer waitMs', () => {
    const decision = director().validate(proposal('hello', { waitMs: 12.5 }), context());
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe('json-shape');
  });

  it('accepts the boundary waitMs values 0 and 4000', () => {
    expect(director().validate(proposal('hello', { waitMs: 0 }), context()).ok).toBe(true);
    expect(director().validate(proposal('hello', { waitMs: 4000 }), context()).ok).toBe(true);
  });

  it('strips unknown keys rather than inflating the rejection rate', () => {
    const decision = director().validate({ ...proposal('hello'), confidence: 0.9 }, context());
    expect(decision.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Length
// ---------------------------------------------------------------------------

describe('director: length', () => {
  it(`rejects ${MAX_SAY_WORDS + 1} words as over-length`, () => {
    const say = Array.from({ length: MAX_SAY_WORDS + 1 }, (_, index) => `word${index}`).join(' ');
    const decision = director().validate(proposal(say), context());
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe('over-length');
      expect(decision.detail).toContain(String(MAX_SAY_WORDS + 1));
    }
  });

  it(`accepts exactly ${MAX_SAY_WORDS} words`, () => {
    const say = Array.from({ length: MAX_SAY_WORDS }, (_, index) => `word${index}`).join(' ');
    expect(director().validate(proposal(say), context()).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Style
// ---------------------------------------------------------------------------

describe('director: style (British English, spoken prose)', () => {
  it('rejects a backtick code span', () => {
    const decision = director().validate(proposal('Run `npm test` and tell me what it says.'), context());
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe('style-violation');
  });

  it('rejects a markdown heading', () => {
    const decision = director().validate(proposal('## Status\nEverything is fine'), context());
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe('style-violation');
  });

  it('rejects markdown bold', () => {
    const decision = director().validate(proposal('Hold **phase three** please'), context());
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe('style-violation');
  });

  it('rejects a markdown link', () => {
    const decision = director().validate(proposal('See [the board](http://example.com) for it'), context());
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe('style-violation');
  });

  it('rejects a markdown list item', () => {
    const decision = director().validate(proposal('Right:\n- phase three\n- review'), context());
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe('style-violation');
  });

  it('rejects a spelled-out word', () => {
    const decision = director().validate(proposal('that is c-o-n-f-i-g by the way'), context());
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe('style-violation');
  });

  it('rejects a path read out character by character', () => {
    const decision = director().validate(proposal('go to src slash config slash default dot json'), context());
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe('style-violation');
  });

  it('rejects American spelling under en-GB', () => {
    const decision = director().validate(proposal('change the color of that panel'), context());
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe('style-violation');
      expect(decision.detail).toContain('colour');
    }
  });

  it('accepts the British spelling', () => {
    expect(director().validate(proposal('change the colour of that panel'), context()).ok).toBe(true);
  });

  it('applies the British rule only for an en-GB scenario language', () => {
    const american = new Director({ scenarioId: 't1-x', language: 'en-US', world: world() });
    expect(american.validate(proposal('change the color of that panel'), context()).ok).toBe(true);
    // Markdown is banned regardless of language.
    expect(american.validate(proposal('run `npm test`'), context()).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

describe('director: permissions', () => {
  const confirmBeat = beat({ permissions: ['confirm:current-draft'] });

  it('classifies a plain yes as a confirmation shape', () => {
    expect(isConfirmationShaped('yes, go ahead')).toBe(true);
    expect(isConfirmationShaped('tell it to hold phase three')).toBe(false);
    expect(isConfirmationShaped('did you send it?')).toBe(false);
  });

  it('rejects a confirmation when the beat grants no confirm permission', () => {
    const decision = director().validate(
      proposal('yes, go ahead'),
      context({ beat: beat({ permissions: [] }), heard: [heard('shall I send that to the worker?')] })
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe('permissions-violation');
  });

  it('rejects a confirmation when nothing was heard proposing it', () => {
    const decision = director().validate(proposal('yes, go ahead'), context({ beat: confirmBeat, heard: [] }));
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe('permissions-violation');
  });

  it('accepts a confirmation when the beat grants it and a proposal was heard', () => {
    const decision = director().validate(
      proposal('yes, go ahead'),
      context({ beat: confirmBeat, heard: [heard('shall I send that to the worker?')] })
    );
    expect(decision.ok).toBe(true);
  });

  it('does not treat an ordinary question as a pending proposal', () => {
    expect(heardHasPendingProposal([heard('what is worker two doing?')])).toBe(false);
    expect(heardHasPendingProposal([heard('I can send it to the worker now')])).toBe(true);
  });

  it('still accepts a non-confirmation instruction on a beat with no permissions', () => {
    const decision = director().validate(proposal('tell it to hold phase three'), context());
    expect(decision.ok).toBe(true);
  });

  it('rejects pushback-style confirmation without a grant', () => {
    const decision = director().validate(
      proposal("just do it, don't ask me every single time"),
      context({ beat: beat({ permissions: [] }), heard: [heard('shall I send that?')] })
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe('permissions-violation');
  });

  it('accepts a confirmation on a card:confirm grant', () => {
    const decision = director().validate(
      proposal('yes'),
      context({ beat: beat({ permissions: ['card:confirm'] }), heard: [heard('shall I send it over?')] })
    );
    expect(decision.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Golden-truth leakage
// ---------------------------------------------------------------------------

describe('director: golden-truth leakage', () => {
  it('rejects a hidden fact the operator has not heard', () => {
    const decision = director().validate(
      proposal('The release branch is hold-phase-3, so nothing moves.'),
      context()
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe('golden-truth-leakage');
  });

  it('never writes the leaked fact into the ledger', () => {
    const local = director();
    const decision = local.validate(proposal('The release branch is hold-phase-3.'), context());
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.detail).not.toContain('hold-phase-3');
      expect(decision.message).not.toContain('hold-phase-3');
    }
    expect(local.rejections.entries[0].say).toBeNull();
  });

  it('allows a fact that has already been revealed in what was heard', () => {
    const decision = director().validate(
      proposal('Right, so the release branch is hold-phase-3 then.'),
      context({ heard: [heard('the release branch is hold-phase-3 according to the worker')] })
    );
    expect(decision.ok).toBe(true);
  });

  it('allows a fact the operator itself already said this beat', () => {
    const decision = director().validate(
      proposal('as I said, the release branch is hold-phase-3'),
      context({ earlierLines: ['the release branch is hold-phase-3'] })
    );
    expect(decision.ok).toBe(true);
  });

  it('does not fire on a partial phrase', () => {
    const decision = director().validate(proposal('the release branch is fine'), context());
    expect(decision.ok).toBe(true);
  });

  it('matches whole words, not substrings', () => {
    expect(containsWordRun('the hold phase is fine', 'hold')).toBe(true);
    expect(containsWordRun('holding pattern', 'hold')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Interruption
// ---------------------------------------------------------------------------

describe('director: disallowed interrupt', () => {
  it('rejects an interrupt on a beat that forbids it', () => {
    const decision = director().validate(proposal('actually, never mind', { interrupt: true }), context());
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe('disallowed-interrupt');
  });

  it('accepts an interrupt when the beat is flagged interrupt', () => {
    const decision = director().validate(
      proposal('actually, never mind', { interrupt: true }),
      context({ beat: beat({ interrupt: true }) })
    );
    expect(decision.ok).toBe(true);
  });

  it('accepts an interrupt on a stop-talker grant', () => {
    const decision = director().validate(
      proposal('stop, stop', { interrupt: true }),
      context({ beat: beat({ permissions: ['stop-talker'] }) })
    );
    expect(decision.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Turn budget
// ---------------------------------------------------------------------------

describe('director: turn budget', () => {
  it('rejects a spoken turn once the beat budget is exhausted', () => {
    const local = new Director({ scenarioId: 't1-s1', language: 'en-GB' });
    const bounded = beat({ maxTurns: 1 });
    expect(local.validate(proposal('first line'), context({ beat: bounded })).ok).toBe(true);
    const second = local.validate(proposal('second line'), context({ beat: bounded }));
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('turn-budget');
  });

  it('rejects a spoken turn once the run budget is exhausted', () => {
    const local = new Director({ scenarioId: 't1-s1', language: 'en-GB', maxOperatorTurns: 1 });
    expect(local.validate(proposal('first line'), context()).ok).toBe(true);
    const second = local.validate(proposal('second line'), context());
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('turn-budget');
  });

  it('does not spend turn budget on a silent move', () => {
    const local = new Director({ scenarioId: 't1-s1', language: 'en-GB', maxOperatorTurns: 1 });
    expect(local.validate(proposal(null), context()).ok).toBe(true);
    expect(local.validate(proposal(null), context()).ok).toBe(true);
    expect(local.turnsUsed).toBe(0);
    expect(local.validate(proposal('now I speak'), context()).ok).toBe(true);
    expect(local.turnsUsed).toBe(1);
  });

  it('counts turns per beat, not globally', () => {
    const local = new Director({ scenarioId: 't1-s1', language: 'en-GB' });
    const first = beat({ id: 'b9', maxTurns: 1 });
    const second = beat({ id: 'b10', maxTurns: 1 });
    expect(local.validate(proposal('a'), context({ beat: first })).ok).toBe(true);
    expect(local.validate(proposal('b'), context({ beat: second })).ok).toBe(true);
    expect(local.turnsUsedIn('b9')).toBe(1);
    expect(local.turnsUsedIn('b10')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Ledger, rates and attribution
// ---------------------------------------------------------------------------

describe('director: rejection ledger and the Gate 4 rule', () => {
  it('counts every proposal, including re-asks, and reports the rate', () => {
    const ledger = new RejectionLedger();
    ledger.noteProposal();
    ledger.noteAccepted();
    ledger.noteProposal();
    ledger.record({ reason: 'over-length', detail: 'too long', beatId: 'b9', say: 'x' });
    expect(ledger.totalProposals).toBe(2);
    expect(ledger.rejectedCount).toBe(1);
    expect(ledger.rejectionRate).toBe(0.5);
  });

  it('reports a zero rate for an instrument that never proposed', () => {
    const ledger = new RejectionLedger();
    expect(ledger.rejectionRate).toBe(0);
    expect(ledger.insufficientEvidence()).toBe(false);
  });

  it('breaks rejections down by reason', () => {
    const local = new Director({ scenarioId: 't1-s1', language: 'en-GB' });
    local.validate(proposal(Array.from({ length: 61 }, (_, index) => `word${index}`).join(' ')), context());
    local.validate(proposal('run `npm test`'), context());
    local.validate(proposal('yes'), context());
    const counts = local.rejections.byReason();
    expect(counts['over-length']).toBe(1);
    expect(counts['style-violation']).toBe(1);
    expect(counts['permissions-violation']).toBe(1);
    expect(Object.keys(counts).sort()).toEqual([...REJECTION_REASONS].sort());
  });

  it('flags insufficient-evidence only ABOVE the pre-registered ceiling', () => {
    const atCeiling = new RejectionLedger();
    for (let index = 0; index < 5; index += 1) {
      atCeiling.noteProposal();
      if (index === 0) atCeiling.record({ reason: 'json-shape', detail: '', beatId: 'b9', say: null });
    }
    expect(atCeiling.rejectionRate).toBeCloseTo(MAX_REJECTION_RATE, 10);
    expect(atCeiling.insufficientEvidence()).toBe(false);

    const aboveCeiling = new RejectionLedger();
    for (let index = 0; index < 4; index += 1) {
      aboveCeiling.noteProposal();
      if (index < 2) aboveCeiling.record({ reason: 'json-shape', detail: '', beatId: 'b9', say: null });
    }
    expect(aboveCeiling.rejectionRate).toBe(0.5);
    expect(aboveCeiling.insufficientEvidence()).toBe(true);
  });

  it('excludes simulator-failure beats from every candidate denominator', () => {
    const ledger = new RejectionLedger();
    ledger.noteProposal();
    ledger.noteAccepted();
    const beats: BeatOutcome[] = [
      { beatId: 'b9', mode: 'adaptive', status: 'simulator-failure' },
      { beatId: 'b3', mode: 'frozen', status: 'completed' },
      { beatId: 'b5', mode: 'frozen', status: 'missed-condition' },
    ];
    const report = evaluateInstrument(ledger, beats);
    expect(report.simulatorFailures).toEqual(['b9']);
    expect(report.excludedBeats).toEqual(['b9', 'b5']);
    expect(report.scorableBeats).toEqual(['b3']);
    expect(report.insufficientEvidence).toBe(false);
  });

  it('flags an adaptive-only headline as restricted', () => {
    const ledger = new RejectionLedger();
    const adaptiveOnly = evaluateInstrument(ledger, [{ beatId: 'b9', mode: 'adaptive', status: 'completed' }]);
    expect(adaptiveOnly.adaptiveOnly).toBe(true);
    const mixed = evaluateInstrument(ledger, [
      { beatId: 'b9', mode: 'adaptive', status: 'completed' },
      { beatId: 'b3', mode: 'frozen', status: 'completed' },
    ]);
    expect(mixed.adaptiveOnly).toBe(false);
  });

  it('reports the ceiling it applied', () => {
    const report = evaluateInstrument(new RejectionLedger(), [], { ceiling: 0.1 });
    expect(report.ceiling).toBe(0.1);
  });

  it('exposes every reason as a zeroed counter', () => {
    const counts = emptyReasonCounts();
    for (const reason of REJECTION_REASONS) expect(counts[reason]).toBe(0);
  });

  it('formats the re-ask with the reason and the revision instruction', () => {
    const local = new Director({ scenarioId: 't1-s1', language: 'en-GB' });
    const decision = local.validate(proposal('run `npm test`'), context());
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      const text = formatReAsk(decision);
      expect(text).toContain('rejected by the director because');
      expect(text).toContain('style-violation');
      expect(text).toContain('Please revise your response to respect the rules.');
    }
  });
});
