import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for E2E testing
 * 
 * To run E2E tests:
 * 1. Start the dev server: npm run dev
 * 2. In another terminal: npx playwright test
 * 
 * Or set TEST_URL to point to an existing server:
 * TEST_URL=http://localhost:3000 npx playwright test
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: process.env.TEST_URL || 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // Web server auto-start disabled - start manually with 'npm run dev'
  // webServer: {
  //   command: 'npm run dev',
  //   url: 'http://localhost:5173',
  //   reuseExistingServer: !process.env.CI,
  //   timeout: 120000,
  // },
});
