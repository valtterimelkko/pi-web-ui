import { test, expect } from '@playwright/test';

async function seedRecentFolder(page: import('@playwright/test').Page, path = '/tmp') {
  await page.evaluate((folderPath) => {
    localStorage.setItem('pi-web-ui-ui-store', JSON.stringify({
      state: {
        theme: 'light',
        recentFolders: [{ path: folderPath, label: 'tmp', count: 1, lastUsed: Date.now() }],
      },
      version: 0,
    }));
  }, path);
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
}

test.describe('Drive Mode', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
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
    await expect(page.locator('text=GLM-5.2')).toBeVisible();
    await expect(page.locator('text=Codex / GPT-5.4')).toBeVisible();
    await expect(page.locator('text=Codex / GPT-5.5')).toBeVisible();
    await expect(page.locator('text=Codex / GPT-5.6 Terra')).toBeVisible();
    await expect(page.locator('text=Codex / GPT-5.6 Luna')).toBeVisible();
    await expect(page.locator('text=Codex / GPT-5.6 Sol')).toBeVisible();
  });

  test('Model picker → folder picker flow', async ({ page }) => {
    const driveModeButton = page.locator('button[aria-label="Enter Drive Mode"]');
    await driveModeButton.click();

    await page.getByRole('button', { name: 'Start a new session' }).click();
    await expect(page.locator('text=Choose a Model')).toBeVisible({ timeout: 10000 });

    // Selecting a model advances directly to the folder picker.
    await page.locator('text=Kimi for Coding').click();

    // Should see folder picker
    await expect(page.locator('text=Choose a Folder')).toBeVisible({ timeout: 10000 });
  });

  test('Full new session flow creates session and reaches dictate screen', async ({ page }) => {
    await seedRecentFolder(page);
    const driveModeButton = page.locator('button[aria-label="Enter Drive Mode"]');
    await driveModeButton.click();

    await page.getByRole('button', { name: 'Start a new session' }).click();
    await expect(page.locator('text=Choose a Model')).toBeVisible({ timeout: 10000 });

    // Select Kimi for Coding (Pi SDK); selection advances directly.
    await page.locator('text=Kimi for Coding').click();

    await expect(page.locator('text=Choose a Folder')).toBeVisible({ timeout: 10000 });
    await page.locator('button').filter({ hasText: '/tmp' }).click();

    // Should transition to dictate screen
    await expect(page.locator('text=Tap to speak')).toBeVisible({ timeout: 15000 });
  });

  test('Exit button closes overlay', async ({ page }) => {
    const driveModeButton = page.locator('button[aria-label="Enter Drive Mode"]');
    await driveModeButton.click();

    await expect(page.locator('text=Pi Drive Mode')).toBeVisible();
    await page.locator('text=Exit Drive Mode').click();
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
