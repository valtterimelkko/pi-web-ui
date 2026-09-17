/**
 * Regression guard for a CI-failing failure mode in the session-route factory.
 *
 * `createSessionRoutes` starts asynchronous initialisation eagerly and exposes
 * the promise as `ready`. Production awaits it at startup
 * (`src/internal-api/server.ts`), and `shutdown()` awaits it too. A consumer
 * that never awaits it — as several route test harnesses did — used to turn any
 * initialisation failure into an *unhandled rejection*, which is fatal: Node
 * tears the process down and Vitest fails the entire run.
 *
 * CI hit exactly that with `PinExpiryStore.init()`:
 *
 *   Error: ENOENT: no such file or directory, mkdir
 *   '<unit-home>/tmp/pi-goal-routes-<suffix>/pins'
 *
 * The harness removed its temp directory in `afterEach` while that detached
 * `mkdir` was still in flight, so the rejection had no handler and the whole
 * server suite went red.
 *
 * The reproduction here is deterministic rather than timing-dependent: the pin
 * path is made unusable before the factory is called, so
 * `mkdir(pinDir, { recursive: true })` rejects with EEXIST every time. The
 * failure must still be observable at the awaited boundary (`ready`) — it must
 * only stop being *unhandled*.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunReceiptManager } from '../../../src/internal-api/run-receipts/run-receipt-manager.js';
import { RunReceiptStore } from '../../../src/internal-api/run-receipts/run-receipt-store.js';
import { createSessionRoutes } from '../../../src/internal-api/routes/sessions.js';

function buildRouteOptions(root: string, pinDir: string) {
  return {
    claudeService: {} as never,
    opencodeService: {} as never,
    antigravityService: {} as never,
    multiSessionManager: {} as never,
    sessionRegistry: { get: vi.fn(), listAll: vi.fn().mockResolvedValue([]) } as never,
    piService: {} as never,
    internalClientId: 'test-client',
    watchDir: path.join(root, 'watches'),
    pinDir,
    runReceiptManager: new RunReceiptManager({
      store: new RunReceiptStore(path.join(root, 'receipts'), {}),
      turnIdleTimeoutMs: 10_000,
      turnMaxMs: 10_000,
    }),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

describe('session route readiness', () => {
  const roots: string[] = [];

  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  async function makeRoot(): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pi-routes-ready-'));
    roots.push(root);
    return root;
  }

  it('surfaces a failed initialisation through ready instead of as an unhandled rejection', async () => {
    const root = await makeRoot();
    const pinDir = path.join(root, 'pins');
    // Occupying the pin path with a regular file makes PinExpiryStore.init()'s
    // mkdir reject deterministically, with the same "the directory this route
    // set was created against is not usable" shape CI hit.
    await writeFile(pinDir, 'not a directory');

    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandledRejection);
    try {
      // Deliberately never touch `ready` before waiting: this is the consumer
      // shape that produced the CI failure.
      const routes = createSessionRoutes(buildRouteOptions(root, pinDir));
      await delay(100);

      expect(unhandled).toEqual([]);
      await expect(routes.ready).rejects.toMatchObject({ code: 'EEXIST' });
      await expect(routes.shutdown()).resolves.toBeUndefined();
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });
});
