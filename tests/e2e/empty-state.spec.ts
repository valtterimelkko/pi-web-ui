import { test, expect } from '@playwright/test';

test.describe('Empty State UI', () => {
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

  test('empty state shows correct content without duplication when no session', async ({ page }) => {
    // Wait for the main content to load
    await page.waitForSelector('[data-testid="chat-interface"]', { timeout: 5000 });
    
    // Get all text content from the page
    const bodyText = await page.locator('body').textContent() || '';
    
    // Count occurrences of the heading - should appear exactly once
    const headingMatches = (bodyText.match(/Create a session to begin/g) || []).length;
    expect(headingMatches).toBe(1);
    
    // Count occurrences of the subtext - should appear exactly once
    const subtextMatches = (bodyText.match(/Start a new coding session to interact with the AI assistant/g) || []).length;
    expect(subtextMatches).toBe(1);
    
    // Count "Create new session" button text - should appear exactly once
    const buttonMatches = (bodyText.match(/Create new session/g) || []).length;
    expect(buttonMatches).toBe(1);
    
    // "Ready to help" should NOT appear when there's no session
    expect(bodyText).not.toContain('Ready to help');
  });

  test('empty state has correct structure with icon, text, and button', async ({ page }) => {
    // Wait for the main content to load
    await page.waitForSelector('[data-testid="chat-interface"]', { timeout: 5000 });
    
    // Check for the heading
    const heading = page.locator('h2:has-text("Create a session to begin")');
    await expect(heading).toBeVisible();
    await expect(heading).toHaveCount(1);
    
    // Check for the subtext paragraph
    const subtext = page.locator('text=Start a new coding session to interact with the AI assistant');
    await expect(subtext).toBeVisible();
    await expect(subtext).toHaveCount(1);
    
    // Check for the button
    const button = page.locator('button:has-text("Create new session")');
    await expect(button).toBeVisible();
    await expect(button).toHaveCount(1);
    
    // Check for the icon (sparkles SVG)
    const svg = page.locator('svg');
    await expect(svg.first()).toBeVisible();
  });

  test('clicking create session button opens modal', async ({ page }) => {
    // Wait for the main content to load
    await page.waitForSelector('[data-testid="chat-interface"]', { timeout: 5000 });
    
    // Click the create session button
    await page.locator('button:has-text("Create new session")').click();
    
    // Wait for modal to appear
    await page.waitForTimeout(500);
    
    // Check that modal or some dialog content appears
    // The modal should have text related to creating a session
    const modalText = await page.locator('body').textContent() || '';
    expect(modalText).toContain('New Session');
  });
});
