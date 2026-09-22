import { execFileSync } from 'node:child_process';

/**
 * Stop the disposable validation server the voice-live-e2e config booted.
 *
 * Playwright's `webServer` teardown kills the spawned `npm` wrapper; the
 * validation launcher deliberately runs its node child in its OWN process group
 * (so a supervised host can stop exactly that group), which the wrapper kill
 * leaves orphaned. Stopping through the launcher's own authority is the
 * documented, process-group-scoped teardown — never a command-line pkill.
 */
const DIR = process.env.VOICE_E2E_DIR ?? '/tmp/voice-e2e-disposable';

export default function globalTeardown(): void {
  if (!process.env.GEMINI_API_KEY) return;
  try {
    execFileSync('node', ['scripts/validation-server-stop.mjs', '--dir', DIR], { stdio: 'ignore' });
  } catch {
    /* best effort: the disposable dir/process may already be gone */
  }
}
