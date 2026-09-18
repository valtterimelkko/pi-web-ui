import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';

/**
 * Wave 3 Track M — real-browser evidence for the receipt verdict (N6) and the
 * additive lane-capacity code.
 *
 * What is REAL here (the production component tree, not a mock of it):
 *   - `client/src/dev/voiceLiveLab.tsx` mounts the REAL `DriveModeVoiceLive`
 *     bound to the REAL `VoiceLiveSurface` and `VoiceLiveController`;
 *   - every verdict is delivered through the surface's own `onWireMessage`, as
 *     the exact contract bytes a server sends (`receipt_event` with the four
 *     outcomes; a lane-named `voice_error` carrying `voice_lane_capacity`, whose
 *     text is the server's own `VOICE_REFUSAL_TEXT` line);
 *   - the delivered chime is the product's own Web Audio chime — armed by a real
 *     user gesture — and the badge it drives is asserted delivered-only.
 *
 * What is SUBSTITUTED, and why that is honest:
 *   - the microphone is the lab's virtual one (see the ducking spec): a headless
 *     browser has no device. The receipt path does not touch capture at all.
 *   - the operating system's speech service is not used: no read-back is needed
 *     for a receipt verdict, so the deterministic speech stub the presentation
 *     spec needs is deliberately NOT installed here.
 *
 * Evidence (screenshots + JSON) is written to
 * `operations/voice-live-20260917/evidence/M/`.
 */

const EVIDENCE_DIR =
  process.env.VOICE_LIVE_EVIDENCE_DIR ?? 'operations/voice-live-20260917/evidence/M';

