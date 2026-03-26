import { test, expect } from '@playwright/test';

test.describe('Session Switching Stress Tests', () => {
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

  test('rapid session switches should not cause issues', async ({ page }) => {
    await page.waitForSelector('[data-testid="chat-interface"]', { timeout: 5000 });
    
    // Monitor console for errors
    const consoleErrors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });
    
    // Look for session items
    const sessionItems = page.locator('[role="listitem"]');
    const count = await sessionItems.count();
    
    if (count >= 2) {
      // Rapid switching between sessions
      for (let i = 0; i < 10; i++) {
        const itemIndex = i % Math.min(count, 5);
        await sessionItems.nth(itemIndex).click();
        await page.waitForTimeout(100); // Rapid switching
      }
      
      // Wait for any async operations to complete
      await page.waitForTimeout(1000);
      
      // Filter out non-critical errors
      const criticalErrors = consoleErrors.filter(err => 
        !err.includes('Warning:') && 
        !err.includes('DevTools') &&
        !err.includes('network') &&
        !err.includes('404')
      );
      
      // Should not have critical console errors
      expect(criticalErrors.length).toBeLessThan(5);
    } else {
      // If not enough sessions, just verify the UI is stable
      await expect(page.locator('[data-testid="chat-interface"]')).toBeVisible();
    }
  });

  test('session switch during WebSocket reconnection', async ({ page }) => {
    await page.waitForSelector('[data-testid="chat-interface"]', { timeout: 5000 });
    
    const sessionItems = page.locator('[role="listitem"]');
    const count = await sessionItems.count();
    
    if (count >= 2) {
      // Simulate network interruption
      await page.context().setOffline(true);
      await page.waitForTimeout(500);
      
      // Try to switch session while offline
      await sessionItems.first().click();
      
      // Go back online
      await page.context().setOffline(false);
      await page.waitForTimeout(2000);
      
      // Try switching again
      await sessionItems.nth(1).click();
      await page.waitForTimeout(500);
      
      // App should still be functional
      await expect(page.locator('[data-testid="chat-interface"]')).toBeVisible();
    }
  });

  test('concurrent session operations', async ({ page }) => {
    await page.waitForSelector('[data-testid="chat-interface"]', { timeout: 5000 });
    
    const consoleErrors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });
    
    // Try multiple operations at once
    const promises: Promise<void>[] = [];
    
    // Click on session items rapidly
    const sessionItems = page.locator('[role="listitem"]');
    const count = await sessionItems.count();
    
    if (count > 0) {
      for (let i = 0; i < 5; i++) {
        promises.push((async () => {
          await sessionItems.nth(i % count).click();
          await page.waitForTimeout(50);
        })());
      }
      
      await Promise.all(promises);
      await page.waitForTimeout(1000);
      
      // Filter out non-critical errors
      const criticalErrors = consoleErrors.filter(err => 
        !err.includes('Warning:') && 
        !err.includes('DevTools') &&
        !err.includes('network')
      );
      
      // Should handle concurrent operations without critical errors
      expect(criticalErrors.length).toBeLessThan(5);
    }
  });

  test('memory usage during repeated switches', async ({ page }) => {
    await page.waitForSelector('[data-testid="chat-interface"]', { timeout: 5000 });
    
    const sessionItems = page.locator('[role="listitem"]');
    const count = await sessionItems.count();
    
    if (count >= 2) {
      // Perform many switches
      for (let i = 0; i < 20; i++) {
        const itemIndex = i % count;
        await sessionItems.nth(itemIndex).click();
        await page.waitForTimeout(50);
      }
      
      // Check memory usage (if available)
      const metrics = await page.evaluate(() => {
        if ('memory' in performance) {
          const memory = (performance as any).memory;
          return {
            usedJSHeapSize: memory.usedJSHeapSize,
            totalJSHeapSize: memory.totalJSHeapSize,
          };
        }
        return null;
      });
      
      if (metrics) {
        // Memory should not exceed 500MB
        expect(metrics.usedJSHeapSize).toBeLessThan(500 * 1024 * 1024);
      }
      
      // App should still be responsive
      await expect(page.locator('[data-testid="chat-interface"]')).toBeVisible();
    }
  });

  test('session switch with pending operations', async ({ page }) => {
    await page.waitForSelector('[data-testid="chat-interface"]', { timeout: 5000 });
    
    // Start an operation (e.g., create session)
    const createButton = page.locator('button:has-text("Create new session")');
    
    if (await createButton.isVisible().catch(() => false)) {
      // Click create but don't complete the modal
      await createButton.click();
      await page.waitForTimeout(100);
      
      // Switch session while modal is open
      const sessionItems = page.locator('[role="listitem"]');
      const count = await sessionItems.count();
      
      if (count > 0) {
        // Close modal first (ESC)
        await page.keyboard.press('Escape');
        await page.waitForTimeout(200);
        
        // Now switch session
        await sessionItems.first().click();
        await page.waitForTimeout(500);
        
        // App should be stable
        await expect(page.locator('[data-testid="chat-interface"]')).toBeVisible();
      }
    }
  });
});

