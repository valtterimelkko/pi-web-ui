import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';

/**
 * Gate 4's anti-cheat evidence: a REAL browser run proving that playback ducks
 * to ≈15% volume when microphone activity begins.
 *
 * What makes this real rather than a unit assertion:
 *   - the page is served over http://127.0.0.1 (a secure context), so
 *     `AudioWorklet` exists and the capture processor actually runs;
 *   - the production capture path executes unchanged — `getUserMedia` →
 *     `MediaStreamAudioSourceNode` → the capture worklet → the local VAD;
 *   - the production playback path executes unchanged — the real 24 kHz
 *     `PlaybackPipeline` into a real `GainNode` chain;
 *   - ducking is measured from RENDERED audio: an `AnalyserNode` sits after the
 *     master gain, and the spec records amplitude before, during and after the
 *     operator speaks (not just a mocked volume argument).
 *
 * N5 is asserted too, not assumed: capture must stay live and keep producing
 * chunks while it is ducked.
 *
 * Evidence (JSON + screenshots) is written outside the repository, to the
 * coordination directory given to this child, and the key numbers are printed.
 */

/** Evidence lands in a git-ignored directory by default; a caller (e.g. an
 *  orchestrating child) can point it at its own coordination directory. */
const EVIDENCE_DIR = process.env.VOICE_LIVE_EVIDENCE_DIR ?? 'test-results/voice-live-ducking';

interface Measurement {
  at: number;
  output: { rmsMean: number; rmsPeak: number; masterGainValue: number };
  arbiter: { operatorSpeaking: boolean; ducked: boolean; playing: boolean };
  capture: {
    lifecycle: string;
    detail: string | null;
    chunksSent: number;
    stats: { chunksSent: number; framesProduced: number } | null;
  };
  playback: { chunksScheduled: number; queuedMs: number; ducked: boolean } | null;
  activityReports: Array<{ state: string; at: number }>;
  chimePlays: Array<{ variant: string; at: number }>;
}

/** Poll an in-page condition without ever holding the turn open. */
async function waitForLab(
  page: import('@playwright/test').Page,
  expression: string,
  timeoutMs = 10_000,
): Promise<void> {
  await page.waitForFunction(expression, undefined, { timeout: timeoutMs, polling: 50 });
}

