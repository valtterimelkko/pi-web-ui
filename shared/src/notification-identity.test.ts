/**
 * Tests for the canonical notification opt-in identity helper.
 *
 * The Pi dual-id desync (docs/NOTIFICATION-OPTIN-IDENTITY-FIX-PLAN.md) is fixed
 * by keying every notification opt-in on the same stable bare-UUID that the v2
 * session-metadata layer uses. These tests pin the extraction + canonicalization
 * against real prod-derived values (basename / bare-uuid / `.jsonl` path).
 */
import { describe, it, expect } from 'vitest';
import { piSessionIdFromPath, canonicalOptInId } from './notification-identity.js';

// Real prod-derived values (see docs/NOTIFICATION-OPTIN-IDENTITY-FIX-PLAN.md §2).
const UUID = '019f23d5-624d-7ca3-b34c-53b6732c2b44';
const BASENAME = `2026-07-02T17-16-54-733Z_${UUID}`;
const PATH = `/root/.pi/agent/sessions/--root-pi-web-ui--/${BASENAME}.jsonl`;

describe('piSessionIdFromPath', () => {
  it('extracts the bare uuid from a `…_<uuid>.jsonl` path', () => {
    expect(piSessionIdFromPath(PATH)).toBe(UUID);
  });

  it('extracts the uuid from a bare `<uuid>.jsonl` filename', () => {
    expect(piSessionIdFromPath(`${UUID}.jsonl`)).toBe(UUID);
  });

  it('returns null for a bare uuid with no `.jsonl` extension', () => {
    expect(piSessionIdFromPath(UUID)).toBeNull();
  });

  it('returns null for a basename (no `.jsonl` extension)', () => {
    expect(piSessionIdFromPath(BASENAME)).toBeNull();
  });

  it('returns null for a non-Pi path with no trailing `<uuid>.jsonl`', () => {
    expect(piSessionIdFromPath('/sessions/s1')).toBeNull();
    expect(piSessionIdFromPath('/root/.pi-web-ui/claude-sessions/abc.jsonl')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(piSessionIdFromPath('')).toBeNull();
  });
});

describe('canonicalOptInId', () => {
  describe('pi', () => {
    it('reduces a live basename id + `.jsonl` path to the bare uuid', () => {
      expect(canonicalOptInId('pi', BASENAME, PATH)).toBe(UUID);
    });

    it('is idempotent: a bare-uuid id (reloaded sidebar) maps to the same uuid', () => {
      expect(canonicalOptInId('pi', UUID, PATH)).toBe(UUID);
    });

    it('falls back to the given id when the path has no `<uuid>.jsonl` match', () => {
      // Test-fixture paths and non-file ids: keep the id as-is (do not mis-extract).
      expect(canonicalOptInId('pi', 's1', '/sessions/s1')).toBe('s1');
      expect(canonicalOptInId('pi', 's1', 's1')).toBe('s1');
    });
  });

  it.each(['claude', 'opencode', 'antigravity'] as const)(
    'returns the id unchanged for non-Pi runtime %s (id already equals path)',
    (runtime) => {
      const id = 'c1-abc';
      expect(canonicalOptInId(runtime, id, id)).toBe(id);
    },
  );

  it('does not let a Pi-looking path perturb a non-Pi runtime id', () => {
    // A claude session whose path happens to contain a uuid-like jsonl must NOT
    // be re-keyed — only Pi opt-ins are path-derived.
    expect(canonicalOptInId('claude', 'claude-id', PATH)).toBe('claude-id');
  });
});
