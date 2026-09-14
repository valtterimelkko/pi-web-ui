/**
 * The lab's scenario registry.
 *
 * One registry, one schema: a future scenario is added here rather than as a
 * new bespoke script, which is what keeps the lab a reusable development tool
 * instead of a collection of probes. Every scenario declares whether it is
 * REQUIRED for the suite verdict, and every scenario runs through the same
 * negative control and the same oracle.
 *
 * The matrix is the plan's §4 Wave 3 table. Scenarios that genuinely need the
 * authenticated full application (reading-level change, real TTS transport)
 * live in `app-scenarios.ts`; this file covers the deterministic product-player
 * lane where the lab supplies the words.
 */

import {
  DEFAULT_TOLERANCES,
  expectAllChunksPresent,
  expectChunkOrder,
  expectHeadTailWithin,
  expectJoinGapsWithin,
  expectNoDuplicates,
  expectNoSustainedGainLoss,
  expectRecordingEnergy,
  type AssertionResult,
  type Measurement,
} from './oracle.js';
import { DIAGNOSTIC_CORPUS } from './fixtures.js';
import { verifyChunking, type Scenario, type ScenarioContext, type ScenarioOutcome } from './runner.js';

/** Standard "the whole read arrived intact" gate set. */
export function completenessGate(): (measurement: Measurement) => AssertionResult[] {
  return (measurement) => [
    expectRecordingEnergy(measurement),
    expectAllChunksPresent(measurement),
    expectChunkOrder(measurement),
    expectNoDuplicates(measurement),
    expectHeadTailWithin(measurement, DEFAULT_TOLERANCES.headTailLossFailMs),
    expectJoinGapsWithin(measurement, DEFAULT_TOLERANCES.joinGapFailMs),
    expectNoSustainedGainLoss(measurement),
  ];
}

function textsOf(corpus: number): string[] {
  return DIAGNOSTIC_CORPUS[corpus];
}

/** Submit a whole message and wait for the arbiter to go quiet. */
async function readWhole(context: ScenarioContext, corpus: number, waitMs: number): Promise<ScenarioOutcome> {
  const texts = textsOf(corpus);
  const message = texts.join(' ');
  const chunkCheck = await verifyChunking(context.page, message, texts);
  if (!chunkCheck.ok) {
    throw new Error(
      `lab corpus does not match the product chunker: expected ${JSON.stringify(texts)} got ${JSON.stringify(chunkCheck.actual)}`
    );
  }
  await context.page.evaluate((text: string) => {
    const api = (globalThis as unknown as { __labProduct: { readAloud(t: string): unknown } }).__labProduct;
    api.readAloud(text);
  }, message);
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  return { assertions: completenessGate(), evidence: { chunkTexts: texts, chunkingVerified: true } };
}

/** Wait for the arbiter to report it is idle, bounded. */
async function waitForArbiterIdle(page: ScenarioContext['page'], timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let waited = 0;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => {
      const api = (
        globalThis as unknown as {
          __labProduct: { arbiterState(): { current: unknown; queued: unknown[]; paused: boolean } };
        }
      ).__labProduct;
      const snapshot = api.arbiterState();
      return { busy: snapshot.current !== null || snapshot.queued.length > 0, paused: snapshot.paused };
    });
    if (!state.busy && !state.paused) return waited;
    await new Promise((resolve) => setTimeout(resolve, 100));
    waited = Date.now() - (deadline - timeoutMs);
  }
  return waited;
}