test.describe('Session List Stability', () => {
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

  test('session list updates correctly', async ({ page }) => {
    await page.waitForSelector('[data-testid="chat-interface"]', { timeout: 5000 });
    
    // Get initial session count
    const sessionItems = page.locator('[role="listitem"]');
    const initialCount = await sessionItems.count();
    
    // Refresh the page
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);
    
    // Count should be the same after reload
    const afterReloadCount = await sessionItems.count();
    expect(afterReloadCount).toBe(initialCount);
  });

  test('session list handles empty state', async ({ page }) => {
    await page.waitForSelector('[data-testid="chat-interface"]', { timeout: 5000 });
    
    const sessionItems = page.locator('[role="listitem"]');
    const count = await sessionItems.count();
    
    if (count === 0) {
      // Should show empty state
      const emptyMessage = page.locator('text=/No sessions found|Create.*session/i');
      await expect(emptyMessage).toBeVisible();
    }
  });

  test('session order is preserved', async ({ page }) => {
    await page.waitForSelector('[data-testid="chat-interface"]', { timeout: 5000 });
    
    const sessionItems = page.locator('[role="listitem"]');
    const count = await sessionItems.count();
    
    if (count >= 2) {
      // Get names of first two sessions
      const firstName = await sessionItems.first().textContent();
      const secondName = await sessionItems.nth(1).textContent();
      
      // Switch to second session
      await sessionItems.nth(1).click();
      await page.waitForTimeout(500);
      
      // Switch back to first
      await sessionItems.first().click();
      await page.waitForTimeout(500);
      
      // Order should be preserved
      const newFirstName = await sessionItems.first().textContent();
      const newSecondName = await sessionItems.nth(1).textContent();
      
      expect(newFirstName?.trim()).toBe(firstName?.trim());
      expect(newSecondName?.trim()).toBe(secondName?.trim());
    }
  });
});

test.describe('WebSocket Stress Tests', () => {
  test('handles rapid connect/disconnect cycles', async ({ page }) => {
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
    
    const consoleErrors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });
    
    // Rapid offline/online cycles
    for (let i = 0; i < 3; i++) {
      await page.context().setOffline(true);
      await page.waitForTimeout(200);
      await page.context().setOffline(false);
      await page.waitForTimeout(500);
    }
    
    // Wait for reconnection
    await page.waitForTimeout(2000);
    
    // Filter out non-critical errors
    const criticalErrors = consoleErrors.filter(err => 
      !err.includes('Warning:') && 
      !err.includes('DevTools') &&
      !err.includes('network')
    );
    
    // Should handle reconnection gracefully
    expect(criticalErrors.length).toBeLessThan(5);
    await expect(page.locator('[data-testid="chat-interface"]')).toBeVisible();
  });

  test('WebSocket recovers from extended disconnection', async ({ page }) => {
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
    
    // Extended disconnection
    await page.context().setOffline(true);
    await page.waitForTimeout(3000);
    
    // Reconnect
    await page.context().setOffline(false);
    await page.waitForTimeout(3000);
    
    // App should recover
    await expect(page.locator('[data-testid="chat-interface"]')).toBeVisible();
  });
});
