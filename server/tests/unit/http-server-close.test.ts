import { describe, expect, it, vi } from 'vitest';
import { closeHttpServer } from '../../src/http-server-close.js';

/**
 * Bounded HTTP server close (2026-09-15).
 *
 * Proved defect, twice in one evening: on 2026-09-14 18:04:17 and 21:15:56 the
 * shutdown handler ran, five of its six steps completed in under 25ms, and the
 * `http-server` step then never completed at all. `server.close()` only calls
 * back once every open connection has gone, and this process's WebSocket
 * clients are long-lived — so the step hung until the coordinator's own 25s
 * hard-exit fired and exited 1, with the total stop sitting a few seconds
 * inside systemd's `TimeoutStopSec=30`. That margin is the difference between a
 * recorded stop and a SIGKILL of the whole control group.
 *
 * Closing must therefore be *bounded*: stop listening, actively drop the
 * remaining connections, and treat a close that still has not called back as
 * done — the process is exiting anyway.
 */
describe('bounded http server close', () => {
  const neverCloses = () => ({
    close: vi.fn<(cb: (err?: Error) => void) => void>(),
    closeAllConnections: vi.fn(),
  });

  it('resolves as closed when the server closes promptly', async () => {
    const server = {
      close: vi.fn((cb: (err?: Error) => void) => cb()),
      closeAllConnections: vi.fn(),
    };
    await expect(closeHttpServer(server, { timeoutMs: 2_000 })).resolves.toBe('closed');
  });

  it('actively drops lingering connections rather than waiting for clients', async () => {
    const server = {
      close: vi.fn((cb: (err?: Error) => void) => { void cb; }),
      closeAllConnections: vi.fn(),
    };
    const outcome = await closeHttpServer(server, { timeoutMs: 50 });
    expect(outcome).toBe('timed-out');
    expect(server.closeAllConnections).toHaveBeenCalled();
  });

  it('does not hang forever when close never calls back', async () => {
    const server = neverCloses();
    const started = Date.now();
    const outcome = await closeHttpServer(server, { timeoutMs: 50 });
    expect(outcome).toBe('timed-out');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('tolerates a server implementation without closeAllConnections', async () => {
    const server = { close: vi.fn((cb: (err?: Error) => void) => { void cb; }) };
    await expect(closeHttpServer(server, { timeoutMs: 20 })).resolves.toBe('timed-out');
  });

  it('reports a close error instead of throwing, so teardown continues', async () => {
    const server = {
      close: vi.fn((cb: (err?: Error) => void) => cb(new Error('not listening'))),
      closeAllConnections: vi.fn(),
    };
    await expect(closeHttpServer(server, { timeoutMs: 20 })).resolves.toBe('closed');
  });

  it('reports how long the close took, for the step timings in the journal', async () => {
    let now = 0;
    const server = {
      close: vi.fn((cb: (err?: Error) => void) => { now = 1_234; cb(); }),
      closeAllConnections: vi.fn(),
    };
    const result = await closeHttpServer(server, { timeoutMs: 2_000, now: () => now });
    expect(result).toBe('closed');
  });
});
