import { describe, expect, it } from 'vitest';
import { createCommandCodeRoleAttestation, verifyCommandCodeRoleAttestation } from '../../../src/command-code/command-code-role-attestation.js';

describe('Command Code role attestations', () => {
  it('verifies an exact root role/model/worktree binding', () => {
    const issuedAt = new Date('2026-08-08T04:00:00.000Z').toISOString();
    const attestation = createCommandCodeRoleAttestation('secret', {
      role: 'conductor-root', model: 'qwen/qwen3.8-max', cwd: '/work/root', worktreeRoot: '/work/root', leaseId: 'lease-1', issuedAt,
    });
    expect(() => verifyCommandCodeRoleAttestation('secret', attestation, { role: 'conductor-root', model: 'qwen/qwen3.8-max', cwd: '/work/root' }, Date.parse(issuedAt))).not.toThrow();
  });

  it('rejects tampering, stale attestations, and child attestations without a parent', () => {
    const issuedAt = new Date('2026-08-08T04:00:00.000Z').toISOString();
    const root = createCommandCodeRoleAttestation('secret', {
      role: 'conductor-root', model: 'qwen/qwen3.8-max', cwd: '/work/root', worktreeRoot: '/work/root', leaseId: 'lease-1', issuedAt,
    });
    expect(() => verifyCommandCodeRoleAttestation('secret', { ...root, cwd: '/work/other' }, { role: 'conductor-root', model: 'qwen/qwen3.8-max', cwd: '/work/other' }, Date.parse(issuedAt))).toThrow(/immutable|signature/i);
    expect(() => verifyCommandCodeRoleAttestation('secret', root, { role: 'conductor-root', model: 'qwen/qwen3.8-max', cwd: '/work/root' }, Date.parse(issuedAt) + 5 * 60 * 1000 + 1)).toThrow(/expired/i);
    const child = createCommandCodeRoleAttestation('secret', {
      role: 'implementation-child', model: 'meta/muse-spark-1.2-contributor', cwd: '/work/child', worktreeRoot: '/work/child', leaseId: 'lease-2', issuedAt,
    });
    expect(() => verifyCommandCodeRoleAttestation('secret', child, { role: 'implementation-child', model: 'meta/muse-spark-1.2-contributor', cwd: '/work/child' }, Date.parse(issuedAt))).toThrow(/parent/i);
  });
});