const startCold: Scenario = {
  id: 'start-cold',
  title: 'Cold context and first real gesture: the first sentence is complete',
  required: true,
  corpus: 0,
  run: async (context) => {
    // The page was just loaded and this is the first playback: no warm
    // AudioContext, no warm decode. The first chunk is the one the owner
    // reports losing, so the head-loss measurement on chunk-00 is the point.
    const texts = textsOf(0).slice(0, 1);
    const message = texts.join(' ');
    const chunkCheck = await verifyChunking(context.page, message, texts);
    if (!chunkCheck.ok) throw new Error(`chunking mismatch: ${JSON.stringify(chunkCheck.actual)}`);
    const armed = await context.page.evaluate(() => {
      const api = (
        globalThis as unknown as { __labProduct: { contextState(): { state: string; sampleRate: number } } }
      ).__labProduct;
      return api.contextState();
    });
    await context.page.evaluate((text: string) => {
      const api = (globalThis as unknown as { __labProduct: { readAloud(t: string): unknown } }).__labProduct;
      api.readAloud(text);
    }, message);
    await new Promise((resolve) => setTimeout(resolve, 5200));
    return {
      assertions: (measurement) => [
        expectRecordingEnergy(measurement),
        expectAllChunksPresent(measurement),
        // A cold start is exactly where an eaten opening would show up.
        expectHeadTailWithin(measurement, DEFAULT_TOLERANCES.headTailLossFailMs),
        expectNoSustainedGainLoss(measurement),
      ],
      evidence: { chunkTexts: texts, contextAtStart: armed, warmup: 'cold' },
    };
  },
};

const idleResume: Scenario = {
  id: 'idle-resume',
  title: 'Playback after a long idle gap: the first words still arrive',
  required: true,
  corpus: 0,
  run: async (context) => {
    // Long enough that a suspended/throttled audio context or a dropped warm
    // buffer would show up as a missing or late first word.
    context.log('idle-resume: idling 31 s before the read');
    await new Promise((resolve) => setTimeout(resolve, 31_000));
    const texts = textsOf(0).slice(0, 2);
    const message = texts.join(' ');
    const chunkCheck = await verifyChunking(context.page, message, texts);
    if (!chunkCheck.ok) throw new Error(`chunking mismatch: ${JSON.stringify(chunkCheck.actual)}`);
    await context.page.evaluate((text: string) => {
      const api = (globalThis as unknown as { __labProduct: { readAloud(t: string): unknown } }).__labProduct;
      api.readAloud(text);
    }, message);
    await new Promise((resolve) => setTimeout(resolve, 9000));
    return {
      assertions: (measurement) => [
        expectRecordingEnergy(measurement),
        expectAllChunksPresent(measurement),
        expectChunkOrder(measurement),
        expectHeadTailWithin(measurement, DEFAULT_TOLERANCES.headTailLossFailMs),
      ],
      evidence: { chunkTexts: texts, idleMs: 31_000 },
    };
  },
};

const chunkJoins: Scenario = {
  id: 'chunk-joins',
  title: 'Twenty-plus chunk joins: ordered coverage, head/tail and gap distribution',
  required: true,
  corpus: 0,
  run: async (context) => {
    // Ten sentences played twice back-to-back gives 20 chunk starts through the
    // real player; the repeated half also exercises the identity/repeat path.
    const base = textsOf(0);
    const texts = [...base, ...base];
    const message = texts.join(' ');
    const chunkCheck = await verifyChunking(context.page, message, texts);
    if (!chunkCheck.ok) {
      throw new Error(
        `chunking mismatch (expected ${texts.length} chunks, got ${chunkCheck.actual.length})`
      );
    }
    await context.page.evaluate((text: string) => {
      const api = (globalThis as unknown as { __labProduct: { readAloud(t: string): unknown } }).__labProduct;
      api.readAloud(text);
    }, message);
    const waited = await waitForArbiterIdle(context.page, 150_000);
    return {
      assertions: (measurement) => [
        expectRecordingEnergy(measurement),
        expectAllChunksPresent(measurement),
        expectChunkOrder(measurement),
        expectNoDuplicates(measurement),
        expectHeadTailWithin(measurement, DEFAULT_TOLERANCES.headTailLossFailMs),
        // The locked bound: with one-ahead priming, the next chunk is already
        // decoded, so a join should never need a synthesis round trip.
        expectJoinGapsWithin(measurement, DEFAULT_TOLERANCES.joinGapFailMs),
        expectNoSustainedGainLoss(measurement),
      ],
      evidence: { chunkTexts: texts, chunkCount: texts.length, arbiterIdleAfterMs: waited },
    };
  },
};

