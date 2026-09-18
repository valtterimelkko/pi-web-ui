import { defineConfig } from '@playwright/test';

/**
 * Playwright config for Track M's receipt-verdict evidence (Wave 3).
 *
 * Separate from the repository's main `playwright.config.ts` (which boots a
 * whole disposable application server in global setup) for the same reason
 * Tracks C and L are: a page-level rendering of the voice surface neither needs
 * nor should depend on server health. Like theirs, it serves the lab page with
 * Vite — the lab imports the REAL product modules from source — and runs in
 * Chromium.
 *
 *   npx playwright test --config playwright.voice-live-receipts.config.ts
 *
 * Its default port differs from the ducking/presentation configs' so that no two
 * evidence runs can reuse (or fight over) each other's dev server.
 */
const PORT = Number(process.env.VOICE_LIVE_RECEIPTS_PORT ?? 3461);

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /voice-live-receipts\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list']],
  timeout: 120_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'off',
    screenshot: 'off',
    launchOptions: {
      args: [
        // The lane's audio (including the delivery chime) must not depend on a
        // prior gesture, and headless Chromium needs an explicit input device
        // for getUserMedia.
        '--autoplay-policy=no-user-gesture-required',
        '--use-fake-ui-for-media-stream',
        '--no-sandbox',
        '--disable-dev-shm-usage',
      ],
    },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: `npx vite --config client/voice-live-lab.vite.config.ts --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}/client/voice-live-lab.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
