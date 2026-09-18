import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';

/**
 * Wave 3 Track L — real-browser evidence for the client voice surface.
 *
 * What is REAL here (the production component tree, not a mock of it):
 *   - `client/src/dev/voiceLiveLab.tsx` mounts the REAL `DriveModeVoiceLive`
 *     bound to the REAL `VoiceLiveSurface` and `VoiceLiveController`;
 *   - the read-back runs the production path (`VoiceLiveSurface.readBackProposal`
 *     → the host's speech synthesis → `controller.reportPresentation`);
 *   - the proposal, its variants and the cascade/rate frames are the bytes the
 *     server really sends (contract §4.4 / connection.ts), delivered through the
 *     surface's own `onWireMessage`.
 *
 * What is SUBSTITUTED, and why that is honest:
 *   - the microphone is the lab's virtual one (see the ducking spec), because a
 *     headless browser has no device;
 *   - the operating system's speech service is a deterministic stub installed by
 *     `addInitScript`, because headless Chromium has no speech backend and would
 *     otherwise never fire the utterance's end event. The stub is a genuine
 *     `speechSynthesis` surface: the production code calls `speak()` on it and
 *     only ever learns of completion from its `onend`/`onerror`/`onboundary`
 *     callbacks, exactly as it does with a real engine. Every assertion below is
 *     therefore about the PRODUCT's wiring — what was spoken, when the report
 *     went out, and what the confirm carried — never about a mocked component.
 *
 * Evidence (screenshots + JSON + the console log) is written to
 * `operations/voice-live-20260917/evidence/L/`.
 */

const EVIDENCE_DIR =
  process.env.VOICE_LIVE_EVIDENCE_DIR ?? 'operations/voice-live-20260917/evidence/L';

/** The deterministic stand-in for the OS speech service (see the header). */
const SPEECH_STUB = `
(() => {
  const state = { speaks: [], cancels: 0, mode: 'auto', holdMs: 700, pending: null };
  window.__voiceSpeech = state;
  state.finish = () => {
    const u = state.pending;
    state.pending = null;
    if (u) {
      if (typeof u.onboundary === 'function') u.onboundary({ charIndex: Math.floor((u.text || '').length / 2) });
      if (typeof u.onend === 'function') u.onend();
    }
    return state.speaks.length;
  };
  state.interrupt = (reason) => {
    const u = state.pending;
    state.pending = null;
    if (u && typeof u.onerror === 'function') u.onerror({ error: reason || 'interrupted' });
  };
  state.cancelAll = () => {
    state.pending = null;
    if (window.speechSynthesis && typeof window.speechSynthesis.cancel === 'function') {
      try { window.speechSynthesis.cancel(); } catch (e) {}
    }
  };
  if (typeof window.SpeechSynthesisUtterance !== 'function') {
    window.SpeechSynthesisUtterance = function (text) { this.text = text; };
  }
  if (!window.speechSynthesis) {
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: { speak() {}, cancel() {}, getVoices: () => [] },
    });
  }
  const synth = window.speechSynthesis;
  const speak = function (utterance) {
    state.speaks.push({ text: utterance.text, at: performance.now() });
    state.pending = utterance;
    if (state.mode === 'auto') {
      const hold = state.holdMs;
      setTimeout(() => {
        if (state.pending !== utterance) return;
        state.pending = null;
        if (typeof utterance.onboundary === 'function') {
          utterance.onboundary({ charIndex: Math.floor((utterance.text || '').length / 2) });
        }
        if (typeof utterance.onend === 'function') utterance.onend();
      }, hold);
    }
  };
  const cancel = function () { state.cancels += 1; state.pending = null; };
  const target = Object.getPrototypeOf(synth) || synth;
  try { target.speak = speak; target.cancel = cancel; } catch (e) {}
  try { synth.speak = speak; synth.cancel = cancel; } catch (e) {}
})();
`;

