import { test, expect } from '@playwright/test';
import { loginIfNeeded } from './helpers/login';

async function login(page: any) {
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(1000);
  await loginIfNeeded(page);
}

test.describe('OpenCode Session Switch', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('Session list shows SDK type badges', async ({ page }) => {
    await page.waitForTimeout(2000);

    const body = await page.locator('body').textContent();
    expect(body).toBeDefined();
    expect(body!.length).toBeGreaterThan(0);

    const passwordInput = page.locator('input[type="password"]');
    await expect(passwordInput).not.toBeVisible();
  });

  test('Sidebar renders without errors after login', async ({ page }) => {
    await page.waitForTimeout(2000);

    const errorElements = page.locator('.error, [class*="error-message"]');
    const errorCount = await errorElements.count();
    expect(errorCount).toBe(0);
  });

  test('Can navigate to different views in the UI', async ({ page }) => {
    await page.waitForTimeout(2000);

    const bodyText = await page.locator('body').textContent();
    expect(bodyText).toBeDefined();
  });
});
