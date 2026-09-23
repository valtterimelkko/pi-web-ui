/**
 * Journey transport fixes (child J, from the first real C01 run):
 *
 * 1. Chromium's fake device starts playing the opening WAV the moment the
 *    capture device opens, but the page's AudioContext/worklet only begins
 *    consuming ~2–3 s later — the frozen utterance must be transport-padded
 *    with a deterministic silence prefix so the REAL fixture bytes reach the
 *    production capture pipeline intact. The fixture's own digest stays the
 *    provenance anchor; the padded WAV is recorded alongside it.
 * 2. The server's evidence log is JSON-in-JSON (`{"msg":"voice-kernel {…}"}`);
 *    the parser must decode the outer line first or every kernel event —
 *    including the spoken read-back presentation — is silently missed.
 */
import { describe, expect, it } from 'vitest';
import { composePaddedOpeningWav, OPENING_PADDING_MS } from '../../../../scripts/voice-lane-lab/lib/journey-run.js';
import { parseServerEvidenceLine } from '../../../../scripts/voice-lane-lab/lib/journey-run.js';
import { encodeWavPcm16 } from '../../../../scripts/audio-lab/lib/wav.js';
import { createHash } from 'node:crypto';

const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

describe('the padded opening WAV', () => {
  it('uses a deterministic non-zero silence prefix', () => {
    expect(OPENING_PADDING_MS).toBeGreaterThanOrEqual(4_000);
  });

  it('prepends exactly the padding duration of silence and keeps every fixture sample', () => {
    const sampleRate = 24_000;
    const tone = new Float32Array(sampleRate).map((_, i) => Math.sin((2 * Math.PI * 220 * i) / sampleRate) * 0.4);
    const fixture = encodeWavPcm16({ channels: [tone], sampleRate, frames: tone.length });
    const padded = composePaddedOpeningWav(fixture, OPENING_PADDING_MS);
    const dataBytes = padded.length - 44; // canonical 44-byte PCM WAV header
    const paddedFrames = dataBytes / 2; // mono 16-bit
    expect(paddedFrames).toBe(tone.length + (OPENING_PADDING_MS / 1_000) * sampleRate);
    // the first padding must be pure silence
    let silent = true;
    const headerBytes = 44;
    for (let i = 0; i < (OPENING_PADDING_MS / 1_000) * sampleRate; i += 1) {
      if (padded.readInt16LE(headerBytes + i * 2) !== 0) {
        silent = false;
        break;
      }
    }
    expect(silent).toBe(true);
    // the utterance bytes follow the padding, verbatim
    const utterance = padded.subarray(44 + (OPENING_PADDING_MS / 1_000) * sampleRate * 2);
    expect(utterance.equals(fixture.subarray(44))).toBe(true);
  });

  it('is deterministic for the same inputs', () => {
    const tone = new Float32Array(4_800).fill(0.2);
    const fixture = encodeWavPcm16({ channels: [tone], sampleRate: 24_000, frames: 4_800 });
    expect(sha256(composePaddedOpeningWav(fixture, 5_000))).toBe(sha256(composePaddedOpeningWav(fixture, 5_000)));
  });
});

describe('the server evidence log parser', () => {
  it('decodes the JSON-in-JSON voice-kernel shape used by LOG_FORMAT=json', () => {
    const inner = { event: 'spoken_read_back_presented', laneId: 'l1', proposalId: 'prop-1', atMs: 42 };
    const outer = JSON.stringify({
      ts: '2026-09-23T01:24:32.501Z',
      level: 'info',
      component: 'VoiceLive',
      msg: `voice-kernel ${JSON.stringify(inner)}`,
    });
    const row = parseServerEvidenceLine(outer);
    expect(row).not.toBeNull();
    expect(row!.event).toBe('spoken_read_back_presented');
    expect(row!.proposalId).toBe('prop-1');
  });

  it('returns null for ordinary log lines and malformed payloads', () => {
    expect(parseServerEvidenceLine('{"level":"info","msg":"session open"}')).toBeNull();
    expect(parseServerEvidenceLine('voice-kernel {broken')).toBeNull();
    expect(parseServerEvidenceLine('not json at all')).toBeNull();
  });
});
