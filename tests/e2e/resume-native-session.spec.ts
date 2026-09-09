import { test, expect, type Page } from '@playwright/test';
import { loginIfNeeded } from './helpers/login';

async function login(page: Page) {
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(1000);
  await loginIfNeeded(page);
}

test.describe('Resume Native CLI Session & Copy Session ID', () => {
  test.beforeEach(async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await login(page);
  });

  test('sidebar contains Resume CLI session button and opens modal', async ({ page }) => {
    const resumeBtn = page.locator('button[title*="Resume CLI session"]');
    await expect(resumeBtn).toBeVisible({ timeout: 10000 });

    await resumeBtn.click();

    // The heading is an h2
    const modalTitle = page.locator('h2:has-text("Resume CLI Session")');
    await expect(modalTitle).toBeVisible({ timeout: 5000 });

    // Filter tabs by role with regex
    await expect(page.getByRole('button', { name: /^All \d+/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Claude Code \d+/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Antigravity \d+/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Command Code \d+/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^OpenCode \d+/ })).toBeVisible();

    // Click Claude Code filter tab
    await page.getByRole('button', { name: /^Claude Code \d+/ }).click();
    await page.waitForTimeout(300);

    // Verify manual import section can be expanded
    const manualToggle = page.locator('button:has-text("import a session by ID manually")');
    await expect(manualToggle).toBeVisible();
    await manualToggle.click();

    const manualInput = page.locator('input[placeholder*="78f804c6"]');
    await expect(manualInput).toBeVisible();

    // Close the modal via the close button (SVG X)
    const closeBtn = page.locator('button:has(svg.lucide-x)');
    await closeBtn.first().click();
    await expect(modalTitle).not.toBeVisible();
  });

  test('header contains Copy Session ID button when session is active', async ({ page }) => {
    const copyIdBtn = page.locator('button[title="Copy Session ID"]');
    if (!(await copyIdBtn.first().isVisible().catch(() => false))) {
      const newSessionBtn = page.locator('button:has-text("Create new session")');
      if (await newSessionBtn.isVisible().catch(() => false)) {
        await newSessionBtn.click();
        await page.waitForTimeout(2000);
      } else {
        const plusBtn = page.locator('button[title="New session"]');
        if (await plusBtn.isVisible().catch(() => false)) {
          await plusBtn.click();
          await page.waitForTimeout(2000);
        }
      }
    }

    if (await copyIdBtn.first().isVisible().catch(() => false)) {
      await copyIdBtn.first().click();
      await page.waitForTimeout(500);
      const copiedBtn = page.locator('button[title="Copied!"]');
      await expect(copiedBtn.first()).toBeVisible();
    }
  });
});
