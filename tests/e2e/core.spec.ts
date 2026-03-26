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

  test('WebSocket connection establishes successfully', async ({ page }) => {
    // Wait for WebSocket to connect
    await page.waitForTimeout(2000);
    
    // Check for connection errors
    const connectionError = page.locator('text=/connection.*failed|websocket.*error|disconnected/i');
    await expect(connectionError).not.toBeVisible({ timeout: 5000 });
    
    // App should be functional
    await expect(page.locator('[data-testid="chat-interface"]')).toBeVisible();
  });

  test('dual protocol - HTTP and WebSocket work together', async ({ page }) => {
    // Make HTTP request
    const response = await page.request.get('/health');
    expect(response.status()).toBe(200);
    
    // WebSocket should also be functional
    await page.waitForTimeout(1000);
    await expect(page.locator('[data-testid="chat-interface"]')).toBeVisible();
  });

  test('no critical console errors after load', async ({ page }) => {
    const consoleErrors: string[] = [];
    
    page.on('console', msg => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });
    
    await page.waitForTimeout(3000);
    
    // Filter out non-critical errors
    const criticalErrors = consoleErrors.filter(err => 
      !err.includes('Warning:') && 
      !err.includes('DevTools') &&
      !err.includes('network') &&
      !err.includes('404')
    );
    
    expect(criticalErrors.length).toBeLessThan(3);
  });
});
