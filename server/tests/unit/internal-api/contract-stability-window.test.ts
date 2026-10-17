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
 * The live table's single row (J4, 2026-10-02): a RETROACTIVE record of the
 * owner-accepted 1.58.5 working-set change. The changelog had already
 * documented it as a wire-identical bug fix (the snapshot fingerprints
 * identically to 1.58.0 apart from the version), so this row records the
 * semantic change — it grants nothing. The guard keeps the shape check
 * strict: a patch-version row never satisfies the snapshot-shape exception
 * lookup, because shape changes ride minor bumps whose rows name the
 * major.minor (pinned below).
 */
const RETROACTIVE_1_58_5_ROW: StabilityExceptionRow = {
  date: '2026-10-02',
  decision: 'post-H-b review (owner accepted)',
  what: '1.58.5: /capacity memory.currentBytes and admission memory checks report working set (current − inactive_file), not total',
  version: '1.58.5',
};

/**
 * The live table's second row (L1, R5 follow-up wave 2026-10-03): the owner
 * accepted R5's recommendations, the C6 window closed at R5, and the follow-up
 * wave's additive minor bump (1.59.0 — /capacity `quarantinedOldestAgeMs` and
 * the quarantine reconciliation guard) is authorised under it. This is the
 * row that admits the lane's minor bump and its re-based snapshot baseline.
 */
const L1_1_59_0_ROW: StabilityExceptionRow = {
  date: '2026-10-03',
  decision: 'R5 (owner accepted every recommendation; the C6 window closed at R5)',
  what: '1.59.0 (L1): /capacity gains `quarantinedOldestAgeMs` — age of the oldest quarantined admission lease; quarantined entries gained a reconciliation guard (release on confirmed session quiescence). Additive only.',
  version: '1.59.0',
};

/**
 * The live table's third row (wave K, R5 2026-10-03): the owner's R5 decision
 * "wave K GO, slimmed: continue once after a restart interruption, plus parent
 * visibility". Its additive minor bump (1.60.0) re-based the snapshot baseline
 * again (see BASELINE_SHAPE_SHA256).
 */
const K_1_60_0_ROW: StabilityExceptionRow = {
  date: '2026-10-03',
  decision: 'R5 (wave K GO, slimmed: continue once after a restart interruption, plus parent visibility)',
  what: '1.60.0 (wave K): `SessionGoalProjection` gains the optional `interruption` object and top-level `autoContinued`; a non-continued stop projects as `status: "paused"`, `pausedReason: "interrupted"`; a verified auto-continue emits `goal_state` (never `goal_end`). Additive only.',
  version: '1.60.0',
};

/**
 * The live table's fourth row (W0-c, parent-machinery programme plan): Claude
 * profile concurrency is refused before the run, advertised on /capacity and
 * /models. Its additive minor bump (1.61.0) re-based the snapshot baseline.
 */
const W0C_1_61_0_ROW: StabilityExceptionRow = {
  date: '2026-10-13',
  decision: 'PARENT-ORCHESTRATION-MACHINERY-PLAN W0-c (finding F8; owner plan of record)',
  what: '1.61.0 (W0-c): new typed refusal `PROFILE_CAPACITY_EXHAUSTED` (429, before any run receipt); `GET /capacity` gains `claudeProfiles[{profileId,maxConcurrent,active}]`; `/models` Claude profile entries gain `maxConcurrent`; the profile `maxConcurrent` default rises from 2 to 8. Additive only.',
  version: '1.61.0',
};

/**
 * The live table's fifth row (W2, parent-machinery programme plan): stable
 * goalId, stalled goal_state, no NEVER_STARTED goal_end, quarantined_debt
 * refusals. Its additive minor bump (1.62.0) re-based the snapshot baseline.
 */
const W2_1_62_0_ROW: StabilityExceptionRow = {
  date: '2026-10-13',
  decision: 'PARENT-ORCHESTRATION-MACHINERY-PLAN W2 (owner plan of record)',
  what: '1.62.0 (W2): `SessionGoalProjection` gains optional top-level `goalId` (stamped on every `goal_state`/`goal_end` and on `GET`/`POST /goal`), and `stalled` / `stalledForMs` on a stall `goal_state`; a NEVER_STARTED receipt no longer fires `goal_end`; an admission refusal tipped over by quarantined leases carries body `reason: "quarantined_debt"` (+ `admissionReason`, `quarantinedRuns`, `quarantinedOldestAgeMs`) with the same status/code. Additive only.',
  version: '1.62.0',
};

/**
 * The live table's sixth row (step 1i.2 B, command-centre programme PLAN
 * step 1i): the owner-approved additive minor bump letting a native parent be
 * named (parentKind "native" / parentSource "declared"). Its additive minor
 * bump (1.63.0) re-based the snapshot baseline.
 */
