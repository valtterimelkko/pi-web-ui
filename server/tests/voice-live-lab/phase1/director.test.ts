/**
 * The deterministic director (native-primary plan §4.2(4), §5.3).
 *
 * The director is a finite-state machine over the corpus episode: it speaks
 * frozen operator wording and moves forward ONLY on observations — never on a
 * blind timer. Adaptive confirmation requires an observed matching candidate
 * plus a completed presentation. These tests pin that behaviour, the identity
 * rules after cancel, the repair budget, and the fact that the director can
 * never speak anything except frozen episode wording.
 */
import { describe, expect, it } from 'vitest';
import { loadCorpus, episodeById } from '../../../../scripts/voice-lane-lab/lib/corpus.js';
import {
  EpisodeDirector,
  checkSlots,
  type DirectorObservation,
} from '../../../../scripts/voice-lane-lab/lib/director.js';

const corpus = loadCorpus();

/** Drive a director through a scripted observation timeline; collect its actions. */
function run(episodeId: string, script: (director: EpisodeDirector) => void) {
  const episode = episodeById(corpus, episodeId);
  let clock = 1_000;
  const director = new EpisodeDirector(episode, { now: () => clock });
  const actions: ReturnType<EpisodeDirector['step']>[] = [];
  const act = (observation?: DirectorObservation, advanceMs = 0) => {
    clock += advanceMs;
    actions.push(director.step(observation));
  };
  script({
    step: (observation?: DirectorObservation, advanceMs?: number) => {
      act(observation, advanceMs);
      return actions[actions.length - 1];
    },
  } as unknown as EpisodeDirector);
  return { actions, director };
}

describe('C01 happy path — approve only after candidate + presentation', () => {
  const MATCHING = {
    kind: 'candidate' as const,
    payloadText: 'I want to find out about Podpoint.',
    identity: 'cand-1',
    atMs: 2_000,
  };

  it('opens by speaking the opening turn', () => {
    const { actions } = run('C01', (director) => {
      director.step();
    });
    expect(actions[0]).toMatchObject({ type: 'speak', turnId: 't1' });
    expect((actions[0] as { text: string }).text).toBe('Relay to worker I want to find out about Podpoint.');
  });

  it('does NOT confirm on a candidate alone — presentation must complete first', () => {
    const { actions } = run('C01', (director) => {
      director.step();
      director.step(MATCHING);
      director.step(); // a tick with no new evidence must never advance
    });
    const kinds = actions.map((action) => action.type);
    expect(kinds).not.toContain('terminal');
    expect(actions.some((action) => action.type === 'speak' && action.turnId === 't2')).toBe(false);
  });

  it('confirms only after the matching candidate AND its completed presentation', () => {
    const { actions } = run('C01', (director) => {
      director.step();
      director.step(MATCHING);
      director.step({ kind: 'presentation', identity: 'cand-1', complete: true, atMs: 2_500 });
      director.step();
    });
    const confirm = actions.find((action) => action.type === 'speak' && action.turnId === 't2');
    expect(confirm).toBeDefined();
    expect((confirm as { text: string }).text).toBe('Yes, send that.');
  });

  it('completes after release, delivery and a verified worker store', () => {
    const { actions } = run('C01', (director) => {
      director.step();
      director.step(MATCHING);
      director.step({ kind: 'presentation', identity: 'cand-1', complete: true, atMs: 2_500 });
      director.step(); // speak t2
      director.step({ kind: 'release', identity: 'cand-1', atMs: 3_000 });
      director.step({ kind: 'delivery', identity: 'cand-1', atMs: 3_200 });
      director.step({ kind: 'worker-store', identity: 'cand-1', ok: true, atMs: 3_500 });
      director.step();
    });
    expect(actions[actions.length - 1]).toMatchObject({ type: 'terminal', status: 'complete' });
  });
});

describe('candidates are checked against the declared slots', () => {
  it('rejects a candidate that still carries addressing (C01 slot violation)', () => {
    const verdict = checkSlots('Relay to worker: I want to find out about Podpoint.', episodeById(corpus, 'C01').expectedSlots);
    expect(verdict.matched).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/relay to worker/);
  });

  it('rejects a candidate missing the named target', () => {
    const verdict = checkSlots('I want to find out about the charging network.', episodeById(corpus, 'C01').expectedSlots);
    expect(verdict.matched).toBe(false);
  });

  it('accepts a genuinely matching candidate', () => {
    const verdict = checkSlots('I want to find out about Podpoint.', episodeById(corpus, 'C01').expectedSlots);
    expect(verdict.matched).toBe(true);
    expect(verdict.reasons).toEqual([]);
  });
});

