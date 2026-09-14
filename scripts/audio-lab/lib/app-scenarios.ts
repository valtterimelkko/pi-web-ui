/**
 * App-lane scenarios — the authenticated, compiled, real-transport lane.
 *
 * The product-player lane (scenarios.ts) proves scheduling behaviour against
 * cached fixtures. This lane proves the parts only the REAL application can:
 * cookie-authenticated access to the compiled server's `/api/tts`, the real
 * OpenAI transport it wraps, and the denial of unauthenticated speech
 * requests. The words are still lab-supplied so the oracle can name chunks.
 *
 * Honest boundary: the reading-level-change scenario is recorded `not_run`
 * with its reason rather than simulated — driving the real useAnswerReader
 * needs a Drive-Mode harness that does not exist yet.
 */
import {
  DEFAULT_TOLERANCES,
  expectAllChunksPresent,
  expectChunkOrder,
  expectHeadTailWithin,
  expectNoDuplicates,
  expectRecordingEnergy,
  expectValid,
} from './oracle.js';
import type { Scenario } from './runner.js';

export interface AppLaneEvidence {
  servedRequests: Array<{ status: number; servedFromFixture: boolean }>;
}

export function assertRealTransport(evidence: AppLaneEvidence): {
  id: string;
  ok: boolean;
  detail: string;
} {
  const bad = evidence.servedRequests.filter((entry) => entry.status !== 200 || entry.servedFromFixture);
  return {
    id: 'app.real-transport',
    ok: bad.length === 0 && evidence.servedRequests.length > 0,
    detail:
      bad.length === 0
        ? `${evidence.servedRequests.length} chunk synthesis request(s) served by the compiled server over the real transport`
        : bad.map((entry) => `status=${entry.status} fromFixture=${entry.servedFromFixture}`).join('; '),
  };
}

const loginTtsRead: Scenario = {
  id: 'app.login-tts-read',
  title: 'Cookie-authenticated compiled app: a full read over the real /api/tts transport',
  required: true,
  corpus: 0,
  run: async (context) => {
    const texts = (context.fixtures.chunks.map((chunk) => chunk.text)).slice(0, 6);
    const message = texts.join(' ');
    await context.page.evaluate((text: string) => {
      const api = (globalThis as unknown as { __labProduct: { readAloud(t: string): unknown } }).__labProduct;
      api.readAloud(text);
    }, message);
    const deadline = Date.now() + 120_000;
    for (;;) {
      const snapshot = await context.page.evaluate(() => {
        const api_ = (globalThis as unknown as { __labProduct: { arbiterState(): { current: unknown; queued: unknown[] } } }).__labProduct;
        const s = api_.arbiterState();
        return { busy: s.current !== null, queued: s.queued.length };
      });
      if (!snapshot.busy && snapshot.queued === 0) break;
      if (Date.now() > deadline) throw new Error('arbiter did not settle within 120 s');
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    const served = (context.lane.requests as Array<{ status: number; servedFromFixture: boolean }>).map((entry) => ({
      status: entry.status,
      servedFromFixture: entry.servedFromFixture,
    }));
    const evidence: AppLaneEvidence = { servedRequests: served };
    return {
      assertions: (measurement) => [
        expectValid(measurement),
        expectRecordingEnergy(measurement),
        expectAllChunksPresent(measurement),
        expectChunkOrder(measurement),
        expectHeadTailWithin(measurement, DEFAULT_TOLERANCES.headTailLossFailMs),
        expectNoDuplicates(measurement),
        assertRealTransport(evidence),
      ],
      evidence: { chunkTexts: texts, transport: 'real /api/tts via compiled disposable server (cookie auth)', ...evidence },
    };
  },
};

const readingLevelChange: Scenario = {
  id: 'app.reading-level-change',
  title: 'Reading-level change mid-answer at a chunk boundary (NOT RUN: needs Drive-Mode harness)',
  required: true,
  corpus: 0,
  run: async () => {
    // Deliberately returned as not_run by the app-lane runner: driving the
    // real useAnswerReader requires a Drive-Mode harness that does not exist.
    // A recorded not_run is honest; simulating the level change here would
    // test a copy of the behaviour instead of the behaviour.
    throw new Error('not_run: useAnswerReader harness not built');
  },
};

export const APP_LANE_SCENARIOS: Scenario[] = [loginTtsRead, readingLevelChange];