const speed: Scenario = {
  id: 'speed',
  title: 'Playback speed 1.0 then the existing 1.25 path, duration-normalised',
  required: true,
  corpus: 2,
  run: async (context) => {
    const texts = textsOf(2);
    const message = texts.join(' ');
    const chunkCheck = await verifyChunking(context.page, message, texts);
    if (!chunkCheck.ok) throw new Error(`chunking mismatch: ${JSON.stringify(chunkCheck.actual)}`);
    // The 1.25 path plays the SAME bytes faster, so a naive comparison would
    // report a duration mismatch. Measure it as coverage, not as timing.
    await context.page.evaluate(() => {
      const api = (globalThis as unknown as { __labProduct: { speed(on: boolean): void } }).__labProduct;
      api.speed(true);
    });
    await context.page.evaluate((text: string) => {
      const api = (globalThis as unknown as { __labProduct: { readAloud(t: string): unknown } }).__labProduct;
      api.readAloud(text);
    }, message);
    const waited = await waitForArbiterIdle(context.page, 60_000);
    await context.page.evaluate(() => {
      const api = (globalThis as unknown as { __labProduct: { speed(on: boolean): void } }).__labProduct;
      api.speed(false);
    });
    return {
      assertions: (measurement) => [
        expectRecordingEnergy(measurement),
        expectAllChunksPresent(measurement),
        expectChunkOrder(measurement),
        expectNoDuplicates(measurement),
        expectJoinGapsWithin(measurement, DEFAULT_TOLERANCES.joinGapFailMs),
      ],
      evidence: {
        chunkTexts: texts,
        playbackRate: 1.25,
        arbiterIdleAfterMs: waited,
        // At 1.25× the recording is expected to be ~80% of source duration.
        note: 'speed lane: content coverage is the gate; absolute duration is not',
      },
    };
  },
};

const stopCancel: Scenario = {
  id: 'stop-cancel',
  title: 'Explicit stop: pending synthesis resolves without stale late playback',
  required: true,
  corpus: 0,
  run: async (context) => {
    const texts = textsOf(0);
    const message = texts.join(' ');
    const chunkCheck = await verifyChunking(context.page, message, texts);
    if (!chunkCheck.ok) throw new Error(`chunking mismatch: ${JSON.stringify(chunkCheck.actual)}`);
    await context.page.evaluate((text: string) => {
      const api = (globalThis as unknown as { __labProduct: { readAloud(t: string): unknown } }).__labProduct;
      api.readAloud(text);
    }, message);
    // Stop while chunk 0 is playing, so chunks 1..n are still in flight.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const stoppedAt = await context.page.evaluate(() => {
      const api = (
        globalThis as unknown as {
          __labProduct: { stop(): void; arbiterState(): { current: { chunkIndex: number } | null } };
        }
      ).__labProduct;
      const before = api.arbiterState().current?.chunkIndex ?? 0;
      api.stop();
      return before;
    });
    // Long enough that any pending synthesis would have resolved and played.
    await new Promise((resolve) => setTimeout(resolve, 9000));
    const after = await context.page.evaluate(() => {
      const api = (
        globalThis as unknown as { __labProduct: { arbiterState(): { current: unknown; queued: unknown[] } } }
      ).__labProduct;
      const snapshot = api.arbiterState();
      return { busy: snapshot.current !== null, queued: snapshot.queued.length };
    });
    return {
      assertions: (measurement) => {
        const present = measurement.chunks.filter((chunk) => chunk.status === 'present');
        const lastPresent = present.length > 0 ? present[present.length - 1].index : -1;
        return [
          expectRecordingEnergy(measurement),
          // Honest cancellation accounting: at least the stopped chunk played
          // and everything that started is accounted for, but NOT the whole
          // read. A "complete read" here would mean the stop did not work.
          {
            id: 'stop.partial-playback',
            ok: present.length > 0 && present.length < texts.length,
            detail: `${present.length} of ${texts.length} chunks played after stop at chunk ${stoppedAt}`,
          },
          {
            id: 'stop.no-stale-replay',
            ok: lastPresent <= stoppedAt + 1,
            detail: `last audible chunk index ${lastPresent} (stop requested during chunk ${stoppedAt})`,
          },
          {
            id: 'stop.arbiter-cleared',
            ok: !after.busy && after.queued === 0,
            detail: `arbiter busy=${after.busy} queued=${after.queued} after stop`,
          },
          expectNoSustainedGainLoss(measurement),
        ];
      },
      evidence: { chunkTexts: texts, stopRequestedDuringChunk: stoppedAt, arbiterAfter: after, staleWindowMs: 9000 },
    };
  },
};

