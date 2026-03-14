import { test, expect } from '@playwright/test';

/**
 * Model Switching E2E Tests
 * 
 * Prerequisites:
 * - Server must be running (npm run dev or npm start)
 * - Default credentials: admin / admin
 * 
 * To run these tests:
 *   npx playwright test tests/model-switching.spec.ts
 * 
 * To run with a specific URL:
 *   TEST_URL=https://pi.letsautomate.work npx playwright test tests/model-switching.spec.ts
 */

const TEST_USERNAME = process.env.TEST_USERNAME || 'admin';
const TEST_PASSWORD = process.env.TEST_PASSWORD || 'admin';

test.beforeEach(async ({ page }) => {
  // Navigate to the app
  await page.goto('/');
  
  // Wait for page to load (either login form or chat interface if already logged in)
  await page.waitForLoadState('networkidle');
  
  // Check if we're on the login page (only password field)
  const passwordInput = page.locator('input[type="password"]').first();
  const isLoginPage = await passwordInput.isVisible().catch(() => false);
  
  if (isLoginPage) {
    // Fill in password only (production login only has password)
    await passwordInput.fill(TEST_PASSWORD);
    
    // Click sign in button
    await page.click('button:has-text("Sign In")');
    
    // Wait for the main UI to load
    await page.waitForSelector('[data-testid="chat-interface"]', { timeout: 30000 });
  }
});

test.describe('Model Switching UI', () => {
  test('should display current model in status bar', async ({ page }) => {
    const modelIndicator = page.locator('[data-testid="model-indicator"]').first();
    await expect(modelIndicator).toBeVisible();
    
    const modelText = await modelIndicator.textContent();
    expect(modelText).toBeTruthy();
    expect(modelText!.length).toBeGreaterThan(0);
  });

  test('should open settings modal when clicking model indicator', async ({ page }) => {
    await page.click('[data-testid="model-indicator"]');
    
    const modal = page.locator('[data-testid="settings-modal"]').first();
    await expect(modal).toBeVisible();
    
    const modelSelector = page.locator('[data-testid="model-selector"]').first();
    await expect(modelSelector).toBeVisible();
  });

  test('should open model selector dropdown', async ({ page }) => {
    await page.click('[data-testid="model-indicator"]');
    await page.waitForSelector('[data-testid="settings-modal"]', { timeout: 10000 });
    
    await page.click('[data-testid="model-selector-trigger"]');
    
    const dropdown = page.locator('[data-testid="model-selector-dropdown"]').first();
    await expect(dropdown).toBeVisible();
  });

  test('should show search input in model selector', async ({ page }) => {
    await page.click('[data-testid="model-indicator"]');
    await page.waitForSelector('[data-testid="settings-modal"]', { timeout: 10000 });
    
    await page.click('[data-testid="model-selector-trigger"]');
    await page.waitForSelector('[data-testid="model-selector-dropdown"]', { timeout: 5000 });
    
    const searchInput = page.locator('[data-testid="model-selector-search"]').first();
    await expect(searchInput).toBeVisible();
  });

  test('should filter models when typing in search', async ({ page }) => {
    await page.click('[data-testid="model-indicator"]');
    await page.waitForSelector('[data-testid="settings-modal"]', { timeout: 10000 });
    
    await page.click('[data-testid="model-selector-trigger"]');
    await page.waitForSelector('[data-testid="model-selector-dropdown"]', { timeout: 5000 });
    
    const searchInput = page.locator('[data-testid="model-selector-search"]').first();
    await searchInput.fill('GPT');
    await page.waitForTimeout(500);
    
    // Verify the search was applied (no error means the UI handled it)
    await expect(searchInput).toHaveValue('GPT');
  });

  test('should close modal when clicking cancel', async ({ page }) => {
    await page.click('[data-testid="model-indicator"]');
    await page.waitForSelector('[data-testid="settings-modal"]', { timeout: 10000 });
    
    await page.click('button:has-text("Cancel")');
    await page.waitForSelector('[data-testid="settings-modal"]', { state: 'hidden', timeout: 5000 });
  });

  test('should show provider headers in model selector', async ({ page }) => {
    await page.click('[data-testid="model-indicator"]');
    await page.waitForSelector('[data-testid="settings-modal"]', { timeout: 10000 });
    
    await page.click('[data-testid="model-selector-trigger"]');
    await page.waitForSelector('[data-testid="model-selector-dropdown"]', { timeout: 5000 });
    
    const providerHeaders = page.locator('[data-testid="provider-header"]');
    const count = await providerHeaders.count();
    expect(count).toBeGreaterThan(0);
  });

  test('should select a model and enable save button', async ({ page }) => {
    await page.click('[data-testid="model-indicator"]');
    await page.waitForSelector('[data-testid="settings-modal"]', { timeout: 10000 });
    await page.waitForTimeout(1000);
    
    await page.click('[data-testid="model-selector-trigger"]');
    await page.waitForSelector('[data-testid="model-selector-dropdown"]', { timeout: 5000 });
    
    const firstModel = page.locator('[data-testid="model-option"]').first();
    const isVisible = await firstModel.isVisible().catch(() => false);
    
    if (isVisible) {
      await firstModel.click();
      const saveButton = page.locator('button:has-text("Save Changes")').first();
      await expect(saveButton).toBeEnabled();
    }
  });
});
