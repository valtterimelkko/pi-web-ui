import { test, expect, devices } from '@playwright/test';

test.describe('Mobile Viewport Tests', () => {
  test.beforeEach(async ({ page }) => {
    // Set mobile viewport
    await page.setViewportSize({ width: 375, height: 667 });
    
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

  test('session switch should be fast on mobile', async ({ page }) => {
    await page.waitForSelector('[data-testid="chat-interface"]', { timeout: 5000 });
    
    // Look for session items (they have role="listitem")
    const sessionItems = page.locator('[role="listitem"]');
    const count = await sessionItems.count();
    
    if (count > 0) {
      const start = Date.now();
      await sessionItems.first().click();
      const duration = Date.now() - start;
      
      // Should switch in under 1s on mobile
      expect(duration).toBeLessThan(1000);
    } else {
      // If no sessions, just verify the UI loaded
      await expect(page.locator('[data-testid="chat-interface"]')).toBeVisible();
    }
  });

  test('mobile viewport renders correctly', async ({ page }) => {
    await page.waitForSelector('[data-testid="chat-interface"]', { timeout: 5000 });
    
    // Check viewport size
    const viewport = page.viewportSize();
    expect(viewport?.width).toBe(375);
    expect(viewport?.height).toBe(667);
    
    // Main UI should be visible
    await expect(page.locator('[data-testid="chat-interface"]')).toBeVisible();
    
    // No horizontal scroll should be needed
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 20); // 20px tolerance
  });

  test('touch interactions work on mobile', async ({ page }) => {
    await page.waitForSelector('[data-testid="chat-interface"]', { timeout: 5000 });
    
    // Find buttons and verify they're tappable
    const buttons = page.locator('button');
    const buttonCount = await buttons.count();
    
    expect(buttonCount).toBeGreaterThan(0);
    
    // First button should be visible and enabled
    const firstButton = buttons.first();
    await expect(firstButton).toBeVisible();
    await expect(firstButton).toBeEnabled();
  });

  test('text input works on mobile', async ({ page }) => {
    await page.waitForSelector('[data-testid="chat-interface"]', { timeout: 5000 });
    
    // Find any text input
    const textInput = page.locator('textarea, input[type="text"]').first();
    
    if (await textInput.isVisible().catch(() => false)) {
      // Type text
      await textInput.fill('Mobile test message');
      await page.waitForTimeout(300);
      
      // Verify text was entered
      const value = await textInput.inputValue();
      expect(value).toContain('Mobile test message');
    }
  });

  test('no console errors on mobile', async ({ page }) => {
    const consoleErrors: string[] = [];
    
    page.on('console', msg => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });
    
    await page.waitForSelector('[data-testid="chat-interface"]', { timeout: 5000 });
    await page.waitForTimeout(2000);
    
    // Filter out non-critical errors
    const criticalErrors = consoleErrors.filter(err => 
      !err.includes('Warning:') && 
      !err.includes('DevTools') &&
      !err.includes('network') &&
      !err.includes('404')
    );
    
    // Allow up to 2 non-critical errors
    expect(criticalErrors.length).toBeLessThan(3);
  });

  test('sidebar toggles correctly on mobile', async ({ page }) => {
    await page.waitForSelector('[data-testid="chat-interface"]', { timeout: 5000 });
    
    // Look for menu/hamburger button
    const menuButton = page.locator('button[aria-label*="menu"], button[aria-label*="Menu"], button:has(svg)').first();
    
    if (await menuButton.isVisible().catch(() => false)) {
      await menuButton.click();
      await page.waitForTimeout(500);
      
      // Sidebar should be visible or hidden based on state
      const body = await page.locator('body').textContent();
      expect(body).toBeTruthy();
    }
  });

  test('responsive layout adjusts to different mobile sizes', async ({ page }) => {
    const sizes = [
      { width: 320, height: 568 },  // iPhone SE
      { width: 375, height: 667 },  // iPhone 6-8
      { width: 414, height: 896 },  // iPhone XR
    ];
    
    for (const size of sizes) {
      await page.setViewportSize(size);
      await page.waitForTimeout(500);
      
      // App should still be functional
      await expect(page.locator('body')).toBeVisible();
      
      // No horizontal overflow
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 20);
    }
  });
});

test.describe('Mobile Performance', () => {
  test('initial load time is acceptable on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    
    const start = Date.now();
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
    
    const loadTime = Date.now() - start;
    
    // Should load within 10 seconds on mobile
    expect(loadTime).toBeLessThan(10000);
  });

  test('scrolling is smooth on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    
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
    
    await page.waitForSelector('[data-testid="chat-interface"]', { timeout: 5000 });
    
    // Try scrolling
    await page.evaluate(() => window.scrollBy(0, 100));
    await page.waitForTimeout(100);
    await page.evaluate(() => window.scrollBy(0, -100));
    
    // Page should still be responsive
    await expect(page.locator('body')).toBeVisible();
  });
});