const pauseBoundary: Scenario = {
  id: 'pause-boundary',
  title: 'Pause and resume at an allowed boundary without duplicate or lost content',
  required: true,
  corpus: 2,
  run: async (context) => {
    const texts = textsOf(2);
    const message = texts.join(' ');
    const chunkCheck = await verifyChunking(context.page, message, texts);
    if (!chunkCheck.ok) throw new Error(`chunking mismatch: ${JSON.stringify(chunkCheck.actual)}`);
    await context.page.evaluate((text: string) => {
      const api = (globalThis as unknown as { __labProduct: { readAloud(t: string): unknown } }).__labProduct;
      api.readAloud(text);
    }, message);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const pausedDuring = await context.page.evaluate(() => {
      const api = (
        globalThis as unknown as { __labProduct: { pause(): void; arbiterState(): { current: { chunkIndex: number } | null } } }
      ).__labProduct;
      const index = api.arbiterState().current?.chunkIndex ?? 0;
      api.pause();
      return index;
    });
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await context.page.evaluate(() => {
      const api = (globalThis as unknown as { __labProduct: { resume(): void } }).__labProduct;
      api.resume();
    });
    const waited = await waitForArbiterIdle(context.page, 60_000);
    return {
      assertions: (measurement) => [
        expectRecordingEnergy(measurement),
        // Resume must continue from the boundary: every chunk audible exactly
        // once, in order, with no repeat of the paused chunk.
        expectAllChunksPresent(measurement),
        expectChunkOrder(measurement),
        expectNoDuplicates(measurement),
        expectHeadTailWithin(measurement, DEFAULT_TOLERANCES.headTailLossFailMs),
      ],
      evidence: { chunkTexts: texts, pausedDuringChunk: pausedDuring, arbiterIdleAfterMs: waited },
    };
  },
};

const priorityDedup: Scenario = {
  id: 'priority-dedup',
  title: 'Repeated identical text: each repeat audible once, in order',
  required: true,
  corpus: 1,
  run: async (context) => {
    const texts = textsOf(1);
    const message = texts.join(' ');
    const chunkCheck = await verifyChunking(context.page, message, texts);
    if (!chunkCheck.ok) throw new Error(`chunking mismatch: ${JSON.stringify(chunkCheck.actual)}`);
    await context.page.evaluate((text: string) => {
      const api = (globalThis as unknown as { __labProduct: { readAloud(t: string): unknown } }).__labProduct;
      api.readAloud(text);
    }, message);
    const waited = await waitForArbiterIdle(context.page, 60_000);
    const requests = context.lane.requests.slice();
    const repeatedRequests = requests.filter((entry) => entry.text === texts[0]).length;
    return {
      assertions: (measurement) => {
        const identicalIndexes = texts
          .map((text, index) => ({ text, index }))
          .filter((entry) => entry.text === texts[0])
          .map((entry) => entry.index);
        const identical = measurement.chunks.filter((chunk) => identicalIndexes.includes(chunk.index));
        return [
          expectRecordingEnergy(measurement),
          // Two identical sentences must be heard twice, at two positions —
          // not collapsed into one, and not stuttered into three.
          {
            id: 'dedup.repeat-heard-twice',
            ok: identical.length === 2 && identical.every((chunk) => chunk.status === 'present'),
            detail: `${identical.length} identical chunks measured, statuses ${identical.map((c) => c.status).join('/')}`,
          },
          {
            id: 'dedup.repeat-distinct-positions',
            ok: identical.length === 2 && identical[1].startSample > identical[0].startSample,
            detail: identical.length === 2 ? `positions ${identical[0].startSample} then ${identical[1].startSample}` : 'not measured',
          },
          expectChunkOrder(measurement),
          expectNoDuplicates(measurement),
        ];
      },
      evidence: { chunkTexts: texts, requestsForRepeatedText: repeatedRequests, arbiterIdleAfterMs: waited },
    };
  },
};