interface LabReadout {
  state: { captureChunksSent: number };
  sentFrames: Array<Record<string, unknown>>;
  surface: {
    capture: string;
    readBack: { state: string; supported: boolean; variant: string | null; stoppedAtChar?: number };
    lane: { state: string; detail: string | null };
    controller: {
      proposal: { proposal: { proposalId: string; version: number; sha256: string } } | null;
      transportRefusals: Array<{ code: string; message: string; fatal: boolean }>;
      lastError: { code: string; message: string } | null;
    };
  };
}

async function waitForLab(page: Page, expression: string, timeoutMs = 15_000): Promise<void> {
  await page.waitForFunction(expression, undefined, { timeout: timeoutMs, polling: 50 });
}

async function readout(page: Page): Promise<LabReadout> {
  return (await page.evaluate('window.__voiceLiveLab.snapshot()')) as unknown as LabReadout;
}

/** Arm the lab (a real user gesture) and wait for the React surface to mount. */
async function arm(page: Page): Promise<void> {
  await page.goto('/client/voice-live-lab.html');
  await page.waitForFunction('!!window.__voiceLiveLab');
  await page.click('#arm');
  await waitForLab(page, 'window.__voiceLiveLab.isReady() === true');
}

function framesOfType(readoutValue: LabReadout, type: string): Array<Record<string, unknown>> {
  return readoutValue.sentFrames.filter((frame) => frame.type === type);
}

const consoleLog: string[] = [];

test.beforeAll(() => {
  mkdirSync(EVIDENCE_DIR, { recursive: true, mode: 0o700 });
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript(SPEECH_STUB);
  page.on('console', (message) => {
    consoleLog.push(`[${message.type()}] ${message.text()}`);
  });
  page.on('pageerror', (error) => {
    consoleLog.push(`[pageerror] ${error.message}`);
  });
});

test.afterAll(() => {
  writeFileSync(join(EVIDENCE_DIR, 'browser-console.log'), `${consoleLog.join('\n')}\n`);
});

