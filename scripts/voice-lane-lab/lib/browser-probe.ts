/**
 * The browser half of the lane lab: the SHIPPED scheduler in a REAL audio graph.
 *
 * The Node-side analysis (`lib/schedule.ts`) drives the shipped `PlaybackPipeline`
 * against a recording backend. That is the right instrument for arithmetic, but it
 * cannot answer one thing: does the same code behave the same way against a real
 * `AudioContext`, where `currentTime` is driven by the audio clock and the drain
 * depends on real timers firing? The fix for the 2026-09-18 "talking on top of each
 * other" report is exactly that kind of change.
 *
 * So this loads the dev-lab page (`client/voice-live-lab.html`, NOT part of the
 * production bundle) with the REAL `VoiceLiveSurface` and the REAL Web Audio
 * backend, feeds it a capture's chunks at their measured arrival pacing, and reads
 * back what the page's audio graph actually booked. Two instruments:
 *
 *   - in-page: every `AudioBufferSourceNode.start` is recorded with its scheduled
 *     time and the buffer's true duration, plus how many AudioContexts the page
 *     created — so overlap is detected on the graph, not on a model of it;
 *   - product: the surface's own playback accounting (`chunksScheduled`,
 *     `pendingChunks`, `chunksDropped`), which is what the product reports.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import type { LaneAudioVerdict } from './oracle.js';
import { analyseLaneAudio, type CapturedAudioChunk } from './oracle.js';

export interface BrowserCapture {
  chunks: Array<{
    seq: number;
    arrivedAtMs: number;
    declaredDurationMs: number;
    mimeType: string;
    /** Base64 payload when the capture recorded it inline. */
    data?: string;
    /** Otherwise the decoded chunk on disk, relative to the capture directory. */
    pcmPath?: string;
  }>;
}

/** One source the page's audio graph started. */
export interface BookedSource {
  /** Wall-clock ms (performance.now) when `start()` was called. */
  startedAtMs: number;
  /** The absolute audio-clock time passed to `start()`. */
  when: number;
  /** The buffer's true play duration, from its frame count and rate. */
  durationMs: number;
}

export interface BrowserProbeResult {
  audioContexts: number;
  booked: BookedSource[];
  playback: {
    chunksScheduled: number;
    chunksDropped: number;
    queuedMs: number;
    pendingChunks: number;
    pendingMs: number;
    ducked: boolean;
  } | null;
  faults: Array<{ reason: string; detail: string }>;
}

/** Record every booked source and count the page's AudioContexts. */
const INSTRUMENT = `
(() => {
  const state = { audioContexts: 0, booked: [] };
  window.__laneLabProbe = state;
  const patch = (Ctor) => {
    if (!Ctor || !Ctor.prototype) return;
    const Original = Ctor;
    const originalCreate = Ctor.prototype.createBufferSource;
    Ctor.prototype.createBufferSource = function () {
      const node = originalCreate.call(this);
      const originalStart = node.start.bind(node);
      node.start = (when, offset, duration) => {
        const frames = node.buffer ? node.buffer.length : 0;
        const rate = node.buffer ? node.buffer.sampleRate : 0;
        state.booked.push({
          startedAtMs: performance.now(),
          when: typeof when === 'number' ? when : 0,
          durationMs: rate > 0 ? (frames / rate) * 1000 : 0,
        });
        return originalStart(when, offset, duration);
      };
      return node;
    };
    // Count construction through the prototype-patched constructor is not
    // possible, so wrap the global: any new AudioContext is recorded.
    void Original;
  };
  patch(window.AudioContext);
  patch(window.webkitAudioContext);
  const OriginalAudioContext = window.AudioContext;
  if (OriginalAudioContext) {
    const Wrapped = function (...args) {
      state.audioContexts += 1;
      return new OriginalAudioContext(...args);
    };
    Wrapped.prototype = OriginalAudioContext.prototype;
    window.AudioContext = Wrapped;
  }
})();
`;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface BrowserProbeOptions {
  captureDir: string;
  appUrl: string;
  /** Wall-clock ms allowed after the last chunk for the queue to drain. */
  settleMs?: number;
  log: (line: string) => void;
}

