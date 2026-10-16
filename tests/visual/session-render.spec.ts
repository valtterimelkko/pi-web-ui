import { test, expect, type Page } from '@playwright/test';

/**
 * Session-render "no visible change" gate (command-centre step 1a, design
 * §5.4). Screenshots of the real cards/list over invented fixtures, at the
 * verbosity levels L1 (resting) … L4 (thinking open), light and dark, desktop
 * and phone. Baselines were recorded BEFORE the session-core/session-ui
 * extraction and must stay pixel-identical across it.
 */

const FIXED_NOW = new Date('2023-11-14T22:20:00Z');
const VIEWPORTS = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } } as const;

async function open(page: Page, fixture: string, theme: 'light' | 'dark' = 'light'): Promise<void> {
  await page.clock.setFixedTime(FIXED_NOW);
  await page.goto(`/session-render-harness.html?fixture=${fixture}${theme === 'dark' ? '&theme=dark' : ''}`);
  await page.waitForLoadState('networkidle');
}

const transcript = (page: Page) => page.getByTestId('harness-transcript');

for (const [device, viewport] of Object.entries(VIEWPORTS)) {
  test.describe(device, () => {
    test.use({ viewport });

    for (const fixture of ['pi', 'claude', 'antigravity', 'commandcode']) {
      test(`${fixture} L1 resting view`, async ({ page }) => {
        await open(page, fixture);
        await expect(transcript(page)).toHaveScreenshot(`${device}-${fixture}-L1.png`);
      });
    }

    for (const theme of ['light', 'dark'] as const) {
      test(`pi L2 card + result open (${theme})`, async ({ page }) => {
        await open(page, 'pi', theme);
        await page.getByText('Using Edit').click();
        await page.getByText('Result', { exact: true }).first().click();
        await page.getByText('Using Shell', { exact: true }).last().click();
        await expect(transcript(page)).toHaveScreenshot(`${device}-pi-L2-${theme}.png`);
      });

      test(`pi L3 group open (${theme})`, async ({ page }) => {
        await open(page, 'pi', theme);
        await page.getByText('Ran 1 command, read 2 files').click();
        await expect(transcript(page)).toHaveScreenshot(`${device}-pi-L3-${theme}.png`);
      });

      test(`pi L4 thinking, todo and subagent open (${theme})`, async ({ page }) => {
        await open(page, 'pi', theme);
        await page.getByText('Thinking', { exact: true }).click();
        await page.getByText('todo', { exact: true }).click();
        await page.getByText('scout', { exact: true }).click();
        await expect(transcript(page)).toHaveScreenshot(`${device}-pi-L4-${theme}.png`);
      });

      test(`goal panel, children and watch strips (${theme})`, async ({ page }) => {
        await open(page, 'strips', theme);
        await expect(page.locator('#root')).toHaveScreenshot(`${device}-strips-${theme}.png`);
      });
    }

    test('claude L3 group open (dark)', async ({ page }) => {
      await open(page, 'claude', 'dark');
      await page.getByRole('button', { expanded: false }).filter({ hasText: /tools\)/ }).first().click();
      await expect(transcript(page)).toHaveScreenshot(`${device}-claude-L3-dark.png`);
    });
  });
}
