import { test, expect } from '@playwright/test';

test.describe('Drive Mode', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://localhost:3456');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1000);

    // Login if needed
    const passwordInput = page.locator('input[type="password"]');
    if (await passwordInput.isVisible().catch(() => false)) {
      await passwordInput.fill('Ey@U1U%d5D77J99F');
      await page.locator('button[type="submit"]').click();
      await page.waitForTimeout(3000);
    }
  });

  test('Drive Mode button is visible in header', async ({ page }) => {
    const driveModeButton = page.locator('button[aria-label="Enter Drive Mode"]');
    await expect(driveModeButton).toBeVisible({ timeout: 10000 });
  });

  test('clicking Drive Mode button opens overlay', async ({ page }) => {
    const driveModeButton = page.locator('button[aria-label="Enter Drive Mode"]');
    await driveModeButton.click();

    // Should see the entry screen
    await expect(page.locator('text=Pi Drive Mode')).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('button', { name: 'Start a new session' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue an existing session' })).toBeVisible();
  });

  test('New Session flow shows model picker', async ({ page }) => {
    const driveModeButton = page.locator('button[aria-label="Enter Drive Mode"]');
    await driveModeButton.click();

    await page.getByRole('button', { name: 'Start a new session' }).click();
    await expect(page.locator('text=Choose a Model')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=Kimi for Coding')).toBeVisible();
    await expect(page.locator('text=GLM-5.1')).toBeVisible();
    await expect(page.locator('text=Codex / GPT-5.4')).toBeVisible();
    await expect(page.locator('text=Codex / GPT-5.5')).toBeVisible();
  });

  test('Exit button closes overlay', async ({ page }) => {
    const driveModeButton = page.locator('button[aria-label="Enter Drive Mode"]');
    await driveModeButton.click();

    await expect(page.locator('text=Pi Drive Mode')).toBeVisible();

    // Click exit
    await page.locator('text=Exit Drive Mode').click();

    // Overlay should be gone
    await expect(page.locator('text=Pi Drive Mode')).not.toBeVisible({ timeout: 10000 });
  });

  test('Escape key closes overlay', async ({ page }) => {
    const driveModeButton = page.locator('button[aria-label="Enter Drive Mode"]');
    await driveModeButton.click();

    await expect(page.locator('text=Pi Drive Mode')).toBeVisible();

    await page.keyboard.press('Escape');

    await expect(page.locator('text=Pi Drive Mode')).not.toBeVisible({ timeout: 10000 });
  });
});
