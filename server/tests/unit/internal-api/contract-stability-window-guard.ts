import { createHash } from 'node:crypto';
import type { ClientContractSnapshot } from '../../../../scripts/generate-client-snapshot.js';

/**
 * Pure guard logic for the C6 contract stability window (orchestration-scaling
 * plan). The window is declared in `docs/INTERNAL-API-CONTRACT.md` ("Stability
 * window" section): from contract 1.58.0 on 2026-09-30, bug fixes only — no new
 * wire features (route, field, error code, event type, capability feature,
 * observable default) unless the owner records an exception row in that
 * section's table. The owner sets the window's length at R3; until then it is
 * open-ended.
 *
 * This module is deliberately dependency-light (node:crypto only) so the test
 * stays cheap and deterministic: everything here is pure — parse a document,
 * judge a version, fingerprint a snapshot.
 */

/** The contract version the window opened at (1.58.0, 2026-09-30). */
export const WINDOW_OPEN_VERSION = '1.58.0';
/** The date the window opened, as recorded in the contract document. */
export const WINDOW_OPEN_DATE = '2026-09-30';

/**
 * Baseline fingerprint of the client contract snapshot at the window's opening
 * version (git 29bbe327, contract 1.58.0). The ENFORCED fingerprint is the
 * SHA-256 of the snapshot's canonical shape: the parsed snapshot with the
 * top-level `contractVersion` field removed, serialised with recursively
 * sorted keys (so patch-bump regenerations that only move the version string
 * still match). The full-file hash is informational.
 */
export const BASELINE_SHAPE_SHA256 = '851a1545ab6f15cf2d2f1d26c3a59567b5bc17e95e8d8c6e867a3ce40dd4c7e9';
export const BASELINE_FULL_SHA256 = 'fab83d8b2c237d0f8d43733dbeff60fb45c2ee690cfe7ca2b1cc044da4dc5fec';

/** Sorted route keys of the snapshot at 1.58.0 (the window's route baseline). */
export const BASELINE_ROUTES: readonly string[] = [
  'createSession',
  'deleteSession',
  'deleteWatch',
  'getCapabilities',
  'getCapacity',
  'getRunReceipt',
  'getSessionGoal',
  'getSessionTranscript',
  'getWatch',
  'listModels',
  'listSessions',
  'registerWatch',
  'sendPrompt',
  'sessionControl',
  'sessionGoalControl',
  'watchesWait',
];

/** Sorted type names of the snapshot at 1.58.0 (the window's type baseline). */
export const BASELINE_TYPES: readonly string[] = [
  'ApiError',
  'CapabilitiesResponse',
  'CapacityPressureAverage',
  'CapacityResponse',
  'CommandCodeCatalogueMetadata',
  'CompletionBlock',
  'CompletionParseError',
  'CreateSessionResponse',
  'DeleteWatchRequest',
  'DeleteWatchResponse',
  'DetachedPromptResponse',
  'DuplicatePromptResponse',
  'GoalVerificationInfo',
  'InternalApiContractInfo',
  'ListSessionsResponse',
  'ModelInfo',
  'ModelsResponse',
  'Phase7PiShadowAffinity',
  'Phase7PiShadowClassification',
  'Phase7PiShadowEvidence',
  'Phase7PiShadowReasonCode',
  'Phase7PiShadowResourceIdentity',
  'PromptDispatchResponse',
  'PromptResponse',
  'RegisterWatchRequest',
  'RetentionLeaseRequest',
  'RetentionLeaseResponse',
  'RunActivityObservation',
  'RunCessationEvidence',
  'RunCessationState',
  'RunLivenessEvidence',
  'RunOutputEvidence',
  'RunReceipt',
  'RunTerminalObservation',
  'RunTokenUsage',
  'RunWatchdogEvidence',
  'RuntimeCapabilities',
  'SendPromptRequest',
  'SessionCompletionSurface',
  'SessionControlRequest',
  'SessionControlResponse',
  'SessionDetail',
  'SessionGoalProjection',
  'SessionInfo',
  'SessionRuntime',
  'TranscriptResponse',
  'WaitResponse',
  'WatchConditionSpec',
  'WatchConditionState',
  'WatchFireIfSettledResult',
  'WatchFiring',
  'WatchOnFireAction',
  'WatchResponse',
  'WatchSnapshot',
  'WatchWaitEntry',
  'WatchWakeAttempt',
  'WatchesWaitResponse',
];

export interface StabilityExceptionRow {
  date: string;
  decision: string;
  what: string;
  version: string;
}

export interface StabilityWindow {
  openVersion: string;
  openDate: string;
  openEnded: boolean;
  exceptions: StabilityExceptionRow[];
}

export interface GuardVerdict {
  ok: boolean;
  problems: string[];
}

/**
 * Parse the "### Stability window" section of the contract document. Tolerant
 * by design: returns `null` when the section is missing, and an empty
 * `exceptions` array when the table has no rows (the normal state).
 */
