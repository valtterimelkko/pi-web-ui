import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { INTERNAL_API_CONTRACT_VERSION } from '../../../src/internal-api/types.js';
import type { ClientContractSnapshot } from '../../../../scripts/generate-client-snapshot.js';
import {
  BASELINE_SHAPE_SHA256,
  BASELINE_TYPES,
  BASELINE_ROUTES,
  WINDOW_OPEN_DATE,
  WINDOW_OPEN_VERSION,
  canonicalShapeSnapshot,
  guardContractVersion,
  guardSnapshotShape,
  majorMinor,
  parseStabilityWindow,
  shapeFingerprint,
  tableNamesVersion,
  type StabilityExceptionRow,
} from './contract-stability-window-guard.js';

/**
 * C6 — contract stability window (orchestration-scaling plan).
 *
 * The contract moved 1.15.0 → 1.47.0 in about eight weeks; after C1–C5 shipped,
 * the window declares a stable surface so parents and skills can catch up:
 * from 1.58.0 on 2026-09-30, bug fixes only (patch bumps `1.58.x` and
 * documentation); any client-observable new feature (route, field, error code,
 * event type, capability feature, default change) — and therefore any minor
 * bump — needs an owner exception recorded in the window's table.
 *
 * This guard mechanises the declaration:
 * - the contract version's major.minor must stay at `1.58` unless an exception
 *   row names the version that moved;
 * - the client snapshot's shape must stay at the 1.58.0 baseline (fingerprint
 *   of the parsed snapshot minus `contractVersion`, keys recursively sorted)
 *   unless an exception row names the current major.minor. The existing
 *   `client-snapshot-drift.test.ts` catches a schema change WITHOUT
 *   regeneration; this test also catches a properly REGENERATED snapshot whose
 *   route/type/body set differs from the window baseline.
 *
 * The simulated-bump tests below pin the semantics cheaply and deterministically:
 * a patch bump passes, a minor bump and an added field fail, and an owner
 * exception row admits both.
 */

const contractDocPath = fileURLToPath(
  new URL('../../../../docs/INTERNAL-API-CONTRACT.md', import.meta.url),
);
const snapshotPath = fileURLToPath(
  new URL('../../../../docs/contract/internal-api-client-snapshot.json', import.meta.url),
);

const EXCEPTION_ROW: StabilityExceptionRow = {
  date: '2026-09-30',
  decision: 'owner approved (test fixture)',
  what: 'simulated exception for the window guard test',
  version: '1.59',
};

