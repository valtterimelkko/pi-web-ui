import { describe, expect, it } from 'vitest';
import { buildSyntheticRegistry, DEFAULT_SYNTHETIC_REGISTRY_COUNT } from '../../../src/live-validation/heap-soak/registry-seed.js';

describe('buildSyntheticRegistry', () => {
  it('produces the default ~1,700 entries', () => {
    const registry = buildSyntheticRegistry('/root/.pi-web-ui/validation/heap-soak/run-1');
    expect(registry.entries).toHaveLength(DEFAULT_SYNTHETIC_REGISTRY_COUNT);
    expect(registry.version).toBe(1);
  });

  it('every entry has a unique id and points inside the run dir', () => {
    const runDir = '/root/.pi-web-ui/validation/heap-soak/run-1';
    const registry = buildSyntheticRegistry(runDir, 50);
    const ids = new Set(registry.entries.map((e) => e.id));
    expect(ids.size).toBe(50);
    for (const entry of registry.entries) {
      expect(entry.path.startsWith(runDir)).toBe(true);
      expect(entry.cwd.startsWith(runDir)).toBe(true);
      expect(entry.sdkType).toBe('pi');
      expect(entry.status).toBe('idle');
    }
  });

  it('is deterministic given the same nowIso (safe for a boot/listing proof)', () => {
    const a = buildSyntheticRegistry('/root/x', 10, '2026-01-01T00:00:00.000Z');
    const b = buildSyntheticRegistry('/root/x', 10, '2026-01-01T00:00:00.000Z');
    expect(a).toEqual(b);
  });

  it('respects a custom count', () => {
    expect(buildSyntheticRegistry('/root/x', 3).entries).toHaveLength(3);
    expect(buildSyntheticRegistry('/root/x', 0).entries).toHaveLength(0);
  });
});