async function measure(page: import('@playwright/test').Page): Promise<Measurement> {
  return (await page.evaluate(
    'window.__voiceLiveLab.measure()',
  )) as unknown as Measurement;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test.describe('Voice Mode ducking (real browser, real AudioWorklet)', () => {
  test.beforeAll(() => {
    mkdirSync(EVIDENCE_DIR, { recursive: true, mode: 0o700 });
  });

  test('ducks to ~15% while the operator speaks, without suppressing capture', async ({ page }) => {
    page.on('pageerror', (error) => console.error('[pageerror]', error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') console.error('[console]', message.text());
    });

    await page.goto('/client/voice-live-lab.html');
    await page.waitForFunction('!!window.__voiceLiveLab');

    // A real user gesture arms the audio graph (the harness button click), then
    // the lab is armed through the same public entry point.
    await page.click('#arm');
    await waitForLab(page, 'window.__voiceLiveLab.isReady() === true');

    const captureResult = await page.evaluate('window.__voiceLiveLab.startCapture()');
    expect(captureResult).toBe('live');
    await waitForLab(page, "window.__voiceLiveLab.snapshot().surface.capture === 'live'");

    // Model speech is streaming (the talker is talking).
    await page.evaluate('window.__voiceLiveLab.startModelSpeech()');
    await sleep(500); // let a couple of hundred ms of audio be booked

    const before = await measure(page);
    await page.screenshot({ path: join(EVIDENCE_DIR, '1-before-operator-speaks.png') });
    expect(before.arbiter.operatorSpeaking).toBe(false);
    expect(before.output.rmsPeak).toBeGreaterThan(0.05);
    expect(before.output.masterGainValue).toBeGreaterThan(0.9);

    // ── The operator starts speaking ────────────────────────────────────────
    await page.evaluate('window.__voiceLiveLab.setSpeaking(true)');
    await waitForLab(page, 'window.__voiceLiveLab.snapshot().arbiter.operatorSpeaking === true');
    // Wait for the live duck to be measurably in effect.
    await waitForLab(page, 'window.__voiceLiveLab.snapshot().surface.playback.ducked === true');
    await sleep(120);
    const during = await measure(page);
    await page.screenshot({ path: join(EVIDENCE_DIR, '2-during-operator-speech.png') });

    // N5: capture is unconditional — still live, still producing chunks, while
    // the model audio is ducked.
    expect(during.arbiter.operatorSpeaking).toBe(true);
    expect(during.capture.lifecycle).toBe('live');
    expect(during.capture.chunksSent).toBeGreaterThan(before.capture.chunksSent);

    // ── The operator stops; volume restores at a chunk boundary ─────────────
    await page.evaluate('window.__voiceLiveLab.setSpeaking(false)');
    await waitForLab(page, 'window.__voiceLiveLab.snapshot().arbiter.operatorSpeaking === false', 15_000);
    await sleep(200); // at least one more 20 ms chunk boundary has passed
    const after = await measure(page);
    await page.screenshot({ path: join(EVIDENCE_DIR, '3-after-operator-speaks.png') });

    // ── The actual ducking assertions, on rendered amplitude ───────────────
    const duckedGain = during.output.masterGainValue;
    expect(duckedGain).toBeGreaterThanOrEqual(0.1);
    expect(duckedGain).toBeLessThanOrEqual(0.2);
    expect(after.output.masterGainValue).toBeGreaterThan(0.9);

    // The rendered amplitude really fell: ≈15% of the unducked level.
    expect(during.output.rmsPeak).toBeLessThan(before.output.rmsPeak * 0.35);
    expect(during.output.rmsPeak).toBeGreaterThan(before.output.rmsPeak * 0.05);
    // And it really came back (a duck, not a stop, and not a permanent mute).
    expect(after.output.rmsPeak).toBeGreaterThan(before.output.rmsPeak * 0.6);

    // The floor record shows the operator held the floor and released it.
    expect(during.activityReports.some((report) => report.state === 'speech_start')).toBe(true);
    expect(after.activityReports.some((report) => report.state === 'speech_end')).toBe(true);

    const evidence = {
      capturedAt: new Date().toISOString(),
      url: page.url(),
      operatorSpeech: { before, during, after },
      assertions: {
        duckedGain,
        duckedVsUnducked: during.output.rmsPeak / before.output.rmsPeak,
        restoredRatio: after.output.rmsPeak / before.output.rmsPeak,
        captureChunksDuringDuck: during.capture.chunksSent - before.capture.chunksSent,
        captureLifecycleDuringDuck: during.capture.lifecycle,
      },
    };
    writeFileSync(join(EVIDENCE_DIR, 'ducking-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
    console.log('[ducking evidence]', JSON.stringify(evidence.assertions));

    await page.evaluate('window.__voiceLiveLab.stopModelSpeech()');
  });

  test('the delivery chime is local, host-owned and fires on delivered receipts only', async ({
    page,
  }) => {
    await page.goto('/client/voice-live-lab.html');
    await page.waitForFunction('!!window.__voiceLiveLab');
    await page.click('#arm');
    await waitForLab(page, 'window.__voiceLiveLab.isReady() === true');
    await page.evaluate('window.__voiceLiveLab.resetEvents()');

    // A released proposal is NOT delivery evidence: no sound, no chime record.
    await page.evaluate('window.__voiceLiveLab.deliverProposal()');
    await expect(page.getByTestId('proposal-card')).toBeVisible();
    await page.getByTestId('proposal-card').screenshot({ path: join(EVIDENCE_DIR, '4-proposal-card.png') });
    await page.evaluate('window.__voiceLiveLab.deliverResolved()');
    await expect(page.getByTestId('proposal-card')).toHaveCount(0);
    await sleep(600);
    let snapshot = (await page.evaluate('window.__voiceLiveLab.snapshot()')) as {
      state: { captureChunksSent: number };
      chimePlays: Array<{ variant: string }>;
    };
    expect(snapshot.chimePlays).toHaveLength(0);

    // A delivered receipt is: exactly one local chime.
    await page.evaluate('window.__voiceLiveLab.deliverReceipt("delivered")');
    // Gaps exceed the chime player's minimum gap, so every recorded chime is a
    // chime that genuinely sounded.
    await sleep(600);
    snapshot = (await page.evaluate('window.__voiceLiveLab.snapshot()')) as {
      state: { captureChunksSent: number };
      chimePlays: Array<{ variant: string }>;
    };
    expect(snapshot.chimePlays.map((entry) => entry.variant)).toEqual(['delivered']);

    // A refused receipt gets its own distinct tone, never the delivered figure.
    await page.evaluate('window.__voiceLiveLab.deliverReceipt("refused")');
    await sleep(600);
    snapshot = (await page.evaluate('window.__voiceLiveLab.snapshot()')) as {
      state: { captureChunksSent: number };
      chimePlays: Array<{ variant: string }>;
    };
    expect(snapshot.chimePlays.map((entry) => entry.variant)).toEqual(['delivered', 'refused']);

    // Model speech is never the source of the chime: the chime log is unchanged
    // by streaming model audio.
    await page.evaluate('window.__voiceLiveLab.startModelSpeech()');
    await sleep(300);
    await page.evaluate('window.__voiceLiveLab.stopModelSpeech()');
    const after = (await page.evaluate('window.__voiceLiveLab.snapshot()')) as {
      chimePlays: Array<{ variant: string }>;
    };
    expect(after.chimePlays.map((entry) => entry.variant)).toEqual(['delivered', 'refused']);

    await page.screenshot({ path: join(EVIDENCE_DIR, '4-chime-full.png'), fullPage: true });
  });

  test('the proposal card shows presented vs stale, and the parking lot promotes one item', async ({
    page,
  }) => {
    await page.goto('/client/voice-live-lab.html');
    await page.waitForFunction('!!window.__voiceLiveLab');
    await page.click('#arm');
    await waitForLab(page, 'window.__voiceLiveLab.isReady() === true');

    await page.evaluate('window.__voiceLiveLab.deliverProposal()');
    const card = page.getByTestId('proposal-card');
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute('data-presentation-status', 'presented');
    await expect(page.getByTestId('proposal-confirm')).toBeEnabled();
    await expect(page.getByTestId('proposal-sha')).toContainText('ab12');
    // Element-level evidence: the card itself, not a viewport guess.
    await card.screenshot({ path: join(EVIDENCE_DIR, '5-proposal-presented.png') });
    await page.screenshot({ path: join(EVIDENCE_DIR, '5-proposal-presented-full.png'), fullPage: true });

    // A proposal whose read-back did not complete is visibly NOT confirmable.
    await page.evaluate(
      'window.__voiceLiveLab.deliverProposal({ proposalId: "prop-lab-2", version: 4, presentation: { completed: false, stoppedAtChar: 12 } })',
    );
    const second = page.getByTestId('proposal-card');
    await expect(second).toHaveAttribute('data-presentation-status', 'pending');
    await expect(page.getByTestId('proposal-confirm')).toBeDisabled();
    await expect(page.getByTestId('proposal-status')).toContainText('Not read back in full');
    await second.screenshot({ path: join(EVIDENCE_DIR, '6-proposal-pending.png') });

    await page.evaluate('window.__voiceLiveLab.deliverParking()');
    await expect(page.getByTestId('parking-lot')).toBeVisible();
    await expect(page.getByTestId('parking-promote-item-lab-1')).toBeVisible();
    await expect(page.getByTestId('parking-promote-item-lab-2')).toBeVisible();
    // One tap = one item; the drawer has no batch control.
    await expect(page.getByTestId('parking-lot-rule')).toContainText('One at a time');
    await page.getByTestId('parking-lot').screenshot({ path: join(EVIDENCE_DIR, '7-parking-lot.png') });
    await page.screenshot({ path: join(EVIDENCE_DIR, '8-voice-live-surface-full.png'), fullPage: true });
  });
});