interface LabReadout {
  chimePlays: Array<{ variant: string; at: number }>;
  surface: {
    lastChime: string | null;
    controller: {
      receipts: Array<Record<string, unknown>>;
      lastError: { code: string; message: string; fatal: boolean } | null;
      transportRefusals: Array<{ code: string; message: string; fatal: boolean }>;
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

/** The bytes a server sends for one confirmation's verdict. */
async function deliverReceipt(page: Page, outcome: string, extra: Record<string, unknown>): Promise<void> {
  const payload = JSON.stringify(extra);
  await page.evaluate(`window.__voiceLiveLab.deliverReceipt(${JSON.stringify(outcome)}, ${payload})`);
}

interface VerdictRecord {
  outcome: string;
  dataOutcome: string | null;
  dataTone: string | null;
  dataReconcile: string | null;
  text: string;
  chimeBadgeVisible: boolean;
  chimeVariantPlayed: string | null;
  receipt: Record<string, unknown> | null;
  laneTextMentionsDelivered: boolean;
}

const results: Record<string, VerdictRecord> = {};

/** Read the rendered verdict back out of the DOM and the surface state. */
async function captureVerdict(page: Page, outcome: string): Promise<VerdictRecord> {
  const verdict = page.getByTestId('voice-live-receipt');
  await expect(verdict).toBeVisible();
  const laneText = (await page.getByTestId('drive-mode-voice-live').textContent()) ?? '';
  const snapshot = await readout(page);
  const record: VerdictRecord = {
    outcome,
    dataOutcome: await verdict.getAttribute('data-outcome'),
    dataTone: await verdict.getAttribute('data-verdict-tone'),
    dataReconcile: await verdict.getAttribute('data-reconcile'),
    text: (await verdict.textContent()) ?? '',
    chimeBadgeVisible: (await page.getByTestId('voice-live-chime').count()) > 0,
    chimeVariantPlayed: snapshot.chimePlays.length
      ? snapshot.chimePlays[snapshot.chimePlays.length - 1].variant
      : null,
    receipt: (snapshot.surface.controller.receipts.at(-1) as Record<string, unknown>) ?? null,
    laneTextMentionsDelivered: /delivered/i.test(laneText),
  };
  results[outcome] = record;
  return record;
}

const consoleLog: string[] = [];

test.beforeAll(() => {
  mkdirSync(EVIDENCE_DIR, { recursive: true, mode: 0o700 });
});

test.beforeEach(async ({ page }) => {
  page.on('console', (message) => {
    consoleLog.push(`[${message.type()}] ${message.text()}`);
  });
  page.on('pageerror', (error) => {
    consoleLog.push(`[pageerror] ${error.message}`);
  });
});

test.afterAll(() => {
  writeFileSync(
    join(EVIDENCE_DIR, 'receipt-verdicts.json'),
    `${JSON.stringify(
      { capturedAt: new Date().toISOString(), realBrowser: 'chromium', verdicts: results },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(EVIDENCE_DIR, 'browser-console.log'), `${consoleLog.join('\n')}\n`);
});

test.describe('Track M — the receipt verdict is visible and honest (real browser)', () => {
  test('delivered: the positive state, and the only outcome with the chime badge', async ({ page }) => {
    await arm(page);
    await page.evaluate('window.__voiceLiveLab.resetEvents()');
    await deliverReceipt(page, 'delivered', { mechanism: 'steer' });

    const record = await captureVerdict(page, 'delivered');
    expect(record.dataOutcome).toBe('delivered');
    expect(record.dataTone).toBe('delivered');
    expect(record.text).toContain('Delivered to the worker');
    expect(record.text).toContain('via steer');
    // The trusted chime accompanies delivery — and its badge is present here.
    expect(record.chimeBadgeVisible).toBe(true);
    expect(await page.getByTestId('voice-live-chime').getAttribute('data-chime')).toBe('delivered');
    expect(record.chimeVariantPlayed).toBe('delivered');
    expect(record.laneTextMentionsDelivered).toBe(true);

    await page.getByTestId('voice-live-receipt').screenshot({ path: join(EVIDENCE_DIR, 'M1-delivered.png') });
    await page.screenshot({ path: join(EVIDENCE_DIR, 'M1-delivered-full.png'), fullPage: true });
  });

  test('queued: accepted but not yet handed over, with the disclosure, and no chime', async ({ page }) => {
    await arm(page);
    await page.evaluate('window.__voiceLiveLab.resetEvents()');
    await deliverReceipt(page, 'queued', { disclosure: 'Antigravity queues this in the worker loop.' });

    const record = await captureVerdict(page, 'queued');
    expect(record.dataOutcome).toBe('queued');
    expect(record.dataTone).toBe('queued');
    expect(record.text).toContain('Accepted');
    expect(record.text).toContain('not yet handed to the worker');
    expect(record.text).toContain('Antigravity queues this in the worker loop.');
    // Queued is not delivery: no delivered badge, no delivered wording anywhere.
    expect(record.chimeBadgeVisible).toBe(false);
    expect(record.chimeVariantPlayed).not.toBe('delivered');
    expect(record.laneTextMentionsDelivered).toBe(false);

    await page.getByTestId('voice-live-receipt').screenshot({ path: join(EVIDENCE_DIR, 'M2-queued.png') });
    await page.screenshot({ path: join(EVIDENCE_DIR, 'M2-queued-full.png'), fullPage: true });
  });

  test('refused: the server\u2019s own reason, and nothing that reads as delivery', async ({ page }) => {
    await arm(page);
    await page.evaluate('window.__voiceLiveLab.resetEvents()');
    await deliverReceipt(page, 'refused', { reason: 'the worker is not accepting frames' });

    const record = await captureVerdict(page, 'refused');
    expect(record.dataOutcome).toBe('refused');
    expect(record.dataTone).toBe('refused');
    expect(record.text).toContain('Refused');
    expect(record.text).toContain('the worker is not accepting frames');
    expect(record.chimeBadgeVisible).toBe(false);
    expect(record.chimeVariantPlayed).not.toBe('delivered');
    expect(record.laneTextMentionsDelivered).toBe(false);

    await page.getByTestId('voice-live-receipt').screenshot({ path: join(EVIDENCE_DIR, 'M3-refused.png') });
    await page.screenshot({ path: join(EVIDENCE_DIR, 'M3-refused-full.png'), fullPage: true });
  });

  test('unknown: unconfirmed, with its cause and the reconciliation promise', async ({ page }) => {
    await arm(page);
    await page.evaluate('window.__voiceLiveLab.resetEvents()');
    await deliverReceipt(page, 'unknown', { unknownCause: 'timeout', reconcile: true });

    const record = await captureVerdict(page, 'unknown');
    expect(record.dataOutcome).toBe('unknown');
    expect(record.dataTone).toBe('unknown');
    expect(record.dataReconcile).toBe('true');
    expect(record.text).toContain('Hand-over could not be confirmed');
    expect(record.text).toContain('timeout');
    expect(record.text).toContain('reconciled by idempotency key');
    // An unconfirmed hand-over must never look or read like a delivery.
    expect(record.chimeBadgeVisible).toBe(false);
    expect(record.chimeVariantPlayed).not.toBe('delivered');
    expect(record.laneTextMentionsDelivered).toBe(false);

    await page.getByTestId('voice-live-receipt').screenshot({ path: join(EVIDENCE_DIR, 'M4-unknown.png') });
    await page.screenshot({ path: join(EVIDENCE_DIR, 'M4-unknown-full.png'), fullPage: true });
  });

  test('the verdict is replaced, never left standing: delivered then unknown leaves no delivered claim', async ({
    page,
  }) => {
    await arm(page);
    await page.evaluate('window.__voiceLiveLab.resetEvents()');
    await deliverReceipt(page, 'delivered', { mechanism: 'prompt' });
    await captureVerdict(page, 'delivered-then-unknown-step1');
    await deliverReceipt(page, 'unknown', { unknownCause: 'disconnect', reconcile: true });

    const record = await captureVerdict(page, 'delivered-then-unknown');
    expect(record.dataOutcome).toBe('unknown');
    expect(record.chimeBadgeVisible).toBe(false);
    expect(record.laneTextMentionsDelivered).toBe(false);
    await page.getByTestId('voice-live-receipt').screenshot({ path: join(EVIDENCE_DIR, 'M5-verdict-replaced.png') });
  });

  test('a delivered verdict does not stand for a newer, unconfirmed proposal', async ({ page }) => {
    await arm(page);
    await page.evaluate('window.__voiceLiveLab.resetEvents()');
    await deliverReceipt(page, 'delivered', { mechanism: 'prompt' });
    await expect(page.getByTestId('voice-live-receipt')).toBeVisible();

    // A new confirmation cycle is now pending. The old verdict is history, and
    // neither it nor its delivered badge may sit beside the fresh confirm.
    await page.evaluate('window.__voiceLiveLab.deliverProposal({ proposalId: "prop-lab-2" })');
    await expect(page.getByTestId('proposal-card')).toBeVisible();
    await expect(page.getByTestId('voice-live-receipt')).toHaveCount(0);
    await expect(page.getByTestId('voice-live-chime')).toHaveCount(0);
    const laneText = (await page.getByTestId('drive-mode-voice-live').textContent()) ?? '';
    expect(/delivered/i.test(laneText)).toBe(false);
    await page.screenshot({ path: join(EVIDENCE_DIR, 'M9-superseded-verdict-full.png'), fullPage: true });
  });
});

test.describe('Track M — the lane-capacity refusal is a first-class lane refusal (real browser)', () => {
  test('renders the server\u2019s own capacity text, tagged with the additive code', async ({ page }) => {
    await arm(page);
    await page.evaluate('window.__voiceLiveLab.resetEvents()');
    await page.evaluate('window.__voiceLiveLab.deliverCapacityRefusal()');

    const line = page.getByTestId('voice-live-error');
    await expect(line).toBeVisible();
    await expect(line).toHaveAttribute('data-code', 'voice_lane_capacity');
    await expect(line).toContainText('The voice lane table is full; try again shortly.');
    // It is a lane-named refusal, not a lane-less transport notice.
    await expect(page.getByTestId('voice-live-transport-refusal')).toHaveCount(0);
    const snapshot = await readout(page);
    expect(snapshot.surface.controller.lastError).toMatchObject({
      code: 'voice_lane_capacity',
      message: 'The voice lane table is full; try again shortly.',
    });
    expect(snapshot.surface.controller.transportRefusals).toHaveLength(0);

    await line.screenshot({ path: join(EVIDENCE_DIR, 'M6-capacity-refusal.png') });
    await page.screenshot({ path: join(EVIDENCE_DIR, 'M6-capacity-refusal-full.png'), fullPage: true });
    writeFileSync(
      join(EVIDENCE_DIR, 'capacity-refusal.json'),
      `${JSON.stringify(
        {
          capturedAt: new Date().toISOString(),
          code: 'voice_lane_capacity',
          serverMessage: snapshot.surface.controller.lastError?.message,
          fatal: snapshot.surface.controller.lastError?.fatal,
          capacityCodeFromServer: true,
        },
        null,
        2,
      )}\n`,
    );
  });

  test('falls back to a local line when the frame carried no server message', async ({ page }) => {
    await arm(page);
    await page.evaluate('window.__voiceLiveLab.resetEvents()');
    await page.evaluate('window.__voiceLiveLab.deliverCapacityRefusal("")');

    const line = page.getByTestId('voice-live-error');
    await expect(line).toBeVisible();
    await expect(line).toHaveAttribute('data-code', 'voice_lane_capacity');
    // No server words to prefer: the client names the capacity itself, and
    // still leaves the surface usable.
    await expect(line).toContainText('at capacity');
    await expect(line).toContainText('try again shortly');
    await page.screenshot({ path: join(EVIDENCE_DIR, 'M7-capacity-fallback-full.png'), fullPage: true });
  });

  test('accepts the capacity refusal on the correlated start path the server will really use', async ({
    page,
  }) => {
    await arm(page);
    await page.evaluate('window.__voiceLiveLab.resetEvents()');

    // The operator's start mints and issues a requestId for voice_session_start;
    // Track K echoes that id on the answering frame. Answering a real issued id
    // is the path the merged server will take, so the capacity code must be
    // APPLIED (not refused as a foreign request) when it arrives that way.
    await page.evaluate('window.__voiceLiveLab.startLane()');
    await waitForLab(page, "window.__voiceLiveLab.sentFrames('voice_session_start').length === 1");
    const start = (await page.evaluate("window.__voiceLiveLab.sentFrames('voice_session_start')")) as Array<{
      requestId?: string;
    }>;
    expect(typeof start[0].requestId).toBe('string');

    await page.evaluate(
      `window.__voiceLiveLab.deliverCapacityRefusal(undefined, ${JSON.stringify({ requestId: start[0].requestId })})`,
    );

    const line = page.getByTestId('voice-live-error');
    await expect(line).toBeVisible();
    await expect(line).toHaveAttribute('data-code', 'voice_lane_capacity');
    await expect(line).toContainText('The voice lane table is full; try again shortly.');
    // APPLIED, not refused: no inbound refusal was recorded for the frame.
    await expect(page.getByTestId('voice-live-refusal')).toHaveCount(0);
    await page.screenshot({ path: join(EVIDENCE_DIR, 'M8-capacity-correlated-full.png'), fullPage: true });
  });
});