/**
 * Replay a capture through the real page, in real time, and report what the audio
 * graph booked.
 */
export async function probeInBrowser(options: BrowserProbeOptions): Promise<BrowserProbeResult> {
  const settleMs = options.settleMs ?? 25_000;
  const chunksPath = path.join(options.captureDir, 'chunks.json');
  const records = JSON.parse(readFileSync(chunksPath, 'utf8')) as BrowserCapture['chunks'];
  if (records.length === 0) throw new Error(`no chunks in ${chunksPath}`);
  const ordered = [...records].sort((a, b) => a.arrivedAtMs - b.arrivedAtMs);
  const first = ordered[0].arrivedAtMs;

  /** The contract's wire payload for a chunk: inline base64, or the stored PCM. */
  const payloadOf = (record: BrowserCapture['chunks'][number]): string => {
    if (typeof record.data === 'string' && record.data.length > 0) return record.data;
    if (typeof record.pcmPath === 'string' && record.pcmPath.length > 0) {
      const onDisk = path.isAbsolute(record.pcmPath) ? record.pcmPath : path.join(options.captureDir, record.pcmPath);
      return readFileSync(onDisk).toString('base64');
    }
    throw new Error(`chunk ${record.seq} has neither data nor pcmPath`);
  };

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({
      args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
    });
    const page: Page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    await page.addInitScript(INSTRUMENT);
    await page.goto(options.appUrl, { waitUntil: 'load' });
    await page.waitForFunction(() => Boolean((window as never as { __voiceLiveLab?: unknown }).__voiceLiveLab), {
      timeout: 60_000,
    });
    options.log('dev lab page loaded; arming the real surface');
    await page.evaluate(async () => {
      const lab = (window as never as { __voiceLiveLab: { arm: () => Promise<unknown> } }).__voiceLiveLab;
      await lab.arm();
    });

    // The frame envelope must be the page's OWN lane: the surface's controller
    // refuses a frame addressed to a lane it does not hold (which is the correct
    // contract behaviour, and would otherwise make this probe measure nothing).
    const lane = await page.evaluate(() => {
      const lab = (window as never as {
        __voiceLiveLab: { lane: () => { laneId?: unknown; attachmentGeneration?: unknown } };
      }).__voiceLiveLab;
      const identity = lab.lane();
      return {
        laneId: typeof identity.laneId === 'string' ? identity.laneId : '',
        attachmentGeneration:
          typeof identity.attachmentGeneration === 'number' ? identity.attachmentGeneration : 1,
      };
    });
    if (!lane.laneId) throw new Error('the dev lab page never sent a lane frame: no lane identity to address');
    options.log(`page lane: ${lane.laneId} (generation ${lane.attachmentGeneration})`);

    // Feed the capture at its measured arrival pacing: chunk k is delivered at
    // (arrival[k] - arrival[0]) ms from the first. Delivered from Node, so the page
    // is not handed a schedule — it is handed the same arrival pattern the browser saw.
    let previous = first;
    for (const record of ordered) {
      const waitMs = record.arrivedAtMs - previous;
      if (waitMs > 0) await sleep(Math.min(waitMs, 500));
      previous = record.arrivedAtMs;
      await page.evaluate((frame) => {
        const lab = (window as never as { __voiceLiveLab: { deliverRaw: (raw: unknown) => unknown } }).__voiceLiveLab;
        lab.deliverRaw(frame);
      }, {
        type: 'voice_audio_chunk',
        version: 1,
        laneId: lane.laneId,
        attachmentGeneration: lane.attachmentGeneration,
        seq: record.seq,
        mimeType: record.mimeType,
        data: payloadOf(record),
        durationMs: record.declaredDurationMs,
        atMs: 0,
      });
    }
    options.log(`delivered ${ordered.length} chunks; letting the queue drain`);

    // Let the graph play the queue out before reading. The wait is a fixed window
    // rather than a poll on the product's pending count: the surface publishes its
    // playback stats on a wire message, so between arrivals that count is a
    // snapshot, and waiting on it would wait forever (observed: 25 s on a run that
    // had in fact booked every chunk).
    await sleep(Math.min(settleMs, Math.ceil(ordered.length * 120)));
    options.log(`played out for ${Math.min(settleMs, Math.ceil(ordered.length * 120))} ms`);

    const result = await page.evaluate(() => {
      const lab = (window as never as {
        __voiceLiveLab: {
          snapshot: () => { surface?: { playback?: unknown; playbackFaults?: unknown } };
        };
      }).__voiceLiveLab;
      const probe = (window as never as {
        __laneLabProbe: { audioContexts: number; booked: BookedSource[] };
      }).__laneLabProbe;
      const surface = lab.snapshot().surface ?? {};
      return {
        audioContexts: probe.audioContexts,
        booked: probe.booked,
        playback: (surface.playback ?? null) as BrowserProbeResult['playback'],
        faults: (surface.playbackFaults ?? []) as BrowserProbeResult['faults'],
      };
    });
    if (pageErrors.length > 0) options.log(`page errors: ${pageErrors.slice(0, 3).join(' | ')}`);
    return result;
  } finally {
    if (browser) await browser.close();
  }
}

