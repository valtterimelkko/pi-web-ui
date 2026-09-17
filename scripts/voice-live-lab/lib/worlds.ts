/**
 * Scripted worker world schema `voice-lab.world/1` — loader and validator
 * (L2, §15.2).
 *
 * A world is the scripted worker the tiers 1–2 scenarios run against: an
 * initial `WorkerStateSnapshot` (the real talker type), a timeline of
 * snapshots and events, delivery-dependent transitions, and a hidden truth
 * that is never rendered — it exists only for the director's leakage check
 * and the manifest's golden strings.
 *
 * The world driver itself is L4 machinery; L2 ships the schema, the fixtures
 * and this validator so the scenario set is load-bearing from day one.
 */

import { readFileSync } from 'node:fs';
import type { WorkerStateSnapshot } from '../../../../server/src/talker/types.js';

export const WORLD_SCHEMA = 'voice-lab.world/1';

export interface WorldWorkerOutput {
  kind: 'worker-output';
  atMs?: number;
  id: string;
  text: string;
  speakAs?: 'worker-answer' | 'worker-status';
}

export interface WorldPermissionRequest {
  kind: 'permission-request';
  atMs?: number;
  id: string;
  text: string;
  timeoutMs?: number;
}

export interface WorldSnapshotPatch {
  kind: 'snapshot-patch';
  /** Fires only when a delivery contains this text. */
  onDelivery?: { containing?: string; any?: boolean };
  afterMs?: number;
  id?: string;
  patch: Partial<WorkerStateSnapshot>;
}

export type WorldTimelineEntry = WorldWorkerOutput | WorldPermissionRequest | WorldSnapshotPatch;

export interface WorkerWorld {
  schema: string;
  id: string;
  runtime: string;
  initial: WorkerStateSnapshot;
  timeline: WorldTimelineEntry[];
  /** Never rendered; declared as golden strings in the attempt manifest. */
  hiddenTruth: Record<string, string>;
  description?: string;
}

export interface ValidationProblems {
  ok: boolean;
  problems: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateWorld(value: unknown): ValidationProblems {
  const problems: string[] = [];
  if (!isRecord(value)) return { ok: false, problems: ['world is not an object'] };
  const world = value as unknown as WorkerWorld;

  if (world.schema !== WORLD_SCHEMA) {
    problems.push(`schema must be ${WORLD_SCHEMA}, got ${String(world.schema)}`);
  }
  if (typeof world.id !== 'string' || !/^[a-z0-9-]+$/.test(world.id)) {
    problems.push(`id must be a slug, got ${String(world.id)}`);
  }
  if (typeof world.runtime !== 'string' || world.runtime === '') {
    problems.push('runtime must be a non-empty string');
  }
  if (!isRecord(world.initial as unknown as Record<string, unknown>)) {
    problems.push('initial must be a WorkerStateSnapshot object');
  } else {
    const initial = world.initial as WorkerStateSnapshot;
    if (initial.lastAssistantText === undefined && initial.activity === undefined) {
      problems.push('initial snapshot needs at least activity or lastAssistantText');
    }
  }
  if (!Array.isArray(world.timeline)) {
    problems.push('timeline must be an array');
  } else {
    const seen = new Set<string>();
    world.timeline.forEach((entry, index) => {
      const where = `timeline[${index}]`;
      if (!isRecord(entry as unknown as Record<string, unknown>)) {
        problems.push(`${where}: not an object`);
        return;
      }
      if (entry.kind !== 'worker-output' && entry.kind !== 'permission-request' && entry.kind !== 'snapshot-patch') {
        problems.push(`${where}: unknown kind ${String(entry.kind)}`);
        return;
      }
      if (entry.kind !== 'snapshot-patch') {
        const delivery = entry.onDelivery as unknown as Record<string, unknown> | undefined;
        const deliveryTriggered = isRecord(delivery ?? {});
        if (typeof entry.id !== 'string' || entry.id === '') {
          problems.push(`${where}: ${entry.kind} entries need an id`);
        } else if (seen.has(entry.id)) {
          problems.push(`${where}: duplicate event id ${entry.id}`);
        } else {
          seen.add(entry.id);
        }
        // An entry is either scheduled (atMs) or delivery-triggered — never
        // floating with neither anchor.
        if (typeof entry.atMs !== 'number' && !deliveryTriggered) {
          problems.push(`${where}: ${entry.kind} entries need atMs or an onDelivery trigger`);
        }
        if (typeof entry.text !== 'string' || entry.text === '') {
          problems.push(`${where}: ${entry.kind} entries need text`);
        }
      } else {
        const patch = entry.patch as unknown as Record<string, unknown>;
        if (!isRecord(patch)) {
          problems.push(`${where}: snapshot-patch needs a patch object`);
        }
        const delivery = entry.onDelivery as unknown as Record<string, unknown> | undefined;
        if (delivery !== undefined && !isRecord(delivery)) {
          problems.push(`${where}: onDelivery must be { containing } or { any }`);
        }
      }
    });
  }
  if (!isRecord(world.hiddenTruth as unknown as Record<string, unknown>)) {
    problems.push('hiddenTruth must be an object of distinctive strings');
  } else {
    // Golden strings must be distinctive enough that a leak check means
    // something: single common tokens ("yes", "ok") would false-positive on
    // any transcript, so the validator refuses them at authoring time.
    for (const [key, value] of Object.entries(world.hiddenTruth as Record<string, unknown>)) {
      if (typeof value !== 'string' || value.trim().length < 8) {
        problems.push(`hiddenTruth.${key} must be a distinctive string of at least 8 characters`);
      }
    }
  }

  return { ok: problems.length === 0, problems };
}

export function loadWorldFile(filePath: string): WorkerWorld {
  const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
  const outcome = validateWorld(parsed);
  if (!outcome.ok) {
    throw new Error(`invalid world ${filePath}:\n  - ${outcome.problems.join('\n  - ')}`);
  }
  return parsed as WorkerWorld;
}

/** Golden strings a world contributes to the attempt manifest's leak check. */
export function goldenStringsFor(world: WorkerWorld): string[] {
  return Object.values(world.hiddenTruth).filter((value) => value.trim() !== '');
}
