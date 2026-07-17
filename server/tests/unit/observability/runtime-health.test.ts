import { describe, expect, it, vi } from 'vitest';
import { RuntimeHealthMonitor } from '../../../src/observability/runtime-health.js';

describe('RuntimeHealthMonitor', () => {
  it('uses one bounded semantic matrix and retains the last failed check', async () => {
    let now = Date.parse('2026-07-17T10:00:00.000Z');
    const opencode = vi.fn().mockRejectedValueOnce(new Error('token=secret transport failed')).mockResolvedValueOnce(true);
    const monitor = new RuntimeHealthMonitor({ now: () => now });

    const failed = await monitor.check({
      pi: { enabled: true, backend: 'native', probe: async () => true },
      claude: { enabled: false, backend: 'direct' },
      opencode: { enabled: true, backend: 'server', probe: opencode },
      antigravity: { enabled: true, backend: 'subprocess', probe: async () => false },
    });

    expect(failed).toMatchObject({
      pi: { enabled: true, available: true, backend: 'native', checkStatus: 'ok' },
      claude: { enabled: false, available: false, backend: 'direct', checkStatus: 'disabled' },
      opencode: { enabled: true, available: false, backend: 'server', checkStatus: 'error' },
      antigravity: { enabled: true, available: false, backend: 'subprocess', checkStatus: 'unavailable' },
    });
    expect(failed.opencode.lastFailure?.message).not.toContain('secret');

    now += 1_000;
    const recovered = await monitor.check({
      pi: { enabled: true, backend: 'native', probe: async () => true },
      claude: { enabled: false, backend: 'direct' },
      opencode: { enabled: true, backend: 'server', probe: opencode },
      antigravity: { enabled: true, backend: 'subprocess', probe: async () => true },
    });
    expect(recovered.opencode).toMatchObject({ available: true, checkStatus: 'ok' });
    expect(recovered.opencode.lastFailure).toMatchObject({
      at: '2026-07-17T10:00:00.000Z',
      message: '[REDACTED] transport failed',
    });
  });

  it('bounds a probe that never settles', async () => {
    const monitor = new RuntimeHealthMonitor({ timeoutMs: 20 });
    const matrix = await monitor.check({
      pi: { enabled: true, backend: 'native', probe: () => new Promise<boolean>(() => {}) },
      claude: { enabled: false, backend: 'direct' },
      opencode: { enabled: false, backend: 'server' },
      antigravity: { enabled: false, backend: 'subprocess' },
    });
    expect(matrix.pi).toMatchObject({ available: false, checkStatus: 'error' });
    expect(matrix.pi.lastFailure?.message).toContain('timed out');
  });
});
