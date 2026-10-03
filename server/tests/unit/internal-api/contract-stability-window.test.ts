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

/**
 * The live table's rows: (1) R5 (2026-10-03) — the owner-authorised wave K
 * minor bump that closed the window's minor-bump moratorium; (2) the
 * RETROACTIVE 1.58.5 record (J4, 2026-10-02) of the owner-accepted
 * working-set change. The 1.58.5 changelog had already documented it as a
 * wire-identical bug fix (the snapshot fingerprints identically to 1.58.0
 * apart from the version), so that row records the semantic change — it
 * grants nothing. The 1.59.0 row is what admits the wave K shape and version
 * move below.
 */
const R5_WAVE_K_ROW: StabilityExceptionRow = {
  date: '2026-10-03',
  decision: 'R5 (wave K GO, slimmed)',
  what: '1.59.0: wave K — a Pi goal child continues once after a transient stop; non-continued stops surface as `goal_state` `paused`/`interrupted` with the additive `interruption` object',
  version: '1.59',
};

const RETROACTIVE_1_58_5_ROW: StabilityExceptionRow = {
  date: '2026-10-02',
  decision: 'post-H-b review (owner accepted)',
  what: '1.58.5: /capacity memory.currentBytes and admission memory checks report working set (current − inactive_file), not total',
  version: '1.58.5',
};

describe('contract stability window (C6)', () => {
  const doc = readFileSync(contractDocPath, 'utf8');
  const committed = JSON.parse(readFileSync(snapshotPath, 'utf8')) as ClientContractSnapshot;
  const parsed = parseStabilityWindow(doc);

  /**
   * The 1.58.0 window-baseline shape, reconstructed from the committed
   * snapshot by removing exactly the wave K additions (R5 exception). The
   * baseline-fingerprint tests simulate bumps from THIS shape.
   */
  function baselineSnapshot(): ClientContractSnapshot {
    const clone = JSON.parse(JSON.stringify(committed)) as ClientContractSnapshot;
    clone.contractVersion = '1.58.0';
    delete (clone.types as Record<string, unknown>).GoalInterruptionInfo;
    delete (clone.types as Record<string, unknown>).GoalInterruptionCause;
    const projection = clone.types.SessionGoalProjection?.fields as Record<string, unknown> | undefined;
    delete projection?.interruption;
    return clone;
  }

  /** Deep-clone the baseline snapshot and hand it a simulated minor bump. */
  function bumpedSnapshot(mutate: (clone: ClientContractSnapshot) => void): ClientContractSnapshot {
    const clone = JSON.parse(JSON.stringify(baselineSnapshot())) as ClientContractSnapshot;
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

    it('parses the live exception table: the R5 wave K row plus the retroactive 1.58.5 row', () => {
      expect(parsed?.exceptions).toEqual([R5_WAVE_K_ROW, RETROACTIVE_1_58_5_ROW]);
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
    it('accepts the live contract version: 1.59.0 is admitted by the R5 wave K exception row', () => {
      expect(parsed).not.toBeNull();
      const verdict = guardContractVersion(INTERNAL_API_CONTRACT_VERSION, parsed!.exceptions);
      expect(verdict.problems).toEqual([]);
      expect(verdict.ok).toBe(true);
      expect(majorMinor(INTERNAL_API_CONTRACT_VERSION)).toBe('1.59');
      // and it would fail without the R5 row (the window is otherwise closed):
      const unauthorised = guardContractVersion(INTERNAL_API_CONTRACT_VERSION, [RETROACTIVE_1_58_5_ROW]);
      expect(unauthorised.ok).toBe(false);
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
    it('the regenerated 1.59.0 snapshot shape differs from the 1.58.0 baseline and is admitted by the R5 wave K row', () => {
      expect(parsed).not.toBeNull();
      expect(shapeFingerprint(committed)).not.toBe(BASELINE_SHAPE_SHA256);
      const verdict = guardSnapshotShape(committed, parsed!.exceptions, INTERNAL_API_CONTRACT_VERSION);
      expect(verdict.ok).toBe(true);
      expect(verdict.problems).toEqual([]);
      // and it would fail without the R5 row:
      const unauthorised = guardSnapshotShape(committed, [RETROACTIVE_1_58_5_ROW], INTERNAL_API_CONTRACT_VERSION);
      expect(unauthorised.ok).toBe(false);
    });

    it('route set matches the baseline; the type set gains exactly the two wave K types (explicit enumeration)', () => {
      expect(Object.keys(committed.routes).sort()).toEqual([...BASELINE_ROUTES].sort());
      expect(Object.keys(committed.types).sort()).toEqual([...BASELINE_TYPES, 'GoalInterruptionInfo'].sort());
    });

    it('canonical shape strips only contractVersion (deterministic)', () => {
      const again = JSON.parse(JSON.stringify(baselineSnapshot())) as ClientContractSnapshot;
      expect(canonicalShapeSnapshot(baselineSnapshot())).toBe(canonicalShapeSnapshot(again));
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

    it('the retroactive 1.58.5 row does not loosen the snapshot shape guard', () => {
      // The guard checks major.minor, and a patch-version row (1.58.5) is a
      // bug-fix record, never a shape admission: inside the window shape
      // changes ride minor bumps whose rows name the major.minor. Both the
      // live table and a synthetic twin of its row must refuse a simulated
      // 1.58.5 shape change — otherwise the row would silently admit any
      // unauthorised shape drift for the rest of the window.
      const added = bumpedSnapshot((clone) => {
        (clone.types.SessionInfo.fields as Record<string, unknown>).newWireField = { type: 'string' };
      });
      // The wave K shape change is admitted by the R5 row; a patch-version
      // row alone (the retroactive 1.58.5 record) must still admit nothing.
      const withPatchRowOnly = guardSnapshotShape(added, [RETROACTIVE_1_58_5_ROW], INTERNAL_API_CONTRACT_VERSION);
      expect(withPatchRowOnly.ok).toBe(false);
      expect(withPatchRowOnly.problems.join(' ')).toMatch(/no exception row/);
      const withSyntheticTwin = guardSnapshotShape(added, [RETROACTIVE_1_58_5_ROW], '1.58.5');
      expect(withSyntheticTwin.ok).toBe(false);
    });
  });
});