/**
 * Grade a browser run with the SAME oracle the Node-side analysis uses, so the two
 * instruments cannot disagree about what "overlap" or "stranded" means.
 */
export function gradeBrowserRun(
  capture: BrowserCapture,
  probe: BrowserProbeResult,
  captureDir?: string
): LaneAudioVerdict {
  const ordered = [...capture.chunks].sort((a, b) => a.arrivedAtMs - b.arrivedAtMs);
  const first = ordered[0]?.arrivedAtMs ?? 0;

  // The graph's own timeline, on the AUDIO CLOCK.
  //
  // `when` is the value the pipeline passed to `start()`, which is the time the
  // audio actually plays. `startedAtMs` is when the JS call happened, and booking
  // is deliberately ahead of playback, so plotting overlaps from it would invent
  // an overlap out of correct one-ahead scheduling — which is exactly what the
  // first run of this probe did.
  const schedule = probe.booked.map((source, index) => ({
    seq: index,
    startAt: source.when,
    durationSeconds: source.durationMs / 1000,
  }));

  const chunks: CapturedAudioChunk[] = ordered.map((chunk) => {
    const payload = payloadBytes(chunk, captureDir);
    return {
      seq: chunk.seq,
      arrivedAtMs: chunk.arrivedAtMs - first,
      declaredDurationMs: chunk.declaredDurationMs,
      actualDurationMs: (payload.byteLength / 2 / 24_000) * 1000,
      // The real digest, so the oracle's duplicate-audio check means something here.
      sha256: createHash('sha256').update(payload).digest('hex'),
      mimeType: chunk.mimeType,
    };
  });

  const bookedSeqs = new Set(schedule.map((source) => source.seq));
  const strandedSeqs = chunks.map((chunk) => chunk.seq).filter((_, index) => !bookedSeqs.has(index));

  return analyseLaneAudio({
    chunks,
    schedule,
    strandedSeqs,
    droppedChunks: probe.playback?.chunksDropped ?? 0,
    faults: probe.faults,
    page: {
      audioContexts: probe.audioContexts,
      mountedLaneSurfaces: 1,
      laneIds: ['voice-lane-lab-1'],
    },
  });
}

/** The stored PCM's bytes, from wherever the capture kept them. */
function payloadBytes(chunk: BrowserCapture['chunks'][number], captureDir?: string): Buffer {
  if (typeof chunk.data === 'string' && chunk.data.length > 0) return Buffer.from(chunk.data, 'base64');
  if (typeof chunk.pcmPath === 'string' && chunk.pcmPath.length > 0) {
    const onDisk = path.isAbsolute(chunk.pcmPath) || !captureDir ? chunk.pcmPath : path.join(captureDir, chunk.pcmPath);
    return readFileSync(onDisk);
  }
  throw new Error(`chunk ${chunk.seq} has neither data nor pcmPath`);
}
