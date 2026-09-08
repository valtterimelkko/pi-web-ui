import { randomUUID } from 'node:crypto';
import { getRuntimeBuildIdentity, type BuildIdentity } from './manifest.js';

export interface ProcessBootIdentity {
  bootId: string;
  startedAt: string;
}

/** One random identity per server process; it is deliberately not persisted. */
const processBootId = randomUUID();

/** Build identity is immutable for the lifetime of this loaded server process. */
export const runtimeBuildIdentity: BuildIdentity = getRuntimeBuildIdentity();

export function getProcessBootIdentity(startTime: number): ProcessBootIdentity {
  const startedAt = new Date(startTime);
  return {
    bootId: processBootId,
    startedAt: Number.isNaN(startedAt.getTime()) ? 'unknown' : startedAt.toISOString(),
  };
}
