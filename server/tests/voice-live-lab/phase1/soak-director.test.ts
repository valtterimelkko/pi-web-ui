/**
 * W4 director extensions: the soak step kinds (pace, reconnect) and the
 * busy-parking promote path (a `parked` observation and an `adaptive-promote`
 * turn that promotes EXACTLY ONE parked item through the product's own path).
 *
 * The director stays deterministic: the same observation script always
 * produces the same action sequence, including the new actions.
 */
import { describe, expect, it } from 'vitest';

import {
  EpisodeSchema,
  episodeById,
  loadCorpus,
  type Episode,
} from '../../../../scripts/voice-lane-lab/lib/corpus.js';
import { EpisodeDirector, type DirectorObservation } from '../../../../scripts/voice-lane-lab/lib/director.js';
import {
  SOAK_EPISODE_ID,
  loadSoakPlan,
  soakEpisodeFromPlan,
  withSoakEpisode,
} from '../../../../scripts/voice-lane-lab/lib/soak-plan.js';

const corpus = loadCorpus();
const REPO = new URL('../../../../scripts/voice-lane-lab/corpus', import.meta.url).pathname;

/** Drive a director over a scripted (observation, dt) list; collect rows. */
function drive(episode: Episode, script: Array<{ observation?: DirectorObservation; advanceMs?: number }>) {
  let clock = 1_000;
  const director = new EpisodeDirector(episode, { now: () => clock });
  const rows: Array<{ atMs: number; observation?: DirectorObservation; action: ReturnType<EpisodeDirector['step']> }> = [];
  for (const entry of script) {
    clock += entry.advanceMs ?? 100;
    const action = director.step(entry.observation);
    rows.push({ atMs: clock, observation: entry.observation, action });
    if (action.type === 'terminal') break;
  }
  return { rows, director };
}

describe('the soak director program', () => {
  it('paces, reconnects exactly once, and completes the two relay cycles with the pending proposal confirmed after the reconnect', () => {
    const episode = soakEpisodeFromPlan(loadSoakPlan(REPO), corpus);
    const candidate = { kind: 'candidate', payloadText: 'I want to find out about Podpoint.', identity: 'p1', atMs: 5_000 } as const;
    const presentation = { kind: 'presentation', identity: 'p1', complete: true, atMs: 9_000 } as const;
    const candidate2 = { kind: 'candidate', payloadText: 'I want to find out about Podpoint.', identity: 'p2', atMs: 400_000 } as const;
    const presentation2 = { kind: 'presentation', identity: 'p2', complete: true, atMs: 404_000 } as const;
    const { rows } = drive(episode, [
      // s01: opening relay instruction
      { advanceMs: 2_000 },
      { observation: candidate, advanceMs: 3_000 },
      { observation: presentation, advanceMs: 4_000 },
      // s02: conversational turn + its response
      { advanceMs: 2_000 },
      { observation: { kind: 'response', text: 'Noted — the deploy takes nearly ten minutes.', atMs: 20_000 }, advanceMs: 1_000 },
      // soak-pace
      { advanceMs: 1_000 },
      // soak-reconnect
      { advanceMs: 1_000 },
      // s04: confirm P1 — pending work survives the reconnect
      { advanceMs: 2_000 },
      { observation: { kind: 'release', identity: 'p1', atMs: 40_000 }, advanceMs: 2_000 },
      { observation: { kind: 'delivery', identity: 'p1', atMs: 42_000 }, advanceMs: 2_000 },
      { observation: { kind: 'worker-store', identity: 'p1', ok: true, atMs: 44_000 }, advanceMs: 1_000 },
      // soak-pace
      { advanceMs: 1_000 },
      // s06: second relay cycle
      { advanceMs: 2_000 },
      { observation: candidate2, advanceMs: 3_000 },
      { observation: presentation2, advanceMs: 4_000 },
      // s07 conversational + response
      { advanceMs: 2_000 },
      { observation: { kind: 'response', text: 'Still holding.', atMs: 410_000 }, advanceMs: 1_000 },
      // soak-pace
      { advanceMs: 1_000 },
      // s09: confirm P2
      { advanceMs: 2_000 },
      { observation: { kind: 'release', identity: 'p2', atMs: 420_000 }, advanceMs: 2_000 },
      { observation: { kind: 'delivery', identity: 'p2', atMs: 422_000 }, advanceMs: 2_000 },
      { observation: { kind: 'worker-store', identity: 'p2', ok: true, atMs: 424_000 }, advanceMs: 1_000 },
      // s10 conversational closer + response
      { advanceMs: 2_000 },
      { observation: { kind: 'response', text: 'Session remains live.', atMs: 430_000 }, advanceMs: 1_000 },
      // soak-pace, then the trailing release/delivery/store tail is already consumed
      { advanceMs: 1_000 },
    ]);

    const actions = rows.map((row) => row.action);
    const reconnects = actions.filter((action) => action.type === 'reconnect-transport');
    expect(reconnects).toHaveLength(1);
    const paces = actions.filter((action) => action.type === 'pace');
    expect(paces.length).toBeGreaterThanOrEqual(4);
    expect(paces.every((action) => action.type === 'pace' && action.ms >= 60_000)).toBe(true);
    const speaks = actions.filter((action) => action.type === 'speak');
    expect(speaks.length).toBe(8); // the committed plan's eight operator turns
    // no pace/reconnect action ever fabricates speech
    expect(actions.every((action) => action.type !== 'pace' || !('text' in action))).toBe(true);
    // the flow completes
    expect(actions[actions.length - 1]).toMatchObject({ type: 'terminal', status: 'complete' });
    // the confirm for p1 came AFTER the reconnect action
    const reconnectAt = rows[rows.findIndex((row) => row.action.type === 'reconnect-transport')].atMs;
    const confirmP1 = rows.find((row) => row.action.type === 'speak' && row.action.turnId === 's05');
    expect(confirmP1).toBeDefined();
    expect(confirmP1!.atMs).toBeGreaterThan(reconnectAt);
  });
});

