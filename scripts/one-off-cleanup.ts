#!/usr/bin/env npx tsx
/**
 * One-off cleanup runner.
 *
 * Loads the current SessionCleanupService logic and runs a single cleanup pass
 * against the real prefs/registry. Use this to exercise new cleanup logic
 * before the production server process is restarted.
 */
import path from 'path';
import os from 'os';
import { SessionCleanupService } from '../server/src/session-cleanup.js';
import { withPrefsLock, PREFS_FILE } from '../server/src/routes/preferences.js';
import { getSessionRegistry } from '../server/src/session-registry.js';

async function main() {
  // Prime the registry singleton so cleanup can resolve entries.
  getSessionRegistry(path.join(os.homedir(), '.pi-web-ui', 'session-registry.json'));

  const service = new SessionCleanupService();
  // Dummy runtime bindings: the cleanup pass we care about here is file
  // deletion, and unpin calls against non-loaded sessions are no-ops.
  service.bindRuntimes({
    multiSessionManager: {
      unpinSession: () => true,
      getActiveSession: () => undefined,
    } as any,
    claudeService: { unpinSession: () => true } as any,
    opencodeService: { unpinSession: () => true, getSessionStatuses: () => [] } as any,
    antigravityService: { unpinSession: () => true } as any,
  });

  console.log(`[OneOffCleanup] Starting cleanup against ${PREFS_FILE}`);
  const result = await service.runCleanup(PREFS_FILE);
  console.log('[OneOffCleanup] Complete:', result);

  // Also print current archive counts for visibility.
  const prefs = await withPrefsLock(async (read) => read(), PREFS_FILE);
  console.log(
    '[OneOffCleanup] Remaining archived paths:',
    (prefs.archivedSessionPaths ?? []).length,
  );
}

main().catch((err) => {
  console.error('[OneOffCleanup] Failed:', err);
  process.exit(1);
});
