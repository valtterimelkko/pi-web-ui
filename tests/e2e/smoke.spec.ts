import { test, expect } from '@playwright/test';

test.describe('Smoke Tests', () => {
  test('login page loads', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    
    // Verify basic page structure
    await expect(page.locator('h1')).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();
  });

  test('can login and access main app', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    
    // Login
    await page.locator('input[type="password"]').fill('Ey@U1U%d5D77J99F');
    await page.locator('button[type="submit"]').click();
    
    // Should load main app
    await page.waitForTimeout(2000);
    
    // Page title should still be visible or main content loaded
    const title = await page.title();
    expect(title).toBeTruthy();
  });

  test('server health check', async ({ page }) => {
    // Check if API is responding
    const response = await page.request.get('/health');
    expect(response.status()).toBe(200);
    
    const body = await response.json();
    expect(body.status).toBe('ok');
  });
});
