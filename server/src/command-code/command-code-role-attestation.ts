import crypto from 'node:crypto';
import type { CommandCodeEffort, CommandCodeModel } from './command-code-model-catalog.js';
import type { CommandCodeInvocationRole } from './command-code-session-store.js';

export interface CommandCodeRoleAttestation {
  role: CommandCodeInvocationRole;
  model: CommandCodeModel;
  effort?: CommandCodeEffort;
  cwd: string;
  worktreeRoot: string;
  leaseId: string;
  parentSessionId?: string;
  issuedAt: string;
  signature: string;
}

export interface CommandCodeRoleAttestationPayload {
  role: CommandCodeInvocationRole;
  model: CommandCodeModel;
  effort?: CommandCodeEffort;
  cwd: string;
  worktreeRoot: string;
  leaseId: string;
  parentSessionId?: string;
  issuedAt: string;
}

export function createCommandCodeRoleAttestation(
  secret: string,
  payload: CommandCodeRoleAttestationPayload,
): CommandCodeRoleAttestation {
  if (!secret) throw new Error('Command Code role attestation secret is unavailable.');
  return { ...payload, signature: sign(secret, canonicalPayload(payload)) };
}

export function verifyCommandCodeRoleAttestation(
  secret: string | undefined,
  attestation: CommandCodeRoleAttestation | undefined,
  expected: { role: CommandCodeInvocationRole; model: CommandCodeModel; effort?: CommandCodeEffort; cwd: string },
  now = Date.now(),
): void {
  if (!secret || !attestation) throw new Error('Command Code role attestation is required.');
  if (attestation.role !== expected.role || attestation.model !== expected.model || attestation.effort !== expected.effort || attestation.cwd !== expected.cwd || attestation.worktreeRoot !== expected.cwd) {
    throw new Error('Command Code role attestation does not match the immutable session binding.');
  }
  if (!attestation.leaseId || attestation.leaseId.length > 256 || (attestation.role === 'implementation-child' && !attestation.parentSessionId) || (attestation.role === 'conductor-root' && attestation.parentSessionId !== undefined)) {
    throw new Error('Command Code role attestation lacks the required lease/parent binding.');
  }
  const issuedAt = Date.parse(attestation.issuedAt);
  if (!Number.isFinite(issuedAt) || Math.abs(now - issuedAt) > 5 * 60 * 1000) throw new Error('Command Code role attestation is expired or has an invalid timestamp.');
  if (!/^[a-f0-9]{64}$/.test(attestation.signature)) throw new Error('Command Code role attestation signature is malformed.');
  const payload: CommandCodeRoleAttestationPayload = {
    role: attestation.role,
    model: attestation.model,
    ...(attestation.effort ? { effort: attestation.effort } : {}),
    cwd: attestation.cwd,
    worktreeRoot: attestation.worktreeRoot,
    leaseId: attestation.leaseId,
    ...(attestation.parentSessionId ? { parentSessionId: attestation.parentSessionId } : {}),
    issuedAt: attestation.issuedAt,
  };
  const expectedSignature = sign(secret, canonicalPayload(payload));
  if (!crypto.timingSafeEqual(Buffer.from(expectedSignature, 'hex'), Buffer.from(attestation.signature, 'hex'))) throw new Error('Command Code role attestation signature is invalid.');
}

function canonicalPayload(payload: CommandCodeRoleAttestationPayload): string {
  return JSON.stringify({
    role: payload.role,
    model: payload.model,
    ...(payload.effort ? { effort: payload.effort } : {}),
    cwd: payload.cwd,
    worktreeRoot: payload.worktreeRoot,
    leaseId: payload.leaseId,
    ...(payload.parentSessionId ? { parentSessionId: payload.parentSessionId } : {}),
    issuedAt: payload.issuedAt,
  });
}

function sign(secret: string, payload: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}