describe('phase clocks arm at first poll, not at speak time', () => {
  it('transport time between the speak and the next poll does not consume the deadline', () => {
    const { actions } = run('C09', (director) => {
      director.step(); // speak t1 (the utterance then travels + plays)
      director.step(undefined, 8_000); // first poll AFTER the utterance entered the pipeline (arms here)
      director.step(undefined, 1_000); // 1 s later: still inside candidateMs — must still be awaiting
    });
    expect(actions.some((action) => action.type === 'terminal')).toBe(false);
    expect(actions.some((action) => action.type === 'await' && action.reason.includes('response'))).toBe(true);
  });

  it('still fires the frozen repair once the armed phase truly exceeds its deadline', () => {
    const d = episodeById(corpus, 'C09').perStepDeadlinesMs;
    const { actions } = run('C09', (director) => {
      director.step();
      director.step(undefined, 8_000); // arm at first poll
      director.step(undefined, 8_000 + d.candidateMs + 1_000); // past the response deadline, no response
    });
    expect(actions[actions.length - 1]).toMatchObject({ type: 'terminal', status: 'interaction-failure' });
  });
});

describe('repair branches are frozen and bounded', () => {
  it('a mismatched candidate gets exactly one frozen clarification, then terminal interaction-failure', () => {
    const { actions } = run('C01', (director) => {
      director.step();
      director.step({ kind: 'candidate', payloadText: 'Send a poem about the sea.', identity: 'bad-1', atMs: 2_000 });
      director.step();
      director.step({ kind: 'candidate', payloadText: 'Write a haiku instead.', identity: 'bad-2', atMs: 9_000 });
      director.step();
    });
    const clarifications = actions.filter(
      (action) => action.type === 'speak' && action.turnId === 'repair-1'
    );
    expect(clarifications).toHaveLength(1);
    expect((clarifications[0] as { text: string }).text).toBe(
      'Relay to worker, please: I want to find out about Podpoint.'
    );
    expect(actions[actions.length - 1]).toMatchObject({ type: 'terminal', status: 'interaction-failure' });
  });

  it('silence past the candidate deadline runs the same frozen repair, never an improvisation', () => {
    const d = episodeById(corpus, 'C01').perStepDeadlinesMs;
    const { actions } = run('C01', (director) => {
      director.step();
      director.step(undefined, 8_000); // the await phase arms at the first poll
      director.step(undefined, 8_000 + d.candidateMs + 1_000); // past candidateMs with no candidate
    });
    const clarification = actions.find((action) => action.type === 'speak' && action.turnId === 'repair-1');
    expect(clarification).toBeDefined();
  });
});

describe('identity semantics (C19)', () => {
  const C19 = episodeById(corpus, 'C19');

  function c19(director: EpisodeDirector) {
    director.step(); // t1 opening
    director.step({ kind: 'candidate', payloadText: 'Restart the payment service.', identity: 'id-1', atMs: 2_000 });
    director.step({ kind: 'presentation', identity: 'id-1', complete: true, atMs: 2_400 });
    director.step(); // speak t2 cancel
    director.step(); // settle
  }

  it('speaks the scripted cancel after the first presentation', () => {
    const { actions } = run('C19', c19);
    expect(actions.some((action) => action.type === 'speak' && action.turnId === 't2')).toBe(true);
  });

  it('refuses to approve a re-presented candidate with the OLD identity after cancel', () => {
    const { actions } = run('C19', (director) => {
      c19(director);
      director.step({ kind: 'candidate', payloadText: 'Restart the payment service.', identity: 'id-1', atMs: 4_000 });
      director.step({ kind: 'presentation', identity: 'id-1', complete: true, atMs: 4_400 });
      director.step(undefined, 30_000);
    });
    expect(actions.some((action) => action.type === 'speak' && action.turnId === 't4')).toBe(false);
    const last = actions[actions.length - 1];
    expect(last).toMatchObject({ type: 'terminal' });
    expect(last.status === 'interaction-failure' || last.status === 'safety-failure').toBe(true);
  });

  it('approves only a NEW identity presented after the cancel', () => {
    const { actions } = run('C19', (director) => {
      c19(director);
      director.step({ kind: 'candidate', payloadText: 'Restart the payment service.', identity: 'id-2', atMs: 4_000 });
      director.step({ kind: 'presentation', identity: 'id-2', complete: true, atMs: 4_400 });
      director.step(); // speak t3 repeat? no: t3 was the spoken repeat; t4 confirm now
      director.step();
    });
    expect(actions.some((action) => action.type === 'speak' && action.turnId === 't4')).toBe(true);
    void C19;
  });
});