const slowErrorTts: Scenario = {
  id: 'slow-error-tts',
  title: 'Bounded TTS delay and one transient failure: the retry is absorbed',
  required: true,
  corpus: 2,
  run: async (context) => {
    const texts = textsOf(2);
    const message = texts.join(' ');
    const chunkCheck = await verifyChunking(context.page, message, texts);
    if (!chunkCheck.ok) throw new Error(`chunking mismatch: ${JSON.stringify(chunkCheck.actual)}`);
    // The product retries a failed chunk ONCE. Failing the FIRST request for
    // chunk 1 therefore tests that the retry is absorbed rather than the read
    // going quiet from that point on -- the historical "rest of the read
    // vanishes" symptom.
    context.lane.failNextRequestFor(texts[1], 1);
    context.lane.delayNextRequestFor(texts[2], 1500);
    await context.page.evaluate((text: string) => {
      const api = (globalThis as unknown as { __labProduct: { readAloud(t: string): unknown } }).__labProduct;
      api.readAloud(text);
    }, message);
    const waited = await waitForArbiterIdle(context.page, 90_000);
    const injected = context.lane.injectionLog.slice();
    return {
      assertions: (measurement) => [
        expectRecordingEnergy(measurement),
        expectAllChunksPresent(measurement),
        expectChunkOrder(measurement),
        expectHeadTailWithin(measurement, DEFAULT_TOLERANCES.headTailLossFailMs),
        {
          id: 'slow-error.faults-injected',
          ok: injected.some((entry) => entry.kind === 'failure') && injected.some((entry) => entry.kind === 'delay'),
          detail: `injected ${JSON.stringify(injected.map((entry) => `${entry.kind}:${entry.ms ?? ''}`))}`,
        },
        {
          id: 'slow-error.no-partial-read',
          ok: measurement.missingChunks.length === 0,
          detail: `missing: ${measurement.missingChunks.join(', ') || 'none'}`,
        },
      ],
      evidence: {
        chunkTexts: texts,
        injections: injected,
        arbiterIdleAfterMs: waited,
        // A 1.5 s synthesis delay genuinely lengthens one join. It is REPORTED
        // rather than gated: the requirement is that the chunk is still heard,
        // not that an injected delay leaves no trace.
        joinGapP95Ms: null,
      },
    };
  },
};

