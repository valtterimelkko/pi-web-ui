import { test, expect } from '@playwright/test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function login(page: any) {
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(1000);
  const passwordInput = page.locator('input[type="password"]');
  if (await passwordInput.isVisible().catch(() => false)) {
    await passwordInput.fill('Ey@U1U%d5D77J99F');
    await page.locator('button[type="submit"]').click();
    await page.waitForTimeout(3000);
  }
}

async function openNewSessionModal(page: any): Promise<boolean> {
  await page.waitForLoadState('networkidle').catch(() => null);

  const titleBtn = page.locator('button[title="New session"]').first();
  const textBtn = page.locator('button').filter({ hasText: /new session/i }).first();
  const testId = page.locator('[data-testid="new-session-btn"]');

  await titleBtn.waitFor({ state: 'visible', timeout: 6000 }).catch(() => null);

  const btn = (await titleBtn.isVisible().catch(() => false)) ? titleBtn
    : (await textBtn.isVisible().catch(() => false)) ? textBtn
    : testId;

  if (!(await btn.isVisible().catch(() => false))) return false;

  await btn.click();
  await page.waitForSelector('[data-testid="new-session-modal"]', { timeout: 5000 }).catch(() => null);
  await page.waitForTimeout(300);
  return true;
}

async function findSessionWithMessages(page: any) {
  await page.waitForSelector('[data-testid="chat-interface"]', { timeout: 5000 });
  const sessionItems = page.locator('[role="listitem"]');
  const count = await sessionItems.count();

  if (count === 0) return null;

  for (let i = 0; i < count; i++) {
    await sessionItems.nth(i).click();
    try {
      await page.waitForSelector('div.border-l-2.border-blue-400', { timeout: 5000 });
      const assistantMessages = page.locator('div.border-l-2.border-blue-400');
      const msgCount = await assistantMessages.count();
      if (msgCount > 0) return assistantMessages;
    } catch {
      // no messages in this session
    }
  }
  return null;
}

async function sendPrompt(page: any, prompt: string) {
  const messageInput = page.locator('textarea[placeholder*="message" i]').or(
    page.locator('textarea').first()
  );
  await messageInput.fill(prompt);

  const sendButton = page.locator('button[type="submit"]').or(
    page.locator('button[aria-label*="send" i]').or(
      page.locator('button').filter({ has: page.locator('svg') }).last()
    )
  );

  if (await sendButton.isVisible().catch(() => false)) {
    await sendButton.click();
  } else {
    await messageInput.press('Enter');
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Read Aloud Buttons', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('top and bottom read-aloud buttons exist on assistant messages', async ({ page }) => {
    let assistantMessages = await findSessionWithMessages(page);

    // If no existing session has messages, create a new Pi SDK session and send a prompt
    if (!assistantMessages) {
      const opened = await openNewSessionModal(page);
      if (!opened) {
        test.skip(true, 'Could not open new session modal');
        return;
      }

      // Pi SDK is selected by default — just create
      const createBtn = page.locator('button').filter({ hasText: /^Create$/ }).first();
      if (await createBtn.isVisible().catch(() => false)) {
        await createBtn.click();
        await page.waitForTimeout(2000);
      }

      // Send a simple prompt
      // Wait for the new session to be selected and input enabled
      const input = page.locator('textarea').first();
      await input.waitFor({ state: 'visible', timeout: 10000 });
      // The textarea may briefly be disabled while the session initializes
      await page.waitForFunction(() => {
        const ta = document.querySelector('textarea');
        return ta && !ta.disabled;
      }, { timeout: 10000 });
      await input.fill('Say hello in one short sentence.');
      await input.press('Enter');
      // Wait for assistant response to appear
      await page.waitForSelector('div.border-l-2.border-blue-400', { timeout: 60000 });

      assistantMessages = page.locator('div.border-l-2.border-blue-400');
    }

    const msgCount = await assistantMessages.count();
    test.skip(msgCount === 0, 'No assistant messages found');

    for (let i = 0; i < Math.min(msgCount, 3); i++) {
      const msg = assistantMessages.nth(i);
      const readAloudButtons = msg.locator('button[title="Read aloud"], button[title="Stop"], button[title="Loading…"]');
      await expect(readAloudButtons).toHaveCount(2);
    }
  });

  test('clicking read-aloud button triggers audio generation', async ({ page, context }) => {
    // Audio playback is triggered by user click, so autoplay permission is not required

    let assistantMessages = await findSessionWithMessages(page);

    if (!assistantMessages) {
      const opened = await openNewSessionModal(page);
      if (!opened) {
        test.skip(true, 'Could not open new session modal');
        return;
      }

      const createBtn = page.locator('button').filter({ hasText: /^Create$/ }).first();
      if (await createBtn.isVisible().catch(() => false)) {
        await createBtn.click();
        await page.waitForTimeout(2000);
      }

      // Wait for the new session to be selected and input enabled
      const input = page.locator('textarea').first();
      await input.waitFor({ state: 'visible', timeout: 10000 });
      await page.waitForFunction(() => {
        const ta = document.querySelector('textarea');
        return ta && !ta.disabled;
      }, { timeout: 10000 });
      await input.fill('Say hello in one short sentence.');
      await input.press('Enter');
      await page.waitForSelector('div.border-l-2.border-blue-400', { timeout: 60000 });

      assistantMessages = page.locator('div.border-l-2.border-blue-400');
    }

    const msgCount = await assistantMessages.count();
    test.skip(msgCount === 0, 'No assistant messages found');

    const firstMsg = assistantMessages.first();
    const topBtn = firstMsg.locator('button[title="Read aloud"]').first();

    // Button should be visible (on mobile) or appear on hover (desktop)
    await expect(topBtn).toBeVisible();

    // Intercept the TTS API call to verify it fires
    const ttsPromise = page.waitForRequest((req: any) => req.url().includes('/api/tts') && req.method() === 'POST');

    await topBtn.click();

    // Wait for the TTS request to be made
    const ttsReq = await ttsPromise;
    expect(ttsReq).toBeTruthy();

    // The button should switch to loading or playing state within a few seconds
    const activeBtn = firstMsg.locator('button[title="Stop"], button[title="Loading…"]').first();
    await expect(activeBtn).toBeVisible({ timeout: 5000 });
  });
});
