import { test, expect } from '@playwright/test';

test.describe('Core Functionality', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1000);
    
    // Login if on login page
    const passwordInput = page.locator('input[type="password"]');
    if (await passwordInput.isVisible().catch(() => false)) {
      await passwordInput.fill('Ey@U1U%d5D77J99F');
      await page.locator('button[type="submit"]').click();
      await page.waitForTimeout(3000);
    }
  });

  test('health endpoint responds', async ({ request }) => {
    const response = await request.get('/health');
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('ok');
  });

  test('main app loads after login', async ({ page }) => {
    // Should not be on login page
    await expect(page.locator('input[type="password"]')).not.toBeVisible();
    
    // Page should have content
    const body = await page.locator('body').textContent();
    expect(body).toBeTruthy();
    expect(body.length).toBeGreaterThan(0);
  });

  test('page has correct title', async ({ page }) => {
    const title = await page.title();
    expect(title).toBeTruthy();
  });
});