describe('contract stability window (C6)', () => {
  const doc = readFileSync(contractDocPath, 'utf8');
  const committed = JSON.parse(readFileSync(snapshotPath, 'utf8')) as ClientContractSnapshot;
  const parsed = parseStabilityWindow(doc);

  /** Deep-clone the committed snapshot and hand it a simulated minor bump. */
  function bumpedSnapshot(mutate: (clone: ClientContractSnapshot) => void): ClientContractSnapshot {
    const clone = JSON.parse(JSON.stringify(committed)) as ClientContractSnapshot;
    clone.contractVersion = '1.59.0';
    mutate(clone);
    return clone;
  }

  describe('documented window', () => {
    it('is declared in the contract document', () => {
      expect(parsed, 'docs/INTERNAL-API-CONTRACT.md has no "### Stability window" section').not.toBeNull();
    });

    it('opens at the window baseline version and date recorded by the guard', () => {
      expect(parsed?.openVersion).toBe(WINDOW_OPEN_VERSION);
      expect(parsed?.openDate).toBe(WINDOW_OPEN_DATE);
    });

    it('states the owner-set length (R3: until programme close) with no calendar end date', () => {
      expect(doc).toMatch(/Length \(owner, R3 2026-09-30\): open until the/);
      expect(parsed?.openEnded).toBe(true);
    });

    it('parses the exception table and tolerates it being empty', () => {
      expect(parsed?.exceptions).toEqual([]);
      const withRows = parseStabilityWindow(
        [
          '### Stability window',
          'It opened at contract **1.58.0** on **2026-09-30**; open-ended.',
          '| Date | Owner decision | What | Version |',
          '| --- | --- | --- | --- |',
          '| 2026-10-01 | owner approved | a new route | 1.59 |',
          '',
          '### Changelog',
        ].join('\n'),
      );
      expect(withRows?.exceptions).toEqual([
        { date: '2026-10-01', decision: 'owner approved', what: 'a new route', version: '1.59' },
      ]);
    });
  });

  describe('version guard', () => {
    it('accepts the live contract version while it stays inside 1.58', () => {
      expect(parsed).not.toBeNull();
      const verdict = guardContractVersion(INTERNAL_API_CONTRACT_VERSION, parsed!.exceptions);
      expect(verdict.problems).toEqual([]);
      expect(verdict.ok).toBe(true);
      expect(majorMinor(INTERNAL_API_CONTRACT_VERSION)).toBe('1.58');
    });

    it('passes a simulated patch bump (1.58.x) with no exception row', () => {
      const verdict = guardContractVersion('1.58.1', []);
      expect(verdict.ok).toBe(true);
      expect(verdict.problems).toEqual([]);
    });

    it('fails a simulated minor bump (1.59.0) with no exception row', () => {
      const verdict = guardContractVersion('1.59.0', []);
      expect(verdict.ok).toBe(false);
      expect(verdict.problems.join(' ')).toMatch(/1\.59/);
    });

    it('fails a simulated major bump with no exception row', () => {
      expect(guardContractVersion('2.0.0', []).ok).toBe(false);
    });

    it('passes a simulated minor bump when an exception row names the version', () => {
      const verdict = guardContractVersion('1.59.0', [EXCEPTION_ROW]);
      expect(verdict.ok).toBe(true);
      expect(verdict.problems).toEqual([]);
    });

    it('distinguishes 1.59 from 1.5 and 1.58 (prefix safety)', () => {
      expect(tableNamesVersion([{ date: 'd', decision: 'x', what: 'y', version: '1.5' }], '1.59')).toBe(false);
      expect(tableNamesVersion([{ date: 'd', decision: 'x', what: 'y', version: '1.58' }], '1.59')).toBe(false);
      expect(tableNamesVersion([{ date: 'd', decision: 'x', what: 'y', version: '1.59.1' }], '1.59')).toBe(true);
    });
  });

  describe('snapshot fingerprint guard', () => {
    it('committed snapshot shape matches the 1.58.0 window baseline', () => {
      expect(parsed).not.toBeNull();
      expect(shapeFingerprint(committed)).toBe(BASELINE_SHAPE_SHA256);
      const verdict = guardSnapshotShape(committed, parsed!.exceptions, INTERNAL_API_CONTRACT_VERSION);
      expect(verdict.ok).toBe(true);
      expect(verdict.problems).toEqual([]);
    });

    it('route and type sets still match the baseline (explicit enumeration)', () => {
      expect(Object.keys(committed.routes).sort()).toEqual([...BASELINE_ROUTES].sort());
      expect(Object.keys(committed.types).sort()).toEqual([...BASELINE_TYPES].sort());
    });

    it('canonical shape strips only contractVersion (deterministic)', () => {
      const again = JSON.parse(JSON.stringify(committed)) as ClientContractSnapshot;
      expect(canonicalShapeSnapshot(committed)).toBe(canonicalShapeSnapshot(again));
      again.contractVersion = '1.58.1';
      expect(shapeFingerprint(again)).toBe(BASELINE_SHAPE_SHA256);
    });

    it('passes a simulated patch bump: only contractVersion moved', () => {
      const bumped = bumpedSnapshot(() => undefined);
      expect(shapeFingerprint(bumped)).toBe(BASELINE_SHAPE_SHA256);
      const verdict = guardSnapshotShape(bumped, [], '1.58.1');
      expect(verdict.ok).toBe(true);
      expect(verdict.problems).toEqual([]);
    });

    it('fails a simulated added field with no exception row', () => {
      const added = bumpedSnapshot((clone) => {
        (clone.types.SessionInfo.fields as Record<string, unknown>).newWireField = { type: 'string' };
      });
      const verdict = guardSnapshotShape(added, [], '1.59.0');
      expect(verdict.ok).toBe(false);
      expect(verdict.problems.join(' ')).toMatch(/field, error code, zod schema or source-file change/);
      expect(verdict.problems.join(' ')).toMatch(/no exception row/);
    });

    it('fails a simulated added route with no exception row', () => {
      const added = bumpedSnapshot((clone) => {
        (clone.routes as Record<string, unknown>).newThing = {
          method: 'GET',
          path: '/api/v1/new-thing',
          handler: 'handleNewThing',
          sourceFile: 'server/src/internal-api/routes/sessions.ts',
          response: 'SessionInfo',
        };
      });
      const verdict = guardSnapshotShape(added, [], '1.59.0');
      expect(verdict.ok).toBe(false);
      expect(verdict.problems.join(' ')).toMatch(/routes added since the 1\.58\.0 baseline: newThing/);
    });

    it('fails a simulated removed type with no exception row', () => {
      const removed = bumpedSnapshot((clone) => {
        delete (clone.types as Record<string, unknown>).WatchWakeAttempt;
      });
      const verdict = guardSnapshotShape(removed, [], '1.59.0');
      expect(verdict.ok).toBe(false);
      expect(verdict.problems.join(' ')).toMatch(/types removed since the 1\.58\.0 baseline: WatchWakeAttempt/);
    });

    it('passes a simulated route addition when an exception row names the version', () => {
      const added = bumpedSnapshot((clone) => {
        (clone.routes as Record<string, unknown>).newThing = {
          method: 'GET',
          path: '/api/v1/new-thing',
          handler: 'handleNewThing',
          sourceFile: 'server/src/internal-api/routes/sessions.ts',
          response: 'SessionInfo',
        };
      });
      const verdict = guardSnapshotShape(added, [EXCEPTION_ROW], '1.59.0');
      expect(verdict.ok).toBe(true);
      expect(verdict.problems).toEqual([]);
    });
  });
});
