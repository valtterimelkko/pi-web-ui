import { test, expect } from '@playwright/test';

test.describe('Authentication', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1000);
  });

  test('should display login form', async ({ page }) => {
    await expect(page.locator('input[type="password"]')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('button[type="submit"]')).toBeVisible();
    await expect(page.locator('h1')).toContainText('Pi Web UI');
  });

  test('should login with valid credentials', async ({ page }) => {
    await page.locator('input[type="password"]').fill('Ey@U1U%d5D77J99F');
    await page.locator('button[type="submit"]').click();
    
    // Wait for main app to load
    await page.waitForTimeout(3000);
    
    // Should be on main page (no password input)
    await expect(page.locator('input[type="password"]')).not.toBeVisible();
  });

  test('should show error with invalid credentials', async ({ page }) => {
    await page.locator('input[type="password"]').fill('wrong-password');
    await page.locator('button[type="submit"]').click();
    
    await expect(page.locator('.bg-red-50, .text-red-700')).toBeVisible({ timeout: 5000 });
  });
});
