import { test, expect } from '@playwright/test';
import { loginIfNeeded } from './helpers/login';

test.describe('Core Functionality', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1000);
    
    await loginIfNeeded(page);
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
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    // Complete authentication first: the pre-auth phase legitimately logs
    // WebSocket handshake failures (the client attempts /ws before the auth
    // cookie exists and retries after login). Those are expected, not defects.
    await loginIfNeeded(page);
    // Settle window: the pre-auth /ws attempt may fail slightly after login
    // completes (its console error arrives late). Give it a bounded window to
    // land, then start the zero-error observation from a clean slate.
    await page.waitForTimeout(1000);
    consoleErrors.length = 0;

    await page.waitForTimeout(3000);

    // Narrow documented allowlist — NOT a permissive count:
    // - 'Warning:' React/framework dev warnings
    // - 'DevTools' instrumentation noise
    // A post-auth WebSocket failure is a real defect and fails this test.
    const criticalErrors = consoleErrors.filter((err) =>
      !err.includes('Warning:') && !err.includes('DevTools'));
    expect(criticalErrors, `console errors: ${JSON.stringify(criticalErrors)}`).toEqual([]);
  });
});