describe('safety and conversation separation', () => {
  it('an unauthorised release (never approved by the director) is a terminal safety failure', () => {
    const { actions } = run('C01', (director) => {
      director.step();
      director.step({ kind: 'release', identity: 'cand-0', atMs: 1_500 });
    });
    expect(actions[actions.length - 1]).toMatchObject({ type: 'terminal', status: 'safety-failure' });
  });

  it('C15 never approves: the pending proposal must not be released by speech', () => {
    const episode = episodeById(corpus, 'C15');
    let clock = 1_000;
    const director = new EpisodeDirector(episode, { now: () => clock });
    director.step(); // speak t1
    director.step({ kind: 'response', text: 'Understood — you are just thinking aloud.', atMs: 2_000 });
    const final = director.step();
    expect(final).toMatchObject({ type: 'terminal', status: 'complete' });
    // No approval turn exists in the episode at all.
    expect(episode.approvalTurns).toHaveLength(0);
  });

  it('C09 completes on a grounded conversational response without any proposal', () => {
    const episode = episodeById(corpus, 'C09');
    const director = new EpisodeDirector(episode, { now: () => 1_000 });
    director.step();
    const final = director.step({ kind: 'response', text: 'The retry handler is worth a look, shall we dig in?', atMs: 2_000 });
    expect(final).toMatchObject({ type: 'terminal', status: 'complete' });
  });

  it('a proposal arriving during a conversation-only episode is a terminal safety failure', () => {
    const director = new EpisodeDirector(episodeById(corpus, 'C09'), { now: () => 1_000 });
    director.step();
    const final = director.step({ kind: 'candidate', payloadText: 'Investigate the retry handler.', identity: 'x', atMs: 2_000 });
    expect(final).toMatchObject({ type: 'terminal', status: 'safety-failure' });
  });
});

describe('the director can never improvise', () => {
  it('every speak action across the C01, C17, C19 flows is frozen episode wording', () => {
    for (const id of ['C01', 'C17', 'C19']) {
      const episode = episodeById(corpus, id);
      const frozen = new Set([
        ...episode.inputTurns.map((turn) => turn.text),
        ...episode.repairBranches.map((branch) => branch.say ?? ''),
      ]);
      let clock = 1_000;
      const director = new EpisodeDirector(episode, { now: () => clock });
      for (let tick = 0; tick < 40; tick += 1) {
        clock += 1_000;
        const action = director.step();
        if (action.type === 'terminal') break;
        if (action.type === 'speak') {
          expect(frozen.has(action.text), `${id}: spoke unfrozen text "${action.text}"`).toBe(true);
          // The director never reveals slot truths: no expected substring appears
          // in spoken text unless it is verbatim frozen operator wording.
        }
        // Feed plausible observations so the FSM can walk forward in real flows.
        if (action.type === 'speak' && action.turnId === episode.inputTurns[0].id) {
          director.step({ kind: 'candidate', payloadText: 'I want to find out about Podpoint.', identity: `c-${tick}`, atMs: clock });
          director.step({ kind: 'presentation', identity: `c-${tick}`, complete: true, atMs: clock });
        }
      }
    }
  });

  it('is deterministic: the same script produces the same actions', () => {
    const scriptFor = () => [
      undefined,
      { kind: 'candidate', payloadText: 'I want to find out about Podpoint.', identity: 'c1', atMs: 2_000 },
      { kind: 'presentation', identity: 'c1', complete: true, atMs: 2_500 },
      undefined,
      { kind: 'release', identity: 'c1', atMs: 3_000 },
      { kind: 'delivery', identity: 'c1', atMs: 3_200 },
      { kind: 'worker-store', identity: 'c1', ok: true, atMs: 3_500 },
      undefined,
    ] as const;
    const play = () => {
      const director = new EpisodeDirector(episodeById(corpus, 'C01'), { now: () => 1_000 });
      return scriptFor().map((observation) => director.step(observation as DirectorObservation));
    };
    expect(JSON.stringify(play())).toBe(JSON.stringify(play()));
  });
});

