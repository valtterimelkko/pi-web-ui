import { test, expect } from '@playwright/test';

const PASSWORD = 'Ey@U1U%d5D77J99F';

async function login(page: any) {
  await page.goto('/');
  await page.waitForSelector('input[type="password"]', { timeout: 10000 });
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  // Wait until we are redirected and the main chat interface is visible
  await page.waitForSelector('[data-testid="chat-interface"]', { timeout: 10000 });
}

test.describe('Copy Path Feature', () => {
  test.beforeEach(async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.setViewportSize({ width: 1280, height: 720 });
    await login(page);
  });

  test('can copy path of file/folder from files tab', async ({ page }) => {
    // Switch to files tab
    const filesTab = page.locator('button').filter({ hasText: /^Files$/ }).first();
    await expect(filesTab).toBeVisible({ timeout: 10000 });
    await filesTab.click();
    await page.waitForTimeout(2000);

    // Wait for the files list to render
    const fileRow = page.locator('.group.flex.items-center.cursor-pointer').first();
    await expect(fileRow).toBeVisible({ timeout: 10000 });

    // Locate the first item name
    const itemNameSpan = fileRow.locator('span.text-xs').first();
    const itemName = await itemNameSpan.textContent() || '';
    expect(itemName.length).toBeGreaterThan(0);

    // Click the file icon button (first button inside the row) to copy the path
    const iconBtn = fileRow.locator('button').first();
    await iconBtn.click();

    // Wait a brief moment for the toast/clipboard operation
    await page.waitForTimeout(1000);

    // Read the clipboard text
    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());

    // The clipboard should end with the item name
    expect(clipboardText.endsWith(itemName)).toBe(true);

    // There should be a green success toast visible
    const toast = page.locator('text=Path copied to clipboard').first();
    await expect(toast).toBeVisible({ timeout: 5000 });
  });
});
