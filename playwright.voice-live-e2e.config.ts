import bcrypt from 'bcrypt';
import { defineConfig } from '@playwright/test';

/**
 * End-to-end Voice Mode validation against a REAL disposable live-engine server
 * and the BUILT client (2026-09-22 owner request: "use playwright … to go through
 * that everything works end to end from front end to the back end").
 *
 * Opt-in, because it needs a real `GEMINI_API_KEY`:
 *
 *   GEMINI_API_KEY=… npm run build --workspace=client
 *   npx playwright test --config playwright.voice-live-e2e.config.ts
 *
 * It boots two disposable servers (never production):
 *   1. `npm run validate:server` with `VOICE_MODE_ENGINE=gemini-live`;
 *   2. `vite preview` serving `client/dist`, proxying `/api` and `/ws` to (1).
 *
 * Without `GEMINI_API_KEY` the spec skips (see the spec file), so CI stays green.
 */
const SERVER_PORT = Number(process.env.VOICE_E2E_SERVER_PORT ?? 3098);
const CLIENT_PORT = Number(process.env.VOICE_E2E_CLIENT_PORT ?? 3499);
const PASSWORD = process.env.VOICE_E2E_PASSWORD ?? 'voice-e2e';
const DIR = process.env.VOICE_E2E_DIR ?? '/tmp/voice-e2e-disposable';
const HASH = bcrypt.hashSync(PASSWORD, 10);
const hasKey = Boolean(process.env.GEMINI_API_KEY);

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /voice-live-e2e\.spec\.ts/,
  globalTeardown: './tests/e2e/voice-live-e2e-teardown.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list']],
  timeout: 240_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL: `http://localhost:${CLIENT_PORT}`,
    trace: 'off',
    screenshot: 'only-on-failure',
    permissions: ['microphone'],
    launchOptions: {
      args: [
        '--autoplay-policy=no-user-gesture-required',
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--no-sandbox',
        '--disable-dev-shm-usage',
      ],
    },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: hasKey
    ? [
        {
          command:
            `rm -rf ${DIR} && AUTH_PASSWORD='${HASH}' ` +
            `ALLOWED_ORIGINS='http://localhost:${CLIENT_PORT},http://127.0.0.1:${CLIENT_PORT}' ` +
            `VOICE_MODE_ENGINE=gemini-live ` +
            `npm run validate:server -- --dir ${DIR} --port ${SERVER_PORT} ` +
            `--claude-ws-port 43240 --claude-hook-port 43241 --opencode-port 44219`,
          url: `http://localhost:${SERVER_PORT}/health`,
          reuseExistingServer: false,
          timeout: 180_000,
        },
        {
          command: `cd client && VITE_API_TARGET=http://localhost:${SERVER_PORT} npx vite preview --port ${CLIENT_PORT} --strictPort`,
          url: `http://localhost:${CLIENT_PORT}/`,
          reuseExistingServer: false,
          timeout: 120_000,
        },
      ]
    : undefined,
});