describe('the busy-parking promote path', () => {
  /** A minimal busy-parking episode in the C22 family shape (t1 opening relayed while busy, t2 promote, t3 confirm). */
  function parkingEpisode(): Episode {
    const base = episodeById(corpus, 'C01');
    const episode: Episode = {
      ...base,
      id: 'C22',
      title: 'test: busy parking, one promotion',
      permittedRouteOutcomes: ['parks-while-busy'],
      inputTurns: [
        { id: 't1', kind: 'opening', text: base.inputTurns[0]!.text, requiredWords: base.inputTurns[0]!.requiredWords },
        { id: 't2', kind: 'adaptive-promote', text: '', requiredWords: [] },
        { id: 't3', kind: 'adaptive-confirm', text: base.inputTurns[1]!.text, requiredWords: base.inputTurns[1]!.requiredWords },
      ],
      approvalTurns: [{ turnId: 't3', precondition: 'candidate-matched+presentation-complete' }],
      expectedFinalWorkerArtefact: {
        kind: 'parked-item-promoted',
        description: 'the one promoted parked item becomes the approved worker input',
      },
    };
    const parsed = EpisodeSchema.safeParse(episode);
    expect(parsed.success).toBe(true);
    return parsed.success ? parsed.data : episode;
  }

  it('promotes EXACTLY ONE parked item, then flows candidate → presentation → confirm → release → store', () => {
    const parked = { kind: 'parked', itemId: 'item-7', atMs: 8_000 } as const;
    const candidate = { kind: 'candidate', payloadText: 'I want to find out about Podpoint.', identity: 'p9', atMs: 12_000 } as const;
    const { rows, director } = drive(parkingEpisode(), [
      { advanceMs: 2_000 }, // speak t1
      { observation: parked, advanceMs: 2_000 }, // the mount parked the relay
      { advanceMs: 1_000 }, // promote action
      { observation: candidate, advanceMs: 2_000 }, // promotion created the proposal
      { observation: { kind: 'presentation', identity: 'p9', complete: true, atMs: 14_000 }, advanceMs: 2_000 },
      { advanceMs: 2_000 }, // speak t3 confirm
      { observation: { kind: 'release', identity: 'p9', atMs: 20_000 }, advanceMs: 2_000 },
      { observation: { kind: 'delivery', identity: 'p9', atMs: 22_000 }, advanceMs: 2_000 },
      { observation: { kind: 'worker-store', identity: 'p9', ok: true, atMs: 24_000 }, advanceMs: 1_000 },
    ]);
    const actions = rows.map((row) => row.action);
    const promotes = actions.filter((action) => action.type === 'promote');
    expect(promotes).toHaveLength(1);
    expect(promotes[0]).toMatchObject({ type: 'promote', itemId: 'item-7' }); // the observed item, named — never fabricated
    expect(actions.filter((action) => action.type === 'speak').map((action) => (action as { turnId: string }).turnId)).toEqual(['t1', 't3']);
    expect(actions[actions.length - 1]).toMatchObject({ type: 'terminal', status: 'complete' });
    expect(director.state.approvedIdentity).toBe('p9');
  });

  it('never promotes without an observed parked item (the park is a product observation, not an assumption)', () => {
    const candidate = { kind: 'candidate', payloadText: 'I want to find out about Podpoint.', identity: 'p9', atMs: 12_000 } as const;
    const { rows } = drive(parkingEpisode(), [
      { advanceMs: 2_000 }, // speak t1
      // no parked observation ever arrives; the await-parked deadline is long
      { advanceMs: 1_000 },
      { advanceMs: 1_000 },
    ]);
    expect(rows.every((row) => row.action.type !== 'promote')).toBe(true);
  });

  it('a second parked item does not trigger a second promotion (promote exactly one)', () => {
    const parked1 = { kind: 'parked', itemId: 'item-1', atMs: 8_000 } as const;
    const parked2 = { kind: 'parked', itemId: 'item-2', atMs: 9_000 } as const;
    const candidate = { kind: 'candidate', payloadText: 'I want to find out about Podpoint.', identity: 'p9', atMs: 12_000 } as const;
    const { rows } = drive(parkingEpisode(), [
      { advanceMs: 2_000 },
      { observation: parked1, advanceMs: 500 },
      { observation: parked2, advanceMs: 500 },
      { advanceMs: 1_000 },
      { observation: candidate, advanceMs: 2_000 },
      { observation: { kind: 'presentation', identity: 'p9', complete: true, atMs: 14_000 }, advanceMs: 2_000 },
      { advanceMs: 2_000 },
      { observation: { kind: 'release', identity: 'p9', atMs: 20_000 }, advanceMs: 2_000 },
      { observation: { kind: 'delivery', identity: 'p9', atMs: 22_000 }, advanceMs: 2_000 },
      { observation: { kind: 'worker-store', identity: 'p9', ok: true, atMs: 24_000 }, advanceMs: 1_000 },
    ]);
    const promotes = rows.map((row) => row.action).filter((action) => action.type === 'promote');
    expect(promotes).toHaveLength(1);
    expect(promotes[0]).toMatchObject({ itemId: 'item-1' }); // oldest first, exactly one
  });

  it('a parked item announced during a speak window still satisfies the await-parked phase', () => {
    const parked = { kind: 'parked', itemId: 'item-7', atMs: 3_500 } as const;
    const candidate = { kind: 'candidate', payloadText: 'I want to find out about Podpoint.', identity: 'p9', atMs: 12_000 } as const;
    const { rows } = drive(parkingEpisode(), [
      { advanceMs: 2_000 }, // speak t1 begins
      { observation: parked, advanceMs: 500 }, // parked WHILE the operator turn is still settling
      { advanceMs: 500 }, // (speak window still settling)
      { advanceMs: 1_000 }, // promote action now
      { observation: candidate, advanceMs: 2_000 },
      { observation: { kind: 'presentation', identity: 'p9', complete: true, atMs: 14_000 }, advanceMs: 2_000 },
      { advanceMs: 2_000 },
      { observation: { kind: 'release', identity: 'p9', atMs: 20_000 }, advanceMs: 2_000 },
      { observation: { kind: 'delivery', identity: 'p9', atMs: 22_000 }, advanceMs: 2_000 },
      { observation: { kind: 'worker-store', identity: 'p9', ok: true, atMs: 24_000 }, advanceMs: 1_000 },
    ]);
    const promotes = rows.map((row) => row.action).filter((action) => action.type === 'promote');
    expect(promotes).toHaveLength(1);
    expect(promotes[0]).toMatchObject({ itemId: 'item-7' });
  });
});

// the soak episode construction is exercised through the committed plan; the
// joined-corpus helper is pinned here so the director always sees SOAK-10MIN
describe('soak episode join', () => {
  it('SOAK-10MIN is absent from the strict corpus and present after the join', () => {
    expect(corpus.episodes.some((episode) => episode.id === SOAK_EPISODE_ID)).toBe(false);
    const joined = withSoakEpisode(corpus, soakEpisodeFromPlan(loadSoakPlan(REPO), corpus));
    expect(joined.episodes.some((episode) => episode.id === SOAK_EPISODE_ID)).toBe(true);
  });
});