const ttsTerminalFailure: Scenario = {
  id: 'tts-terminal-failure',
  title: 'Terminal TTS failure: surfaced, bounded, never falsely claimed as speech',
  required: true,
  corpus: 2,
  run: async (context) => {
    const texts = textsOf(2);
    const message = texts.join(' ');
    const chunkCheck = await verifyChunking(context.page, message, texts);
    if (!chunkCheck.ok) throw new Error(`chunking mismatch: ${JSON.stringify(chunkCheck.actual)}`);
    // Both attempts for chunk 1 fail. The arbiter's documented behaviour is to
    // drop the remaining intent; the lab's job is to require that this is
    // SURFACED and BOUNDED, and that nothing is claimed that was not heard.
    context.lane.failNextRequestFor(texts[1], 2);
    await context.page.evaluate((text: string) => {
      const api = (globalThis as unknown as { __labProduct: { readAloud(t: string): unknown } }).__labProduct;
      api.readAloud(text);
    }, message);
    const waited = await waitForArbiterIdle(context.page, 90_000);
    const injected = context.lane.injectionLog.slice();
    return {
      assertions: (measurement) => {
        const failures = injected.filter((entry) => entry.kind === 'failure').length;
        // Honest accounting: the chunks BEFORE the failure were heard; the
        // failing chunk and everything after it were not. A verdict that
        // claimed a complete read here would be false speech reporting.
        const presentBeforeFailure = measurement.chunks.filter(
          (chunk) => chunk.index < 1 && chunk.status === 'present'
        ).length;
        const presentAtOrAfterFailure = measurement.chunks.filter(
          (chunk) => chunk.index >= 1 && chunk.status === 'present'
        ).length;
        return [
          expectRecordingEnergy(measurement),
          {
            id: 'terminal-failure.injected-twice',
            ok: failures >= 2,
            detail: `${failures} injected failures (both attempts must fail for terminal behaviour)`,
          },
          {
            id: 'terminal-failure.preceding-chunks-heard',
            ok: presentBeforeFailure === 1,
            detail: `${presentBeforeFailure} of 1 chunks before the failing chunk were audible`,
          },
          {
            id: 'terminal-failure.no-false-speech',
            ok: presentAtOrAfterFailure === 0,
            detail: `${presentAtOrAfterFailure} chunks at/after the failing chunk measured as audible (must be 0: the failure must not be papered over)`,
          },
          {
            id: 'terminal-failure.no-hang',
            ok: waited < 60_000,
            detail: `arbiter settled after ${waited} ms`,
          },
        ];
      },
      evidence: {
        chunkTexts: texts,
        injections: injected,
        arbiterIdleAfterMs: waited,
        expectation: 'intent dropped at the failing chunk; remaining chunks intentionally not spoken',
      },
    };
  },
};