const STEP1I2B_1_63_0_ROW: StabilityExceptionRow = {
  date: '2026-10-16',
  decision: 'COMMAND-CENTRE PLAN step 1i.2 B (owner plan of record; SESSION-RELATIONSHIPS §4.1 B)',
  what: '1.63.0 (step 1i.2 B): `POST /sessions`, `POST /sessions/batch` and adopt accept an explicitly native parent (body `parentSessionId` + `parentKind: "native"`, opaque bare id); persisted and surfaced as the new `parentSource: "declared"`; `GET /sessions?parent=<native id>` returns the declared children instead of 404ing; `features.nativeParentLinkage` advertises it. Additive only.',
  version: '1.63.0',
};

/**
 * The live table's seventh row (step 1i.3, command-centre programme PLAN
 * step 1i, census Q1 recommendation): the owner-approved additive minor bump
 * surfacing the runtime-native session id. Its additive minor bump (1.64.0)
 * re-based the snapshot baseline.
 */
const STEP1I3_1_64_0_ROW: StabilityExceptionRow = {
  date: '2026-10-16',
  decision: 'COMMAND-CENTRE PLAN step 1i.3 (owner plan of record; census Q1 recommendation, BUGS.md rows 2/18)',
  what: '1.64.0 (step 1i.3): `GET /sessions` items and `GET /sessions/:id` gain additive `nativeSessionId` — the id the runtime\'s own process/transcript runs under, recorded the moment the runtime reports it (Claude: CLI session id mid-turn; Antigravity: conversation id at init); `features.nativeSessionIds` advertises it; the Claude detail\'s `nativeSessionId` is corrected to the native id (it previously echoed the Pi Web UI registry session id, duplicating `sessionId`). Additive apart from that correction.',
  version: '1.64.0',
};

/**
 * The live table's eighth row (step 1k, command-centre programme PLAN
 * step 1k, design SESSION-LIFECYCLE §6.2): the owner-approved additive minor
 * bump adding the session class and the Internal API archive routes.
 */
const STEP1K_1_65_0_ROW: StabilityExceptionRow = {
  date: '2026-10-17',
  decision: 'COMMAND-CENTRE PLAN step 1k (owner plan of record; design SESSION-LIFECYCLE §6.2)',
  what: '1.65.0 (step 1k): additive `sessionClass` (only "validation" storable, recorded once at creation, echoed on create/batch/adopt-native responses, `GET /sessions`, `GET /sessions/:id`, `GET /sessions/native`; "child" stays reader-derived from `parentSessionId`) plus `POST /sessions/:id/archive` and `/unarchive` over the browser route\'s prefs-lock + LWW store (pinned → 409 `SESSION_PINNED`, live turn → 409 `SESSION_BUSY`, idempotent); `features.sessionClass` + `features.sessionArchive` advertise them. Additive only.',
  version: '1.65.0',
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

    it('parses the live exception table: the retroactive 1.58.5 row, the L1 1.59.0 row, the wave K 1.60.0 row, the W0-c 1.61.0 row, the W2 1.62.0 row, the step 1i.2 B 1.63.0 row, the step 1i.3 1.64.0 row and the step 1k 1.65.0 row', () => {
      expect(parsed?.exceptions).toEqual([RETROACTIVE_1_58_5_ROW, L1_1_59_0_ROW, K_1_60_0_ROW, W0C_1_61_0_ROW, W2_1_62_0_ROW, STEP1I2B_1_63_0_ROW, STEP1I3_1_64_0_ROW, STEP1K_1_65_0_ROW]);
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
    it('accepts the live contract version now that the 1.65.0 exception row names it', () => {
      expect(parsed).not.toBeNull();
      const verdict = guardContractVersion(INTERNAL_API_CONTRACT_VERSION, parsed!.exceptions);
      expect(verdict.problems).toEqual([]);
      expect(verdict.ok).toBe(true);
      expect(majorMinor(INTERNAL_API_CONTRACT_VERSION)).toBe('1.65');
    });

    it('refuses the live contract version when the exception row is absent (the window rule still bites)', () => {
      expect(guardContractVersion(INTERNAL_API_CONTRACT_VERSION, []).ok).toBe(false);
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
      const withLiveRows = guardSnapshotShape(added, parsed!.exceptions, INTERNAL_API_CONTRACT_VERSION);
      expect(withLiveRows.ok).toBe(false);
      expect(withLiveRows.problems.join(' ')).toMatch(/no exception row/);
      const withSyntheticTwin = guardSnapshotShape(added, [RETROACTIVE_1_58_5_ROW], '1.58.5');
      expect(withSyntheticTwin.ok).toBe(false);
    });
  });
});
