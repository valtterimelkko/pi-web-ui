/**
 * Phase 3 (native-primary programme, child H) — RED-1: punctuation-free relay
 * addressing.
 *
 * Defect (Phase 0, `operations/voice-native-primary-20260922/phase0/`): spoken
 * speech carries no punctuation, so the operator's "Relay to worker I want to
 * find out about Podpoint" reached the worker with the addressing frame still
 * in it — the worker parsed "the worker" as some other agent. The frame
 * consumers required a connector (`that`/`to`) or a separator (colon/dash)
 * after the head; a bare continuation was left untouched.
 *
 * The acceptance seeds are the Phase 0 probe cases verbatim, plus the family
 * neighbours and the safety controls that must NOT start stripping:
 *   - an adverb/complement continuation ('ask the worker nicely to stop') is
 *     still left untouched for ask/tell frames — the unknown word might be the
 *     operator's real content;
 *   - an 'ask the worker' frame whose continuation is not a first-person
 *     clause is left untouched;
 *   - the connector/separator forms keep passing (regression controls).
 */

import { describe, expect, it } from 'vitest';

import { normaliseRelayText } from '../../../src/talker/relay-normalise.js';

describe('Phase 3 RED-1: relay addressing without a separator', () => {
  // Phase 0 probe acceptance seeds (verbatim).
  it('strips "Relay to worker I want to find out about Podpoint"', () => {
    expect(normaliseRelayText('Relay to worker I want to find out about Podpoint').text).toBe(
      'I want to find out about Podpoint'
    );
  });

  it('strips "Ask the worker I want to find out about Podpoint"', () => {
    expect(normaliseRelayText('Ask the worker I want to find out about Podpoint').text).toBe(
      'I want to find out about Podpoint'
    );
  });

  it('strips "Tell the worker I want to find out about Podpoint" (family neighbour)', () => {
    expect(normaliseRelayText('Tell the worker I want to find out about Podpoint').text).toBe(
      'I want to find out about Podpoint'
    );
  });

  it('strips a first-person continuation after a politeness prefix', () => {
    expect(normaliseRelayText('Yeah, please ask the worker I want the build restarted').text).toBe(
      'I want the build restarted'
    );
  });

  it('relay strips any bare continuation — the frame is complete addressing on its own', () => {
    expect(normaliseRelayText('relay to the worker the build is green').text).toBe(
      'the build is green'
    );
  });

  it('a bare "relay to the worker" with no content is left untouched (no empty relays)', () => {
    const r = normaliseRelayText('relay to the worker');
    expect(r.text).toBe('relay to the worker');
    expect(r.changed).toBe(false);
  });

  // Safety controls — the conservative direction must survive.
  it('CONTROL: an ask-frame adverb continuation is still untouched', () => {
    const r = normaliseRelayText('ask the worker nicely to stop');
    expect(r.text).toBe('ask the worker nicely to stop');
    expect(r.changed).toBe(false);
  });

  it('CONTROL: connector forms still strip', () => {
    expect(normaliseRelayText('Ask the worker to investigate the alternative').text).toBe(
      'investigate the alternative'
    );
  });

  it('CONTROL: separator forms still strip', () => {
    expect(normaliseRelayText('Relay to worker: I want to find out about Podpoint').text).toBe(
      'I want to find out about Podpoint'
    );
  });

  it('CONTROL: quoted third-party addressing is content, not a frame', () => {
    const r = normaliseRelayText('tell the worker I said ask him to rebase');
    // Only the talker-directed frame strips; "ask him to rebase" is the operator's
    // quoted content with a third-party referent that must survive.
    expect(r.text).toBe('I said ask him to rebase');
  });
});