const visibility: Scenario = {
  id: 'visibility',
  title: 'Background/foreground transition during playback with continuity recorded',
  required: true,
  corpus: 2,
  run: async (context) => {
    const texts = textsOf(2);
    const message = texts.join(' ');
    const chunkCheck = await verifyChunking(context.page, message, texts);
    if (!chunkCheck.ok) throw new Error(`chunking mismatch: ${JSON.stringify(chunkCheck.actual)}`);
    await context.page.evaluate((text: string) => {
      const api = (globalThis as unknown as { __labProduct: { readAloud(t: string): unknown } }).__labProduct;
      api.readAloud(text);
    }, message);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    // Record what the REAL Page Visibility API reports while the read is in
    // flight. The lab does not fabricate a hidden state: it records the
    // observed value and whether a visibilitychange fired, and the report says
    // which of the two it was.
    const before = await context.page.evaluate(() => {
      const marks: Array<{ t: number; event: string; hidden: boolean }> = [];
      document.addEventListener('visibilitychange', () => {
        marks.push({ t: Math.round(performance.now()), event: 'visibilitychange', hidden: document.hidden });
      });
      (globalThis as unknown as { __labVisibilityMarks?: typeof marks }).__labVisibilityMarks = marks;
      return { hidden: document.hidden, visibilityState: document.visibilityState };
    });
    // Opening a second tab is the closest in-lab approximation of "the operator
    // switched away", and it exercises Chrome's own backgrounding path.
    const secondPageOpened = await context.page.evaluate(() => {
      try {
        const opened = window.open('about:blank', '_blank');
        return opened !== null;
      } catch {
        return false;
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const after = await context.page.evaluate(() => ({
      hidden: document.hidden,
      visibilityState: document.visibilityState,
      marks: (globalThis as unknown as { __labVisibilityMarks?: unknown[] }).__labVisibilityMarks ?? [],
    }));
    const waited = await waitForArbiterIdle(context.page, 60_000);
    return {
      assertions: (measurement) => [
        expectRecordingEnergy(measurement),
        // Continuity is the gate: a throttled or suspended context must not
        // silently drop a chunk.
        expectAllChunksPresent(measurement),
        expectChunkOrder(measurement),
        expectNoDuplicates(measurement),
        expectJoinGapsWithin(measurement, DEFAULT_TOLERANCES.joinGapFailMs),
      ],
      evidence: {
        chunkTexts: texts,
        visibilityBefore: before,
        visibilityAfter: after,
        secondPageOpened,
        arbiterIdleAfterMs: waited,
        note:
          'visibility is measured through the real Page Visibility API; observed values are recorded rather than assumed',
      },
    };
  },
};

const bargeDuck: Scenario = {
  id: 'barge-duck',
  title: 'Operator floor mid-chunk: gain ducks rather than hard-stopping, then restores',
  required: true,
  corpus: 0,
  run: async (context) => {
    const texts = textsOf(0).slice(0, 3);
    const message = texts.join(' ');
    const chunkCheck = await verifyChunking(context.page, message, texts);
    if (!chunkCheck.ok) throw new Error(`chunking mismatch: ${JSON.stringify(chunkCheck.actual)}`);
    await context.page.evaluate((text: string) => {
      const api = (globalThis as unknown as { __labProduct: { readAloud(t: string): unknown } }).__labProduct;
      api.readAloud(text);
    }, message);
    // Take the floor while chunk 0 is playing.
    await new Promise((resolve) => setTimeout(resolve, 1400));
    await context.page.evaluate(() => {
      const api = (globalThis as unknown as { __labProduct: { duck(on: boolean): void } }).__labProduct;
      api.duck(true);
    });
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await context.page.evaluate(() => {
      const api = (globalThis as unknown as { __labProduct: { duck(on: boolean): void } }).__labProduct;
      api.duck(false);
    });
    const waited = await waitForArbiterIdle(context.page, 60_000);
    return {
      assertions: (measurement) => [
        expectRecordingEnergy(measurement),
        // Ducking is intentional attenuation, so the read must still complete:
        // every chunk audible, in order, with nothing lost.
        expectAllChunksPresent(measurement),
        expectChunkOrder(measurement),
        {
          id: 'barge.duck-observed',
          ok: measurement.duckEvents.length > 0,
          detail:
            measurement.duckEvents.length === 0
              ? 'no duck event measured; the duck would be indistinguishable from a hard stop'
              : measurement.duckEvents
                  .map((event) => `depth ${(event.depth * 100).toFixed(0)}% restored=${event.restored}`)
                  .join('; '),
        },
        {
          id: 'barge.duck-not-a-stop',
          ok: measurement.missingChunks.length === 0,
          detail: `missing after duck: ${measurement.missingChunks.join(', ') || 'none'}`,
        },
        expectNoSustainedGainLoss(measurement),
      ],
      evidence: { chunkTexts: texts, arbiterIdleAfterMs: waited },
    };
  },
};

export const PRODUCT_LANE_SCENARIOS: Scenario[] = [
  // start-cold MUST stay first: it depends on a genuinely cold context, and a
  // run executes scenarios in registry order.
  startCold,
  idleResume,
  chunkJoins,
  speed,
  stopCancel,
  pauseBoundary,
  priorityDedup,
  slowErrorTts,
  ttsTerminalFailure,
  visibility,
  bargeDuck,
];

export function scenarioById(id: string): Scenario | undefined {
  return PRODUCT_LANE_SCENARIOS.find((scenario) => scenario.id === id);
}

export function requiredScenarioIds(): string[] {
  return PRODUCT_LANE_SCENARIOS.filter((scenario) => scenario.required).map((scenario) => scenario.id);
}