export function parseStabilityWindow(doc: string): StabilityWindow | null {
  const lines = doc.split('\n');
  const start = lines.findIndex((line) => line.trim() === '### Stability window');
  if (start === -1) return null;

  // The section runs until the next heading of the same or higher level.
  const end = lines.findIndex((line, i) => i > start && /^#{2,3} /.test(line));
  const section = lines.slice(start, end === -1 ? lines.length : end).join('\n');

  const openVersion = section.match(/opened at contract\s+(?:>\s*)?\*\*(\d+\.\d+\.\d+)\*\*/)?.[1] ?? '';
  const openDate = section.match(/on\s+(?:>\s*)?\*\*(\d{4}-\d{2}-\d{2})\*\*/)?.[1] ?? '';

  // Exception table: markdown rows; header and separator are skipped. Columns:
  // Date | Owner decision | What | Version. Zero body rows is valid.
  const exceptions: StabilityExceptionRow[] = [];
  const tableRows = section
    .split('\n')
    .filter((line) => line.trim().startsWith('|'))
    .map((line) =>
      line
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((cell) => cell.trim()),
    )
    .filter((cells) => !cells.every((cell) => /^:?-{3,}:?$/.test(cell)));
  for (const cells of tableRows.slice(1)) {
    if (cells.length < 4) continue;
    exceptions.push({
      date: cells[0],
      decision: cells[1],
      what: cells[2],
      version: cells[3],
    });
  }

  return {
    openVersion,
    openDate,
    openEnded: /open-ended/.test(section),
    exceptions,
  };
}

/** The `major.minor` prefix of a semver-ish contract version (`1.58.0` → `1.58`). */
export function majorMinor(version: string): string {
  const m = version.match(/^(\d+\.\d+)(?:\.|$)/);
  return m ? m[1] : version;
}

/** Whether any recorded exception row names the given major.minor version. */
export function tableNamesVersion(rows: StabilityExceptionRow[], target: string): boolean {
  return rows.some((row) => row.version === target || row.version.startsWith(`${target}.`));
}

/**
 * Version guard: inside the window the contract's major.minor must stay at the
 * window's opening major.minor (patch bumps 1.58.x are free) unless an
 * exception row names the version that moved.
 */
export function guardContractVersion(version: string, rows: StabilityExceptionRow[]): GuardVerdict {
  const mm = majorMinor(version);
  const baseline = majorMinor(WINDOW_OPEN_VERSION);
  if (mm === baseline) return { ok: true, problems: [] };
  if (tableNamesVersion(rows, mm)) return { ok: true, problems: [] };
  return {
    ok: false,
    problems: [
      `contract version ${version} (major.minor ${mm}) moved past the stability window's ` +
        `${WINDOW_OPEN_VERSION} while no exception row in docs/INTERNAL-API-CONTRACT.md ` +
        `("Stability window") names ${mm} — a minor bump is a new wire feature and needs ` +
        'a recorded owner exception',
    ],
  };
}

/**
 * Canonical shape of a snapshot: `contractVersion` removed, object keys
 * recursively sorted, stable JSON. Patch bumps that only move the version
 * string fingerprint identically to the baseline.
 */
export function canonicalShapeSnapshot(snapshot: ClientContractSnapshot): string {
  const { contractVersion: _stripped, ...rest } = snapshot;
  return JSON.stringify(sortKeysDeep(rest));
}

/** SHA-256 of the snapshot's canonical shape (the enforced fingerprint). */
export function shapeFingerprint(snapshot: ClientContractSnapshot): string {
  return createHash('sha256').update(canonicalShapeSnapshot(snapshot)).digest('hex');
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * Snapshot guard: inside the window the snapshot's shape must stay at the
 * 1.58.0 baseline unless an exception row names the current major.minor
 * exactly (a patch-version row such as the retroactive 1.58.5 record is a
 * bug-fix record and never admits shape changes). The
 * fingerprint is the wide net (any body change: routes, types, fields, error
 * codes, zod schemas, source files); route/type-set diffs are enumerated
 * explicitly so the failure message names what moved.
 */
export function guardSnapshotShape(
  snapshot: ClientContractSnapshot,
  rows: StabilityExceptionRow[],
  currentVersion: string,
): GuardVerdict {
  if (shapeFingerprint(snapshot) === BASELINE_SHAPE_SHA256) return { ok: true, problems: [] };

  const problems: string[] = [];
  const routes = Object.keys(snapshot.routes ?? {}).sort();
  const types = Object.keys(snapshot.types ?? {}).sort();
  const addedRoutes = routes.filter((r) => !BASELINE_ROUTES.includes(r));
  const removedRoutes = BASELINE_ROUTES.filter((r) => !routes.includes(r));
  const addedTypes = types.filter((t) => !BASELINE_TYPES.includes(t));
  const removedTypes = BASELINE_TYPES.filter((t) => !types.includes(t));
  if (addedRoutes.length) problems.push(`routes added since the ${WINDOW_OPEN_VERSION} baseline: ${addedRoutes.join(', ')}`);
  if (removedRoutes.length) problems.push(`routes removed since the ${WINDOW_OPEN_VERSION} baseline: ${removedRoutes.join(', ')}`);
  if (addedTypes.length) problems.push(`types added since the ${WINDOW_OPEN_VERSION} baseline: ${addedTypes.join(', ')}`);
  if (removedTypes.length) problems.push(`types removed since the ${WINDOW_OPEN_VERSION} baseline: ${removedTypes.join(', ')}`);
  if (!problems.length) {
    problems.push(
      `snapshot body changed since the ${WINDOW_OPEN_VERSION} baseline without a route or type ` +
        'change (a field, error code, zod schema or source-file change)',
    );
  }

  const mm = majorMinor(currentVersion);
  // Exact match, deliberately NOT tableNamesVersion's prefix rule: a
  // patch-version row (e.g. the retroactive 1.58.5 record from J4) documents
  // a bug fix and must never admit a shape change — otherwise one patch row
  // would silently admit any unauthorised shape drift for the rest of the
  // window. Inside the window shape changes ride minor bumps, whose exception
  // rows name the major.minor ("1.59"); the version guard below keeps the
  // prefix rule so a minor exception still covers its own patch releases
  // (a 1.59 row admits 1.59.x).
  if (rows.some((row) => row.version === mm)) return { ok: true, problems: [] };
  problems.push(
    `no exception row in docs/INTERNAL-API-CONTRACT.md ("Stability window") names contract ${mm} — ` +
      'a client-observable snapshot change needs a recorded owner exception',
  );
  return { ok: false, problems };
}
