import { test, expect } from '@playwright/test';

/**
 * Voice Mode end to end against a REAL disposable live-engine server and the
 * BUILT client (2026-09-22). See `playwright.voice-live-e2e.config.ts`.
 *
 * What this proves, front end to back end:
 *   1. the restored layout — the bounded/gated voice controls are the main
 *      surface on top, and the free (live) lane sits below them, collapsed;
 *   2. pressing Start on the free lane opens a REAL Gemini Live lane and the
 *      lane reaches `live` with no false "unavailable" panel;
 *   3. the free lane teaches the one new contract ("relay to worker").
 *
 * The relay → proposal → approval → delivery path is proven separately and more
 * deeply by `scripts/voice-live-lab/cli.ts test-vertical-slice` (3/3 against real
 * Gemini Live); this spec is the front-end/back-end wiring proof.
 */
const PASSWORD = process.env.VOICE_E2E_PASSWORD ?? 'voice-e2e';

test.skip(!process.env.GEMINI_API_KEY, 'voice-live-e2e needs GEMINI_API_KEY (a disposable live server)');

test('bounded main UI on top, free lane below, and the lane really goes live', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);

  const password = page.locator('input[type="password"]');
  if (await password.isVisible().catch(() => false)) {
    await password.fill(PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForTimeout(3000);
  }

  await page.evaluate(() => {
    localStorage.setItem(
      'pi-web-ui-ui-store',
      JSON.stringify({
        state: { theme: 'light', recentFolders: [{ path: '/tmp', label: 'tmp', count: 1, lastUsed: Date.now() }] },
        version: 0,
      })
    );
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);

  // Drive Mode → a real disposable Pi session.
  await page.locator('button[aria-label="Enter Voice Mode"]').first().click();
  await page.getByRole('button', { name: 'Start a new session' }).click();
  await page.locator('text=Kimi for Coding').click();
  await page.locator('button').filter({ hasText: '/tmp' }).first().click();
  await page.waitForSelector('[data-testid="drive-mode-surface"]', { timeout: 30_000 });
  await page.waitForTimeout(3000);

  // 1. The bounded main surface is ABOVE the free lane.
  const order = await page
    .locator('[data-testid="drive-mode-surface"] [data-testid]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid')));
  const mic = order.indexOf('drive-mic');
  const lane = order.indexOf('native-voice-lane');
  expect(mic, `elements: ${order.join(',')}`).toBeGreaterThan(-1);
  expect(lane, `elements: ${order.join(',')}`).toBeGreaterThan(mic);

  // 2. The free lane is collapsed and teaches the relay trigger.
  await expect(page.getByTestId('native-voice-lane-summary')).toContainText('relay to worker');
  await expect(page.getByTestId('drive-mode-voice-live')).toHaveCount(0);

  // 3. Open it and start the REAL live lane.
  await page.getByTestId('native-voice-lane-toggle').click();
  await expect(page.getByTestId('drive-mode-voice-live')).toBeVisible();
  await expect(page.getByTestId('native-voice-lane-hint')).toContainText('relay to worker');

  await page.getByTestId('voice-live-start').click();
  await expect(page.getByTestId('voice-live-status')).toHaveAttribute('data-lane', 'live', { timeout: 30_000 });
  // The lane is genuinely live on the wire, and no false unavailable panel appears.
  await expect(page.getByTestId('voice-live-wire-state')).toHaveAttribute('data-state', 'live');
  await expect(page.getByTestId('voice-live-unavailable')).toHaveCount(0);

  expect(pageErrors, pageErrors.join('\n')).toEqual([]);
});
