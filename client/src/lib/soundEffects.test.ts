import { describe, expect, it } from 'vitest';
import {
  VOICE_WIRE_VERSION,
  type VoiceReceiptOutcome,
  type VoiceServerMessage,
} from '@pi-web-ui/shared';
import {
  DELIVERY_CHIME,
  NOT_DELIVERED_CHIMES,
  chimeSpecFor,
  chimeVariantForMessage,
  createDeliveryChime,
  playChime,
  type ChimeBackend,
  type ChimeTone,
} from './soundEffects';

// Vite raw import — the jsdom test environment has no Node builtins.
import sourceOfSoundEffects from './soundEffects.ts?raw';

function envelope(type: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type,
    version: VOICE_WIRE_VERSION,
    laneId: 'worker:n',
    attachmentGeneration: 0,
    ...extra,
  };
}

function receiptMessage(outcome: VoiceReceiptOutcome): VoiceServerMessage {
  return envelope('receipt_event', {
    receipt: {
      releaseId: 'rel-1',
      proposalId: 'prop-1',
      idempotencyKey: 'idem-1',
      outcome,
      atMs: 1,
    },
  }) as unknown as VoiceServerMessage;
}

class RecordingBackend implements ChimeBackend {
  time = 5;
  calls: Array<{ tone: ChimeTone; startAt: number }> = [];
  currentTime(): number {
    return this.time;
  }
  play(tone: ChimeTone, startAt: number): void {
    this.calls.push({ tone, startAt });
  }
}

describe('delivery chime gate (contract §8.1)', () => {
  it('plays the delivered chime on a delivered receipt, and nothing else', () => {
    const backend = new RecordingBackend();
    const chime = createDeliveryChime({ backend });
    expect(chime.playForMessage(receiptMessage('delivered'))).toBe('delivered');
    expect(backend.calls.length).toBe(DELIVERY_CHIME.tones.length);
  });

  it('never chimes on proposal_resolved — released is not delivery evidence', () => {
    const backend = new RecordingBackend();
    const chime = createDeliveryChime({ backend });
    for (const outcome of ['released', 'cancelled', 'refused', 'replaced', 'expired']) {
      const message = envelope('proposal_resolved', { proposalId: 'prop-1', outcome }) as unknown as VoiceServerMessage;
      expect(chime.playForMessage(message)).toBeNull();
    }
    expect(backend.calls).toHaveLength(0);
    expect(chime.history()).toHaveLength(0);
  });

  it('stays silent for every message that is not a receipt', () => {
    const backend = new RecordingBackend();
    const chime = createDeliveryChime({ backend });
    for (const type of ['voice_state', 'transcript_delta', 'parking_updated', 'voice_error']) {
      expect(chime.playForMessage(envelope(type) as unknown as VoiceServerMessage)).toBeNull();
    }
    expect(backend.calls).toHaveLength(0);
  });

  it('gives queued / refused / unknown their own distinct, non-delivery sounds', () => {
    const backend = new RecordingBackend();
    const chime = createDeliveryChime({ backend, minimumGapMs: 0 });
    for (const outcome of ['queued', 'refused', 'unknown'] as const) {
      expect(chime.playForMessage(receiptMessage(outcome))).toBe(outcome);
    }
    // Every non-delivery figure is audibly different from the delivered one.
    const deliveredFrequencies = DELIVERY_CHIME.tones.map((tone) => tone.frequencyHz);
    for (const spec of Object.values(NOT_DELIVERED_CHIMES)) {
      expect(spec.variant).not.toBe('delivered');
      for (const tone of spec.tones) expect(deliveredFrequencies).not.toContain(tone.frequencyHz);
    }
    expect(chime.history()).toEqual(['queued', 'refused', 'unknown']);
  });

  it('maps outcomes to specs exhaustively and one-way', () => {
    expect(chimeSpecFor('delivered')).toBe(DELIVERY_CHIME);
    expect(chimeSpecFor('refused').variant).toBe('refused');
    expect(chimeSpecFor('queued').variant).toBe('queued');
    expect(chimeSpecFor('unknown').variant).toBe('unknown');
    for (const spec of Object.values(NOT_DELIVERED_CHIMES)) expect(spec).not.toBe(DELIVERY_CHIME);
  });

  it('reports the variant for a message without playing a different one', () => {
    expect(chimeVariantForMessage(receiptMessage('delivered'))).toBe('delivered');
    expect(chimeVariantForMessage(receiptMessage('refused'))).toBe('refused');
    expect(chimeVariantForMessage(envelope('voice_state') as unknown as VoiceServerMessage)).toBeNull();
  });
});

describe('chime scheduling', () => {
  it('starts at the backend clock unless told otherwise', () => {
    const backend = new RecordingBackend();
    backend.time = 12.5;
    const result = playChime(DELIVERY_CHIME, backend);
    expect(result.startedAt).toBe(12.5);
    expect(result.endsAt).toBeCloseTo(12.5 + 0.28, 6);
    expect(backend.calls[0].startAt).toBeCloseTo(12.5, 6);
    expect(backend.calls[1].startAt).toBeCloseTo(12.59, 6);
  });

  it('suppresses a chime that arrives inside the minimum gap (a burst is not a racket)', () => {
    const backend = new RecordingBackend();
    const chime = createDeliveryChime({ backend, minimumGapMs: 400 });
    backend.time = 0;
    chime.play('delivered');
    const afterFirst = backend.calls.length;
    backend.time = 0.1; // 100 ms later
    chime.play('delivered');
    expect(backend.calls.length).toBe(afterFirst);
    backend.time = 1; // past the gap
    chime.play('delivered');
    expect(backend.calls.length).toBeGreaterThan(afterFirst);
    // Suppression is never silent to the record.
    expect(chime.history()).toEqual(['delivered', 'delivered', 'delivered']);
  });

  it('is short: a chime never competes with the speech it announces', () => {
    for (const spec of [DELIVERY_CHIME, ...Object.values(NOT_DELIVERED_CHIMES)]) {
      expect(spec.totalMs).toBeLessThanOrEqual(400);
      expect(spec.tones.length).toBeGreaterThan(0);
      for (const tone of spec.tones) {
        expect(tone.durationMs).toBeLessThanOrEqual(250);
        expect(tone.gain).toBeLessThanOrEqual(0.25);
      }
    }
  });
});

describe('soundEffects source invariants (never model-generated, never fetched)', () => {
  const code = sourceOfSoundEffects
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('generates every tone locally with oscillators — no asset, no download', () => {
    expect(code).toMatch(/createOscillator\s*\(/);
    expect(code).not.toMatch(/\bfetch\s*\(/);
    expect(code).not.toMatch(/XMLHttpRequest/);
    expect(code).not.toMatch(/decodeAudioData/);
    expect(code).not.toMatch(/new\s+Audio\s*\(/);
    expect(code).not.toMatch(/https?:\/\//);
    expect(code).not.toMatch(/\.mp3|\.wav|\.ogg/);
  });

  it('has no import from a model or a provider path', () => {
    expect(code).not.toMatch(/gemini|openai|anthropic|provider/i);
  });
});