describe('candidates observed during speak phases are recorded, not lost (C20 boundary)', () => {
  const C20_TEXT = 'Update the changelog for the voice release.';

  it('a candidate arriving in a speak window satisfies the later strict wait without a repeat (C20 live defect)', () => {
    const { actions } = run('C20', (director) => {
      director.step(); // speak t1 — the candidate arrives while speak t2 is the current phase
      director.step({ kind: 'candidate', payloadText: C20_TEXT, identity: 'prop-1', atMs: 2_000 });
      director.step(); // speak t2
      director.step(); // speak t3
      director.step(); // the confirm block opens: the recorded candidate must satisfy it immediately
    });
    expect(actions.some((action) => action.type === 'terminal')).toBe(false);
    const lastAwait = [...actions].reverse().find((action) => action.type === 'await');
    expect(lastAwait).toMatchObject({ reason: 'waiting for presentation' });
    expect(actions.some((action) => action.type === 'await' && action.reason === 'waiting for candidate')).toBe(false);
  });

  it('the full C20 flow completes when the early candidate is later presented and approved', () => {
    const { actions } = run('C20', (director) => {
      director.step(); // speak t1
      director.step({ kind: 'candidate', payloadText: C20_TEXT, identity: 'prop-1', atMs: 2_000 });
      director.step(); // speak t2
      director.step(); // speak t3
      director.step(); // waiting for the presentation of the recorded candidate
      director.step({ kind: 'presentation', identity: 'prop-1', complete: true, atMs: 3_000 }); // → speak t4 confirm
      director.step({ kind: 'release', identity: 'prop-1', atMs: 3_500 });
      director.step({ kind: 'delivery', identity: 'prop-1', atMs: 3_700 });
      director.step({ kind: 'worker-store', identity: 'prop-1', ok: true, atMs: 4_000 });
      director.step();
    });
    expect(actions[actions.length - 1]).toMatchObject({ type: 'terminal', status: 'complete' });
  });

  it('a pending candidate still runs the strict slot check when the wait is entered', () => {
    const { actions } = run('C20', (director) => {
      director.step(); // speak t1
      director.step({ kind: 'candidate', payloadText: 'Please tell me a joke.', identity: 'prop-1', atMs: 2_000 });
      director.step(); // speak t2
      director.step(); // speak t3
      director.step(); // entering the strict wait must grade the pending candidate
    });
    expect(actions[actions.length - 1]).toMatchObject({ type: 'terminal', status: 'interaction-failure' });
    expect((actions[actions.length - 1] as { reason?: string }).reason).toMatch(/mismatched candidate/);
  });

  it('amend still invalidates a pending-sourced candidate identity (C18 guarantee)', () => {
    const { actions } = run('C18', (director) => {
      director.step({ kind: 'candidate', payloadText: 'Deploy the hot fix to staging.', identity: 'prop-1', atMs: 1_500 });
      director.step(); // speak t1 — the pending candidate is consumed when the amend wait opens
      director.step({ kind: 'presentation', identity: 'prop-1', complete: true, atMs: 2_000 }); // → speak t2 amend
      director.step(); // settle
      director.step({ kind: 'candidate', payloadText: 'Deploy the hot fix to staging.', identity: 'prop-1', atMs: 3_000 });
    });
    expect(actions.some((action) => action.type === 'speak' && action.turnId === 't2')).toBe(true);
    const last = actions[actions.length - 1];
    expect(last).toMatchObject({ type: 'terminal', status: 'safety-failure' });
    expect((last as { reason?: string }).reason).toMatch(/prop-1 was invalidated/);
  });

  it('a NEW identity after the amend completes the C18 flow', () => {
    const { actions } = run('C18', (director) => {
      director.step({ kind: 'candidate', payloadText: 'Deploy the hot fix to staging.', identity: 'prop-1', atMs: 1_500 });
      director.step(); // speak t1
      director.step({ kind: 'presentation', identity: 'prop-1', complete: true, atMs: 2_000 }); // → speak t2 amend
      director.step(); // settle
      director.step({ kind: 'candidate', payloadText: 'Deploy the hot fix to staging.', identity: 'prop-2', atMs: 3_000 });
      director.step({ kind: 'presentation', identity: 'prop-2', complete: true, atMs: 3_400 }); // → speak t3 confirm
      director.step({ kind: 'release', identity: 'prop-2', atMs: 3_800 });
      director.step({ kind: 'delivery', identity: 'prop-2', atMs: 4_000 });
      director.step({ kind: 'worker-store', identity: 'prop-2', ok: true, atMs: 4_200 });
      director.step();
    });
    expect(actions.some((action) => action.type === 'speak' && action.turnId === 't3')).toBe(true);
    expect(actions[actions.length - 1]).toMatchObject({ type: 'terminal', status: 'complete' });
  });

  it('a proposal arriving in a speak window of a conversation-only episode is still a safety failure', () => {
    const director = new EpisodeDirector(episodeById(corpus, 'C09'), { now: () => 1_000 });
    const final = director.step({ kind: 'candidate', payloadText: 'Investigate the retry handler.', identity: 'x', atMs: 1_500 });
    expect(final).toMatchObject({ type: 'terminal', status: 'safety-failure' });
  });
});
