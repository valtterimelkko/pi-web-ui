import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { INTERNAL_API_CONTRACT_VERSION } from '../../../src/internal-api/types.js';

/**
 * The contract version constant and its human-readable record must agree.
 *
 * Why this exists (2026-09-15): the run-receipt watchdog gained a third value on
 * the wire — `liveness.watchdog.reason` became `'idle' | 'absolute' | 'no_activity'`
 * — and it merged, deployed and was documented in prose **without a version
 * bump**. The Agent OS mirror therefore still described a two-value field, so a
 * consumer switching on `reason` could mis-read a lost wake as a stalled turn.
 * It was caught by the operator asking whether a bump had been mirrored, not by
 * any test.
 *
 * No test can prove "this diff is wire-visible, so bump" — that stays a human
 * judgement at review. What CAN be mechanised is that the version number, its
 * changelog entry and its published example never drift apart, in either
 * direction: a bump with no changelog entry fails, and a changelog entry with no
 * bump fails because the constant will not match the documented current version.
 */
const contractDoc = fileURLToPath(new URL('../../../../docs/INTERNAL-API-CONTRACT.md', import.meta.url));

describe('Internal API contract version integrity', () => {
  const doc = readFileSync(contractDoc, 'utf8');

  it('is a well-formed 1.x.y version', () => {
    expect(INTERNAL_API_CONTRACT_VERSION).toMatch(/^1\.\d+\.\d+$/);
  });

  it('has a changelog entry in the canonical contract record', () => {
    // The house format is a bolded, owner-navigable entry: `- **1.43.0** (minor, additive …)`
    expect(
      doc.includes(`**${INTERNAL_API_CONTRACT_VERSION}**`),
      `docs/INTERNAL-API-CONTRACT.md has no changelog entry for contract ${INTERNAL_API_CONTRACT_VERSION}. ` +
        'Every version must record what changed, how a consumer adapts and how to roll back.',
    ).toBe(true);
  });

  it('publishes the same version in the documented contract example', () => {
    const all = [...doc.matchAll(/"contractVersion":\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(all.length, 'the contract example should publish a contractVersion').toBeGreaterThan(0);
    for (const published of all) {
      expect(
        published,
        'the contract document publishes a different version than the code constant',
      ).toBe(INTERNAL_API_CONTRACT_VERSION);
    }
  });
});
