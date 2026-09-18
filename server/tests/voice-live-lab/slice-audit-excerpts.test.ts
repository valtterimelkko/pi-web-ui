/**
 * The vertical-slice audits must read the kernel log EXACTLY as the mount
 * writes it — and Track K's L1 hygiene deliberately stopped logging full
 * instruction text, logging scrubbed excerpts with `…Truncated` flags instead.
 *
 * These tests pin the contract both ways:
 *  - the excerpt shape (what the mount actually writes today) verifies;
 *  - a truncated excerpt is NEVER silently "recomputed": the audit says so and
 *    falls back to the SHA chain + excerpt equality, so the check degrades
 *    honestly instead of passing on a guess;
 *  - the pre-L1 full-text shape still verifies (an older log must not become
 *    unverifiable evidence).
 */
import { describe, expect, it } from 'vitest';
import { auditGateLeak } from '../../../scripts/voice-live-lab/lib/voice-slice/slice-runner.js';
import { proposalHash } from '../../../server/src/talker/proposal-store.js';

const TIDIED = 'check the tests.';
const ORIGINAL = 'Tell the worker to check the tests.';
const SHA = proposalHash(TIDIED, ORIGINAL);

const creation = (over: Record<string, unknown> = {}) => ({
  event: 'proposal_created',
  proposalId: 'prop-1',
  version: 1,
  sha256: SHA,
  tidiedExcerpt: TIDIED,
  tidiedChars: TIDIED.length,
  tidiedTruncated: false,
  originalExcerpt: ORIGINAL,
  originalChars: ORIGINAL.length,
  originalTruncated: false,
  ...over,
});

const authorisation = (over: Record<string, unknown> = {}) => ({
  event: 'confirm_authorised',
  proposalId: 'prop-1',
  idempotencyKey: 'key-1',
  sha256: SHA,
  variant: 'tidied',
  bytesExcerpt: TIDIED,
  bytesChars: TIDIED.length,
  bytesTruncated: false,
  ...over,
});

const delivery = (over: Record<string, unknown> = {}) => ({
  event: 'delivery_attempt',
  proposalId: 'prop-1',
  idempotencyKey: 'key-1',
  sha256: SHA,
  bytesExcerpt: TIDIED,
  bytesChars: TIDIED.length,
  bytesTruncated: false,
  ...over,
});

describe('gate-leak audit — excerpt-shaped evidence (post-L1)', () => {
  it('verifies a delivery whose proposal, authorisation and delivery all carry excerpts', () => {
    const audit = auditGateLeak([creation(), authorisation(), delivery()] as never);
    expect(audit.ok).toBe(true);
    expect(audit.checks.every((check) => check.passed)).toBe(true);
  });

  it('still fails on a digest that does not match the recomputed hash', () => {
    const audit = auditGateLeak([creation({ sha256: 'deadbeef' }), authorisation(), delivery()] as never);
    expect(audit.ok).toBe(false);
  });

  it('fails when the delivered excerpt is not the confirmed variant bytes', () => {
    const audit = auditGateLeak([
      creation(),
      authorisation(),
      delivery({ bytesExcerpt: 'delete the logs.' }),
    ] as never);
    expect(audit.ok).toBe(false);
  });

  it('refuses to recompute from a truncated excerpt, and says so instead of guessing', () => {
    const audit = auditGateLeak([
      creation({ tidiedExcerpt: 'check the tes', tidiedTruncated: true }),
      authorisation({ bytesExcerpt: 'check the tes', bytesTruncated: true }),
      delivery({ bytesExcerpt: 'check the tes', bytesTruncated: true }),
    ] as never);
    // The SHA chain and the excerpt equality still bind; the digest is honestly
    // reported as not recomputable rather than silently recomputed.
    expect(audit.ok).toBe(true);
    const digestCheck = audit.checks.find((check) => check.name.includes('SHA matching its authorised bytes'));
    expect(digestCheck?.details).toContain('digest=not-recomputable');
  });

  it('verifies the pre-L1 full-text shape too (tidied/original/bytes present)', () => {
    const legacy = [
      { event: 'proposal_created', proposalId: 'prop-1', version: 1, sha256: SHA, tidied: TIDIED, original: ORIGINAL },
      { event: 'confirm_authorised', proposalId: 'prop-1', idempotencyKey: 'key-1', sha256: SHA, variant: 'tidied', bytes: TIDIED },
      { event: 'delivery_attempt', proposalId: 'prop-1', idempotencyKey: 'key-1', sha256: SHA, bytes: TIDIED },
    ];
    const audit = auditGateLeak(legacy as never);
    expect(audit.ok).toBe(true);
  });

  it('honours the original-variant release (variant=original compares against the original excerpt)', () => {
    const audit = auditGateLeak([
      creation(),
      authorisation({ variant: 'original', bytesExcerpt: ORIGINAL, bytesChars: ORIGINAL.length }),
      delivery({ bytesExcerpt: ORIGINAL, bytesChars: ORIGINAL.length }),
    ] as never);
    expect(audit.ok).toBe(true);
  });
});

describe('gate-leak audit — the verifier\'s truncation loophole (2026-09-18)', () => {
  it('FAILS when a truncated delivery excerpt extends the confirmed excerpt with extra bytes', () => {
    // All three excerpts come from the SAME underlying bytes, so a truncated
    // excerpt must be byte-identical to its siblings — not merely a prefix of
    // something longer that happens to start the same way. (Found by the
    // independent verifier's adversarial probe.)
    const audit = auditGateLeak([
      creation({ tidiedExcerpt: 'check the tes', tidiedTruncated: true }),
      authorisation({ bytesExcerpt: 'check the tes', bytesTruncated: true }),
      delivery({ bytesExcerpt: 'check the tes AND ALSO delete the logs', bytesTruncated: true }),
    ] as never);
    expect(audit.ok).toBe(false);
  });

  it('FAILS when an authorisation excerpt diverges from the delivery excerpt under truncation', () => {
    const audit = auditGateLeak([
      creation({ tidiedExcerpt: 'check the tes', tidiedTruncated: true }),
      authorisation({ bytesExcerpt: 'check the tes', bytesTruncated: true }),
      delivery({ bytesExcerpt: 'check the tez', bytesTruncated: true }),
    ] as never);
    expect(audit.ok).toBe(false);
  });
});