test.describe('Track L — the voice surface is honest and reachable (real browser)', () => {
  test('read-back plays the composed bytes; presentation is reported only when playback ends; the confirm echoes the identity', async ({
    page,
  }) => {
    await arm(page);
    await page.evaluate('window.__voiceLiveLab.resetEvents()');

    // A proposal that has NOT been read back: the state the review found dead.
    await page.evaluate(
      'window.__voiceLiveLab.deliverProposal({ presentation: { completed: false } })',
    );
    const card = page.getByTestId('proposal-card');
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute('data-presentation-status', 'pending');
    await expect(page.getByTestId('proposal-confirm')).toBeDisabled();
    await card.screenshot({ path: join(EVIDENCE_DIR, 'L1-pending-confirm-disabled.png') });

    // The read-back button exists and starts real playback of the retained bytes.
    await page.getByTestId('proposal-readback').click();
    await waitForLab(page, 'window.__voiceSpeech.speaks.length === 1');

    const spoken = (await page.evaluate('window.__voiceSpeech.speaks')) as Array<{ text: string }>;
    // The composed draft (the card's shown variant) is what was spoken, verbatim.
    expect(spoken[0].text).toBe('ask whether the retry handler drops the token');

    // Click alone: NOTHING has been reported, and the confirm is still refused.
    let current = await readout(page);
    expect(framesOfType(current, 'proposal_presentation')).toHaveLength(0);
    expect(current.surface.controller.proposal?.proposal.proposalId).toBe('prop-lab-1');
    await expect(card).toHaveAttribute('data-presentation-status', 'pending');
    await expect(page.getByTestId('proposal-confirm')).toBeDisabled();
    await expect(page.getByTestId('proposal-readback')).toHaveAttribute('data-reading', 'true');
    await page.screenshot({ path: join(EVIDENCE_DIR, 'L2-reading-in-flight.png'), fullPage: true });

    // Playback ends (the production path's report fires on the utterance's end).
    await waitForLab(page, 'window.__voiceSpeech.pending === null');
    await expect(card).toHaveAttribute('data-presentation-status', 'presented');
    await expect(page.getByTestId('proposal-confirm')).toBeEnabled();
    current = await readout(page);
    const presentation = framesOfType(current, 'proposal_presentation');
    expect(presentation).toHaveLength(1);
    expect(presentation[0]).toMatchObject({
      proposalId: 'prop-lab-1',
      presentedVariant: 'tidied',
      completed: true,
    });
    await card.screenshot({ path: join(EVIDENCE_DIR, 'L3-presented-confirm-enabled.png') });

    // The typed confirm carries the proposalRef echo of the displayed identity.
    await page.getByTestId('proposal-confirm').click();
    await waitForLab(
      page,
      "window.__voiceLiveLab.sentFrames('proposal_confirm').length === 1",
    );
    const confirm = framesOfType(await readout(page), 'proposal_confirm')[0];
    expect(confirm).toMatchObject({
      proposalId: 'prop-lab-1',
      variant: 'tidied',
      proposalRef: { version: 3, sha256: 'ab12'.padEnd(64, '7') },
    });

    writeFileSync(
      join(EVIDENCE_DIR, 'card-flow.json'),
      `${JSON.stringify(
        {
          capturedAt: new Date().toISOString(),
          spokenText: spoken[0].text,
          presentationFrame: presentation[0],
          confirmFrame: confirm,
          presentationReportedBeforePlaybackEnded: false,
        },
        null,
        2,
      )}\n`,
    );
  });

  test('a read-back click that never finishes playback leaves the proposal unconfirmable', async ({
    page,
  }) => {
    await arm(page);
    await page.evaluate('window.__voiceSpeech.mode = "manual"');
    await page.evaluate(
      'window.__voiceLiveLab.deliverProposal({ presentation: { completed: false } })',
    );
    const card = page.getByTestId('proposal-card');
    await expect(card).toBeVisible();

    await page.getByTestId('proposal-readback').click();
    await waitForLab(page, 'window.__voiceSpeech.speaks.length === 1');
    // Well past any read-back duration: an utterance that never ended must never
    // become a presentation (the old card reported completion on the click).
    await page.waitForTimeout(900);
    await expect(card).toHaveAttribute('data-presentation-status', 'pending');
    await expect(page.getByTestId('proposal-confirm')).toBeDisabled();
    expect(framesOfType(await readout(page), 'proposal_presentation')).toHaveLength(0);
    await page.screenshot({ path: join(EVIDENCE_DIR, 'L4-click-is-not-a-presentation.png'), fullPage: true });

    // Interrupting it reports the narrowing outcome (and still never presents).
    await page.evaluate('window.__voiceSpeech.interrupt("interrupted")');
    await waitForLab(page, "window.__voiceLiveLab.sentFrames('proposal_presentation').length === 1");
    const interrupted = framesOfType(await readout(page), 'proposal_presentation')[0];
    expect(interrupted).toMatchObject({ completed: false });
    await expect(page.getByTestId('voice-live-readback-interrupted')).toBeVisible();
    await expect(card).toHaveAttribute('data-presentation-status', 'pending');
    await expect(page.getByTestId('proposal-confirm')).toBeDisabled();
  });

  test('the lane is opened on the wire, and the server\u2019s own reason is rendered when it cannot serve it', async ({
    page,
  }) => {
    await arm(page);
    await page.evaluate('window.__voiceLiveLab.resetEvents()');

    // Reachability: the operator's Start actually opens the lane on the wire.
    await page.getByTestId('voice-live-start').click();
    await waitForLab(page, "window.__voiceLiveLab.sentFrames('voice_session_start').length === 1");
    const start = framesOfType(await readout(page), 'voice_session_start')[0];
    expect(start).toMatchObject({ workerSessionId: 'voice-lab-worker' });
    // Capture really started (the lab's virtual microphone), and the surface is
    // showing that honestly.
    await expect(page.getByTestId('voice-live-stop')).toBeVisible();
    await expect(page.getByTestId('voice-live-listening-state')).toHaveAttribute('data-listening', 'true');

    // The cascade server's answer: an error state plus a fatal voice_error.
    await page.evaluate('window.__voiceLiveLab.deliverCascadeUnavailable()');
    const panel = page.getByTestId('voice-live-unavailable');
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute('data-reason', 'unavailable');
    await expect(page.getByTestId('voice-live-unavailable-detail')).toContainText('VOICE_MODE_ENGINE=cascade');
    await expect(page.getByTestId('voice-live-retry')).toBeVisible();
    // A control that cannot work is not offered, and the failed start did not
    // leave the microphone open onto a lane that cannot be served.
    await expect(page.getByTestId('voice-live-start')).toHaveCount(0);
    await expect(page.getByTestId('voice-live-stop')).toHaveCount(0);
    await waitForLab(page, 'window.__voiceLiveLab.snapshot().surface.capture === "suspended"');
    await expect(page.getByTestId('drive-mode-voice-live')).toBeVisible();
    await expect(page.getByTestId('voice-live-typed-fallback')).toBeVisible();
    await panel.screenshot({ path: join(EVIDENCE_DIR, 'L5-unavailable-cascade.png') });
    await page.screenshot({ path: join(EVIDENCE_DIR, 'L5-unavailable-cascade-full.png'), fullPage: true });

    writeFileSync(
      join(EVIDENCE_DIR, 'unavailable-state.json'),
      `${JSON.stringify(
        {
          capturedAt: new Date().toISOString(),
          lane: (await readout(page)).surface.lane,
          startFrame: start,
          lastError: (await readout(page)).surface.controller.lastError,
        },
        null,
        2,
      )}\n`,
    );
  });

  test('a lane start that is never answered becomes honestly unavailable (engine unreachable)', async ({
    page,
  }) => {
    await page.goto('/client/voice-live-lab.html');
    await page.waitForFunction('!!window.__voiceLiveLab');
    await page.evaluate('window.__voiceLiveLab.setLaneProbeTimeout(600)');
    await page.click('#arm');
    await waitForLab(page, 'window.__voiceLiveLab.isReady() === true');

    await page.evaluate('window.__voiceLiveLab.startLane()');
    await waitForLab(page, 'window.__voiceLiveLab.laneState().state === "unavailable"', 10_000);
    const lane = (await page.evaluate('window.__voiceLiveLab.laneState()')) as {
      state: string;
      detail: string;
    };
    expect(lane.detail).toContain('no answer from the voice engine');
    await expect(page.getByTestId('voice-live-unavailable')).toBeVisible();
    await expect(page.getByTestId('voice-live-unavailable-detail')).toContainText('no answer');
    await page
      .getByTestId('voice-live-unavailable')
      .screenshot({ path: join(EVIDENCE_DIR, 'L6-unavailable-unreachable.png') });
  });

  test('a transport-level rate refusal (no lane envelope) is rendered, not dropped', async ({ page }) => {
    await arm(page);
    await page.evaluate('window.__voiceLiveLab.deliverTransportRefusal()');
    const line = page.getByTestId('voice-live-transport-refusal');
    await expect(line).toBeVisible();
    await expect(line).toHaveAttribute('data-code', 'voice_internal_error');
    await expect(line).toContainText('Voice frame rate exceeded');
    // It is a transport notice: not a lane error, not a lane refusal.
    await expect(page.getByTestId('voice-live-error')).toHaveCount(0);
    await expect(page.getByTestId('voice-live-refusal')).toHaveCount(0);
    await line.screenshot({ path: join(EVIDENCE_DIR, 'L7-transport-refusal.png') });
    await page.screenshot({ path: join(EVIDENCE_DIR, 'L7-transport-refusal-full.png'), fullPage: true });
  });
});
