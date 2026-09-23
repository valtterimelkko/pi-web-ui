/**
 * Journey observation mapping (child J): instrument wire frames and server
 * evidence rows must map onto the deterministic director's observation
 * vocabulary — candidate identity/payload, release, delivery, presentation
 * (client read-back OR the talker's spoken read-back), and final talker
 * responses. Anything else maps to nothing.
 */
import { describe, expect, it } from 'vitest';
import {
  observationFromEvidence,
  observationFromWireFrame,
  type WireFrameRow,
} from '../../../../scripts/voice-lane-lab/lib/journey-run.js';

const frame = (seq: number, type: string, payload: Record<string, unknown>): WireFrameRow => ({
  seq,
  atMs: 1_000 + seq,
  direction: 'inbound',
  type,
  frame: { type, ...payload },
});

describe('wire frame → director observation', () => {
  it('a proposal_created frame is a candidate observation with the presented variant as payload', () => {
    const identities = new Map<string, string>();
    const observation = observationFromWireFrame(
      frame(1, 'proposal_created', {
        proposal: {
          proposalId: 'prop-1',
          original: 'Relay to worker I want to find out about Podpoint.',
          tidied: 'I want to find out about Podpoint.',
          presentedVariant: 'tidied',
          version: 1,
        },
      }),
      identities
    );
    expect(observation).toEqual({
      kind: 'candidate',
      payloadText: 'I want to find out about Podpoint.',
      identity: 'prop-1',
      atMs: 1_001,
    });
    expect(identities.get('prop-1')).toBe('I want to find out about Podpoint.');
  });

  it('a released proposal_resolved frame is a release observation; cancelled is not', () => {
    const identities = new Map<string, string>();
    expect(
      observationFromWireFrame(frame(2, 'proposal_resolved', { proposalId: 'prop-1', resolution: 'released' }), identities)
    ).toMatchObject({ kind: 'release', identity: 'prop-1' });
    expect(
      observationFromWireFrame(frame(3, 'proposal_resolved', { proposalId: 'prop-1', resolution: 'cancelled' }), identities)
    ).toBeNull();
  });

  it('a delivered receipt_event is a delivery observation; failed receipts are not', () => {
    const identities = new Map<string, string>();
    expect(
      observationFromWireFrame(frame(4, 'receipt_event', { receipt: { proposalId: 'prop-1', outcome: 'delivered' } }), identities)
    ).toMatchObject({ kind: 'delivery', identity: 'prop-1' });
    expect(
      observationFromWireFrame(frame(5, 'receipt_event', { receipt: { proposalId: 'prop-1', outcome: 'send_failed' } }), identities)
    ).toBeNull();
  });

  it('a completed proposal_presentation (client read-back) is a presentation observation', () => {
    const identities = new Map<string, string>();
    expect(
      observationFromWireFrame(frame(6, 'proposal_presentation', { proposalId: 'prop-1', completed: true, presentedVariant: 'tidied' }), identities)
    ).toMatchObject({ kind: 'presentation', identity: 'prop-1', complete: true });
    expect(
      observationFromWireFrame(frame(7, 'proposal_presentation', { proposalId: 'prop-1', completed: false }), identities)
    ).toBeNull();
  });

  it('a final talker transcript is a response observation; interim and operator text are not', () => {
    const identities = new Map<string, string>();
    expect(
      observationFromWireFrame(frame(8, 'transcript_delta', { speaker: 'talker', final: true, text: 'Here is what I know.' }), identities)
    ).toMatchObject({ kind: 'response', text: 'Here is what I know.' });
    expect(
      observationFromWireFrame(frame(9, 'transcript_delta', { speaker: 'talker', final: false, text: 'Here is what…' }), identities)
    ).toBeNull();
    expect(
      observationFromWireFrame(frame(10, 'transcript_delta', { speaker: 'operator', final: true, text: 'Yes, send that.' }), identities)
    ).toBeNull();
  });

  it('unrelated frames map to nothing', () => {
    const identities = new Map<string, string>();
    expect(observationFromWireFrame(frame(11, 'voice_state', { state: 'live' }), identities)).toBeNull();
  });
});

describe('server evidence → director observation', () => {
  it('the talker’s spoken read-back completing is a presentation observation', () => {
    expect(
      observationFromEvidence({ event: 'spoken_read_back_presented', proposalId: 'prop-9', presentedVariant: 'tidied', atMs: 5_000 })
    ).toMatchObject({ kind: 'presentation', identity: 'prop-9', complete: true });
  });

  it('a gloss or unrelated evidence row maps to nothing', () => {
    expect(observationFromEvidence({ event: 'spoken_read_back_gloss', proposalId: 'prop-9', atMs: 5_000 })).toBeNull();
    expect(observationFromEvidence({ event: 'operator_utterance', atMs: 5_000 })).toBeNull();
  });
});
