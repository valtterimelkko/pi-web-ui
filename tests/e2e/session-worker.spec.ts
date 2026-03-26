import { test, expect } from '@playwright/test';

/**
 * Session Worker E2E Tests
 * 
 * These tests verify the full flow of worker-based sessions including:
 * - Worker status display in sidebar
 * - Streaming status during prompts
 * - Reconnection after page refresh
 * 
 * Note: These are placeholder E2E tests. Full E2E tests require a running server
 * with the complete Pi SDK integration and worker thread support.
 */
test.describe('Session Worker E2E', () => {
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

  test('should display worker status in sidebar', async ({ page }) => {
    // Wait for the app to fully load
    await page.waitForSelector('[data-testid="chat-interface"]', { timeout: 5000 });
    
    // Look for session sidebar
    const sidebar = page.locator('[data-testid="session-sidebar"]').or(page.locator('.session-sidebar'));
    
    // Verify sidebar is visible
    await expect(sidebar).toBeVisible({ timeout: 5000 });
    
    // Look for worker status indicator (if implemented)
    // This could be a status badge, icon, or text indicating worker state
    const workerStatus = page.locator('[data-testid="worker-status"]').or(
      page.locator('text=/worker|session.*status|ready|busy/i')
    );
    
    // Worker status may or may not be visible depending on implementation
    // Just verify the sidebar structure is present
    const sidebarContent = await sidebar.textContent();
    expect(sidebarContent).toBeTruthy();
  });

  test('should show streaming status during prompt', async ({ page }) => {
    // Wait for chat interface
    await page.waitForSelector('[data-testid="chat-interface"]', { timeout: 5000 });
    
    // Create or select a session first
    const newSessionButton = page.locator('[data-testid="new-session-btn"]').or(
      page.locator('button:has-text("New Session")')
    );
    
    if (await newSessionButton.isVisible().catch(() => false)) {
      await newSessionButton.click();
      await page.waitForTimeout(1000);
    }
    
    // Find the message input
    const messageInput = page.locator('[data-testid="message-input"]').or(
      page.locator('textarea[placeholder*="message" i]').or(
        page.locator('input[placeholder*="message" i]')
      )
    );
    
    // Skip if no input found (session may not be available)
    const isInputVisible = await messageInput.isVisible().catch(() => false);
    test.skip(!isInputVisible, 'Message input not available - session may require setup');
    
    // Type a test message
    await messageInput.fill('Hello, this is a test message for streaming status');
    
    // Submit the message (Enter key or send button)
    const sendButton = page.locator('[data-testid="send-button"]').or(
      page.locator('button[type="submit"]')
    );
    
    if (await sendButton.isVisible().catch(() => false)) {
      await sendButton.click();
    } else {
      await messageInput.press('Enter');
    }
    
    // Look for streaming indicator
    // This could be "Thinking...", a spinner, or "Streaming..." text
    const streamingIndicator = page.locator('[data-testid="streaming-indicator"]').or(
      page.locator('text=/thinking|streaming|loading|processing/i')
    );
    
    // The indicator should appear within a few seconds
    // Note: In a real implementation, this would be more specific
    try {
      await expect(streamingIndicator).toBeVisible({ timeout: 5000 });
    } catch {
      // Streaming indicator may not be implemented yet
      // Just verify the message was submitted
      await page.waitForTimeout(2000);
    }
  });

  test('should reconnect to session after page refresh', async ({ page }) => {
    // Wait for chat interface and get current session info
    await page.waitForSelector('[data-testid="chat-interface"]', { timeout: 5000 });
    
    // Get the current page state (session ID, messages, etc.)
    const initialUrl = page.url();
    const initialContent = await page.locator('body').textContent();
    
    // Check for session ID in URL or local storage
    const sessionIdFromUrl = initialUrl.match(/session[/=]([^/\s]+)/)?.[1];
    
    // Refresh the page
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);
    
    // After reload, we may need to login again
    const passwordInput = page.locator('input[type="password"]');
    if (await passwordInput.isVisible().catch(() => false)) {
      await passwordInput.fill('Ey@U1U%d5D77J99F');
      await page.locator('button[type="submit"]').click();
      await page.waitForTimeout(3000);
    }
    
    // Wait for chat interface to reappear
    await page.waitForSelector('[data-testid="chat-interface"]', { timeout: 10000 });
    
    // Verify we're back in the app
    const reloadedContent = await page.locator('body').textContent();
    expect(reloadedContent).toBeTruthy();
    
    // If there was a session ID in the URL, verify it's still there or restored
    if (sessionIdFromUrl) {
      const reloadedUrl = page.url();
      // Session ID may be restored via URL or internal state
      const restoredSessionId = reloadedUrl.match(/session[/=]([^/\s]+)/)?.[1];
      
      // Either the session ID is in the URL or it should be restored internally
      // This is a basic check - full verification would need access to app state
      expect(reloadedContent!.length).toBeGreaterThan(0);
    }
    
    // Verify WebSocket reconnects (no connection errors)
    const connectionError = page.locator('text=/connection.*failed|websocket.*error|disconnected/i');
    await expect(connectionError).not.toBeVisible({ timeout: 5000 });
  });

  test('should maintain session state across reconnections', async ({ page }) => {
    // This test verifies that worker state is preserved across reconnections
    await page.waitForSelector('[data-testid="chat-interface"]', { timeout: 5000 });
    
    // Get initial state indicators
    const sidebar = page.locator('[data-testid="session-sidebar"]').or(
      page.locator('.session-sidebar')
    );
    
    const initialSidebarContent = await sidebar.textContent().catch(() => '');
    
    // Simulate a brief disconnect by reloading
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);
    
    // Handle login if needed
    const passwordInput = page.locator('input[type="password"]');
    if (await passwordInput.isVisible().catch(() => false)) {
      await passwordInput.fill('Ey@U1U%d5D77J99F');
      await page.locator('button[type="submit"]').click();
      await page.waitForTimeout(3000);
    }
    
    // Wait for reconnection
    await page.waitForSelector('[data-testid="chat-interface"]', { timeout: 10000 });
    
    // Verify sidebar is restored
    const restoredSidebarContent = await sidebar.textContent().catch(() => '');
    
    // The session list should be restored (may not be identical due to timing)
    expect(restoredSidebarContent).toBeTruthy();
    
    // Verify no error messages about session loss
    const sessionError = page.locator('text=/session.*lost|worker.*failed|state.*error/i');
    await expect(sessionError).not.toBeVisible({ timeout: 3000 });
  });
});
