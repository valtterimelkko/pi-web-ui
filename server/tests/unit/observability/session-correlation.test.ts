import { describe, expect, it, vi } from 'vitest';
import { resolveCanonicalSessionId } from '../../../src/observability/session-correlation.js';

describe('session correlation identity', () => {
  it('maps a runtime session path to the registry internal id', async () => {
    const registry = {
      getByPath: vi.fn().mockResolvedValue({ id: 'canonical-session-id' }),
    };

    await expect(resolveCanonicalSessionId('/tmp/pi-session.jsonl', registry)).resolves.toBe('canonical-session-id');
    expect(registry.getByPath).toHaveBeenCalledWith('/tmp/pi-session.jsonl');
  });

  it('falls back to the supplied path when the registry cannot resolve it', async () => {
    const registry = {
      getByPath: vi.fn().mockRejectedValue(new Error('registry unavailable')),
    };

    await expect(resolveCanonicalSessionId('/tmp/pi-session.jsonl', registry)).resolves.toBe('/tmp/pi-session.jsonl');
  });
});
