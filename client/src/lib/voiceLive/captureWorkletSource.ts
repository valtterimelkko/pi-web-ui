/**
 * The capture AudioWorklet processor, as a self-contained source string.
 *
 * Why a string and not a real file: an `AudioWorkletGlobalScope` is a separate
 * global with no module graph of its own, and a `Blob` URL works identically in
 * dev, in the production bundle and in the Playwright harness — no build-time
 * worklet asset to configure, and nothing to get stale. The source is generated
 * from the same constants the main-thread pipeline uses, so the processor and
 * the pipeline cannot disagree about block size.
 *
 * The processor's job is deliberately small and real-time-safe: accumulate the
 * graph's device-rate mono samples into fixed 20 ms blocks, post each block as a
 * transferable `ArrayBuffer`, and hold at most one block plus the partial block
 * — so its memory is bounded by construction. No allocation per render quantum
 * beyond the block that is handed off, no timers, no fetch, no decisions: all
 * resampling, framing, voice-activity detection and bounded queueing happen on
 * the main thread in `captureSession.ts`, where they are unit-testable.
 *
 * Control messages accepted on the port:
 *   { type: 'flush' } — post the partial block now (used at a push-to-talk
 *                       boundary so the last word is not clipped).
 *   { type: 'stop'  } — post the partial block and let `process` return false.
 */

import {
  VOICE_CAPTURE_BLOCK_MS,
  VOICE_CAPTURE_PROCESSOR_NAME,
} from './audioConstants';

export const CAPTURE_WORKLET_SOURCE = `
class VoiceCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._blockFrames = Math.max(1, Math.round((sampleRate * ${VOICE_CAPTURE_BLOCK_MS}) / 1000));
    this._block = new Float32Array(this._blockFrames);
    this._filled = 0;
    this._alive = true;
    this._posted = 0;
    this._postFailures = 0;
    this.port.onmessage = (event) => {
      const data = event && event.data;
      if (!data || typeof data.type !== 'string') return;
      if (data.type === 'flush') this._postPartial();
      else if (data.type === 'stop') {
        this._postPartial();
        this._alive = false;
      }
    };
  }

  _postPartial() {
    if (this._filled === 0) return;
    const frames = this._filled;
    const out = this._block.slice(0, frames);
    this._block = new Float32Array(this._blockFrames);
    this._filled = 0;
    this._post(out, frames);
  }

  _post(samples, frames) {
    try {
      this.port.postMessage(
        { type: 'block', samples: samples.buffer, frames: frames, atMs: Math.round(currentTime * 1000) },
        [samples.buffer]
      );
      this._posted += 1;
    } catch (error) {
      // A detached/closed port must never throw inside the audio thread.
      this._postFailures += 1;
    }
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const channel = input && input[0];
    const frames = channel && channel.length
      ? channel.length
      : outputs[0] && outputs[0][0]
        ? outputs[0][0].length
        : 128;

    for (let i = 0; i < frames; i += 1) {
      // A missing input channel is silence, not a stall: pacing stays uniform.
      this._block[this._filled] = channel ? channel[i] : 0;
      this._filled += 1;
      if (this._filled === this._blockFrames) {
        const out = this._block;
        this._block = new Float32Array(this._blockFrames);
        this._filled = 0;
        this._post(out, out.length);
      }
    }
    return this._alive;
  }
}
registerProcessor(${JSON.stringify(VOICE_CAPTURE_PROCESSOR_NAME)}, VoiceCaptureProcessor);
`;

/** Build the blob URL a caller hands to `audioWorklet.addModule`. */
export function createCaptureWorkletUrl(): string {
  return URL.createObjectURL(new Blob([CAPTURE_WORKLET_SOURCE], { type: 'text/javascript' }));
}

/**
 * The same-origin path the worklet is served from: a vite dev middleware serves
 * `CAPTURE_WORKLET_SOURCE` there, and the production build emits the same bytes
 * as an asset. It exists because a **blob: URL is not loadable as a script under
 * `script-src 'self'`** — production's own CSP carries no `blob:` (the
 * 2026-09-18 field failure: capture could never start in the deployed UI while
 * every dev-server run worked). Nothing about this path weakens the policy: it is
 * the page's own origin, and the bytes are still generated from one source.
 */
export const CAPTURE_WORKLET_PATH = '/voice-live-capture-worklet.js';

/**
 * The candidate URLs in the order they are tried. The same-origin asset comes
 * FIRST (the only one a strict CSP permits); the blob stays last so a bundle
 * whose dist predates the asset — or a harness that serves neither — still has a
 * path that works where the policy is absent.
 */
export function resolveCaptureWorkletUrls(): string[] {
  const urls = [CAPTURE_WORKLET_PATH];
  // A browser without `createObjectURL` simply has no second candidate; it also
  // has no need for one, since the same-origin asset is the first choice.
  if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
    urls.push(createCaptureWorkletUrl());
  }
  return urls;
}
