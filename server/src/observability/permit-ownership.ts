import type { SessionRuntime } from '../internal-api/types.js';

/**
 * R0 (02-answer): permit ownership accounting for the turn-count detector.
 *
 * The run manager holds the exact set of attached admission leases (active,
 * queued, draining and quarantined runs). Comparing admission's permit counter
 * against *those* counts — rather than against the accepted-minus-terminal
 * receipt counters — is identity-true: a terminal receipt that still holds its
 * lease behind the §11 drain/quarantine fence is debt, not a leak, and a joined
 * turn that holds no permit can never offset a real leak.
 *
 * This module is pure and synchronous: it reads one snapshot and one admission
 * count map taken in the same tick, classifies them, and returns a reading. It
 * never releases, acquires or mutates anything.
 */

/** The frozen R0 seam shape (lane A's `getLeaseOwnershipSnapshot()`). */
export interface LeaseOwnershipSnapshot {
  /** Started runs holding an attached admission lease. */
  activeByRuntime: Partial<Record<SessionRuntime, number>>;
  /** Queued runs holding an attached admission lease (they hold it from acceptance). */
  queuedByRuntime: Partial<Record<SessionRuntime, number>>;
  /** Terminal runs in the drain fence: cessation not yet confirmed (not quarantined). */
  drainingByRuntime: Partial<Record<SessionRuntime, number>>;
  /** Terminal runs whose drain timed out; the L1 reconciler releases them when quiescent. */
  quarantinedByRuntime: Partial<Record<SessionRuntime, number>>;
}

export type PermitOwnershipUnknownReason = 'source-failed' | 'invalid-snapshot' | 'invalid-admission-counts';

/** Classified ownership: every admission permit is accounted for or unexplained. */
export interface PermitOwnershipClassified {
  state: 'classified';
  /** Admission's permits per runtime, from the same reading tick. */
  admissionByRuntime: Record<string, number>;
  activeByRuntime: Record<string, number>;
  queuedByRuntime: Record<string, number>;
  drainingByRuntime: Record<string, number>;
  quarantinedByRuntime: Record<string, number>;
  /** The four disjoint lease categories summed per runtime. */
  knownByRuntime: Record<string, number>;
  /** `max(0, admission - known)` per runtime; only non-zero entries. */
  unexplainedByRuntime: Record<string, number>;
  /** Sum of the per-runtime remainders — never a global net that cancels runtimes. */
  unexplained: number;
  /** `max(0, known - admission)` per runtime (joined/other): evidence, never alerting. */
  reverseByRuntime: Record<string, number>;
  reverse: number;
}

/**
 * Ownership could not be classified (missing, throwing, malformed, or taken
 * against unusable admission counts). The detector must treat this as unknown:
 * it may neither present a cause nor recover an existing incident on it.
 */
export interface PermitOwnershipUnknown {
  state: 'unknown';
  reason: PermitOwnershipUnknownReason;
}

export type PermitOwnership = PermitOwnershipClassified | PermitOwnershipUnknown;

export function unknownPermitOwnership(reason: PermitOwnershipUnknownReason): PermitOwnershipUnknown {
  return { state: 'unknown', reason };
}

const CATEGORIES = ['activeByRuntime', 'queuedByRuntime', 'drainingByRuntime', 'quarantinedByRuntime'] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** Validated per-runtime counts of one snapshot category, or `undefined` when malformed. */
function readCategory(value: unknown): Record<string, number> | undefined {
  if (!isPlainObject(value)) return undefined;
  const counts: Record<string, number> = {};
  for (const [runtime, count] of Object.entries(value)) {
    if (!isCount(count)) return undefined;
    if (count > 0) counts[runtime] = count;
  }
  return counts;
}

function readCategories(snapshot: unknown): Record<(typeof CATEGORIES)[number], Record<string, number>> | undefined {
  if (!isPlainObject(snapshot)) return undefined;
  const categories = {} as Record<(typeof CATEGORIES)[number], Record<string, number>>;
  for (const category of CATEGORIES) {
    const counts = readCategory(snapshot[category]);
    if (!counts) return undefined;
    categories[category] = counts;
  }
  return categories;
}

function readAdmission(value: unknown): Record<string, number> | undefined {
  if (!isPlainObject(value)) return undefined;
  const counts: Record<string, number> = {};
  for (const [runtime, count] of Object.entries(value)) {
    if (!isCount(count)) return undefined;
    if (count > 0) counts[runtime] = count;
  }
  return counts;
}

/**
 * Classify one same-tick pair: admission's permits per runtime and the run
 * manager's attached leases per runtime. Fail-closed on anything malformed:
 * a bad count is `unknown`, never a zero mismatch (which would look like
 * agreement) and never a positive one (which would look like a leak).
 */
export function classifyPermitOwnership(
  snapshot: LeaseOwnershipSnapshot,
  admissionByRuntime: Record<string, number>,
): PermitOwnership {
  const categories = readCategories(snapshot);
  if (!categories) return unknownPermitOwnership('invalid-snapshot');
  const admission = readAdmission(admissionByRuntime);
  if (!admission) return unknownPermitOwnership('invalid-admission-counts');

  const runtimes = new Set<string>([
    ...Object.keys(admission),
    ...CATEGORIES.flatMap((category) => Object.keys(categories[category])),
  ]);

  const reading: PermitOwnershipClassified = {
    state: 'classified',
    admissionByRuntime: { ...admission },
    activeByRuntime: { ...categories.activeByRuntime },
    queuedByRuntime: { ...categories.queuedByRuntime },
    drainingByRuntime: { ...categories.drainingByRuntime },
    quarantinedByRuntime: { ...categories.quarantinedByRuntime },
    knownByRuntime: {},
    unexplainedByRuntime: {},
    unexplained: 0,
    reverseByRuntime: {},
    reverse: 0,
  };

  for (const runtime of runtimes) {
    const permits = admission[runtime] ?? 0;
    const known = CATEGORIES.reduce((sum, category) => sum + (categories[category][runtime] ?? 0), 0);
    if (known > 0) reading.knownByRuntime[runtime] = known;
    // Per-runtime remainders only: one runtime's joined surplus can never cancel
    // another runtime's unexplained permit.
    if (permits > known) {
      reading.unexplainedByRuntime[runtime] = permits - known;
      reading.unexplained += permits - known;
    } else if (known > permits) {
      reading.reverseByRuntime[runtime] = known - permits;
      reading.reverse += known - permits;
    }
  }

  return reading;
}

/** Total attached leases across the four disjoint categories. */
export function knownLeaseTotal(ownership: PermitOwnershipClassified): number {
  return Object.values(ownership.knownByRuntime).reduce((sum, value) => sum + value, 0);
}

/** One category's total across runtimes (for alert wording). */
export function categoryTotal(ownership: PermitOwnershipClassified, category: 'active' | 'queued' | 'draining' | 'quarantined'): number {
  const counts = ownership[`${category}ByRuntime` as const];
  return Object.values(counts).reduce((sum, value) => sum + value, 0);
}
