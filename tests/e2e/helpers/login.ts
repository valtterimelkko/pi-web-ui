import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';

const ENV_FILE = '/tmp/step4-e2e-env.json';

type E2eEnvironment = {
  TEST_AUTH_PASSWORD?: string;
};

function readTestPassword(): string {
  const environment = JSON.parse(readFileSync(ENV_FILE, 'utf8')) as E2eEnvironment;
  if (!environment.TEST_AUTH_PASSWORD) {
    throw new Error(`TEST_AUTH_PASSWORD is missing from ${ENV_FILE}`);
  }
  return environment.TEST_AUTH_PASSWORD;
}

export async function loginIfNeeded(page: Page): Promise<void> {
  const passwordInput = page.locator('input[type="password"]');
  if (!(await passwordInput.isVisible().catch(() => false))) return;

  await passwordInput.fill(readTestPassword());
  await page.locator('button[type="submit"]').click();
  await page.waitForTimeout(3000);
}

export default loginIfNeeded;
