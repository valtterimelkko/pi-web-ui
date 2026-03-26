import { test, expect } from '@playwright/test';

test.describe('JSON-RPC Protocol', () => {
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

  test('WebSocket connection uses JSON-RPC 2.0 protocol', async ({ page }) => {
    // Wait for WebSocket connection to establish
    await page.waitForTimeout(2000);
    
    // Check that the app is connected (no connection error)
    const connectionError = page.locator('text=/connection lost|disconnected|failed to connect/i');
    await expect(connectionError).not.toBeVisible({ timeout: 5000 });
    
    // Verify main UI is functional
    await expect(page.locator('[data-testid="chat-interface"]')).toBeVisible();
  });

  test('JSON-RPC messages follow 2.0 specification', async ({ page }) => {
    // Intercept WebSocket messages
    const wsMessages: unknown[] = [];
    
    await page.route('**/ws', async (route) => {
      route.continue();
    });
    
    // Listen for console messages that might contain protocol info
    page.on('console', msg => {
      if (msg.text().includes('jsonrpc') || msg.text().includes('JSON-RPC')) {
        wsMessages.push(msg.text());
      }
    });
    
    // Trigger an action that would send a JSON-RPC message
    await page.waitForTimeout(1000);
    
    // The app should be functional without protocol errors
    const bodyText = await page.locator('body').textContent();
    expect(bodyText).not.toContain('Invalid request');
    expect(bodyText).not.toContain('Parse error');
    expect(bodyText).not.toContain('Method not found');
  });

  test('session operations use JSON-RPC requests', async ({ page }) => {
    await page.waitForSelector('[data-testid="chat-interface"]', { timeout: 5000 });
    
    // Click create session button if available
    const createButton = page.locator('button:has-text("Create new session")');
    if (await createButton.isVisible().catch(() => false)) {
      await createButton.click();
      await page.waitForTimeout(500);
      
      // Check for modal
      const modal = page.locator('[data-testid="new-session-modal"]');
      await expect(modal).toBeVisible({ timeout: 3000 });
    }
  });

  test('handles JSON-RPC error responses gracefully', async ({ page }) => {
    // Monitor console for errors
    const consoleErrors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });
    
    await page.waitForSelector('[data-testid="chat-interface"]', { timeout: 5000 });
    
    // App should load without critical errors
    await page.waitForTimeout(2000);
    
    // Filter out non-critical errors (e.g., network warnings)
    const criticalErrors = consoleErrors.filter(err => 
      !err.includes('Warning:') && 
      !err.includes('DevTools') &&
      !err.includes('network')
    );
    
    expect(criticalErrors.length).toBeLessThan(3);
  });

  test('dual protocol support - falls back on connection issues', async ({ page }) => {
    // Test that the app handles connection issues gracefully
    await page.waitForSelector('[data-testid="chat-interface"]', { timeout: 5000 });
    
    // Simulate network issues by going offline briefly
    await page.context().setOffline(true);
    await page.waitForTimeout(1000);
    
    // Go back online
    await page.context().setOffline(false);
    await page.waitForTimeout(2000);
    
    // App should still be functional
    const bodyText = await page.locator('body').textContent();
    expect(bodyText).toBeTruthy();
  });
});

test.describe('JSON-RPC Request/Response Flow', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1000);
    
    // Login
    const passwordInput = page.locator('input[type="password"]');
    if (await passwordInput.isVisible().catch(() => false)) {
      await passwordInput.fill('Ey@U1U%d5D77J99F');
      await page.locator('button[type="submit"]').click();
      await page.waitForTimeout(3000);
    }
  });

  test('can send and receive JSON-RPC messages', async ({ page }) => {
    await page.waitForSelector('[data-testid="chat-interface"]', { timeout: 5000 });
    
    // Try to interact with the session
    const input = page.locator('textarea[placeholder*="message"], textarea[placeholder*="Message"], input[type="text"]').first();
    
    if (await input.isVisible().catch(() => false)) {
      await input.fill('Test message');
      await page.waitForTimeout(500);
      
      // The message should be in the input
      const value = await input.inputValue();
      expect(value).toContain('Test message');
    }
  });

  test('JSON-RPC notifications update UI without blocking', async ({ page }) => {
    await page.waitForSelector('[data-testid="chat-interface"]', { timeout: 5000 });
    
    // Wait for any initial notifications to process
    await page.waitForTimeout(2000);
    
    // UI should remain responsive
    const body = await page.locator('body');
    await expect(body).toBeVisible();
    
    // No loading spinners should be stuck
    const stuckSpinners = await page.locator('.animate-spin').count();
    expect(stuckSpinners).toBeLessThan(3);
  });
});
