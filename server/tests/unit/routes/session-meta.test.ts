import { describe, it, expect } from 'vitest';
import {
  piSessionIdFromPath,
  toV2Key,
  parseV2Key,
  migrateV1ToV2,
  deriveLegacyArrays,
  applyLWW,
  isV2,
  type RuntimeResolver,
} from '../../../src/routes/session-meta.js';

const PI_PATH = '/root/.pi/agent/sessions/--root-pi-web-ui--/2026-07-03T16-44-03-621Z_019f28dd-aaa5-7f7e-9e33-bcf084ed86cf.jsonl';
const PI_UUID = '019f28dd-aaa5-7f7e-9e33-bcf084ed86cf';

const resolveNothing: RuntimeResolver = () => null;
const resolveClaude: RuntimeResolver = (id) => (id.startsWith('28bdeecd') ? 'claude' : null);

describe('session-meta — piSessionIdFromPath', () => {
  it('extracts the uuid from a real Pi .jsonl path', () => {
    expect(piSessionIdFromPath(PI_PATH)).toBe(PI_UUID);
  });
  it('returns null for a bare id', () => {
    expect(piSessionIdFromPath('28bdeecd-3a05-452c-809a-4e91066ce241')).toBeNull();
  });
  it('returns null for a non-Pi path', () => {
    expect(piSessionIdFromPath('/test/path.jsonl')).toBeNull();
  });
});

describe('session-meta — toV2Key', () => {
  it('maps a Pi path to pi:<uuid>', () => {
    expect(toV2Key(PI_PATH, resolveNothing)).toEqual({ key: `pi:${PI_UUID}`, runtime: 'pi', id: PI_UUID });
  });
  it('maps a resolvable bare id to <runtime>:<id>', () => {
    expect(toV2Key('28bdeecd-3a05-452c-809a-4e91066ce241', resolveClaude)).toEqual({
      key: 'claude:28bdeecd-3a05-452c-809a-4e91066ce241', runtime: 'claude', id: '28bdeecd-3a05-452c-809a-4e91066ce241',
    });
  });
  it('maps an unresolvable bare id to unknown:<id> (preserved, never sidebar-matched)', () => {
    expect(toV2Key('deadbeef-0000-1111-2222-333344445555', resolveNothing)).toEqual({
      key: 'unknown:deadbeef-0000-1111-2222-333344445555', runtime: 'unknown', id: 'deadbeef-0000-1111-2222-333344445555',
    });
  });
});

describe('session-meta — parseV2Key', () => {
  it('splits runtime:id', () => {
    expect(parseV2Key('claude:abc-123')).toEqual({ runtime: 'claude', id: 'abc-123' });
    expect(parseV2Key(`pi:${PI_UUID}`)).toEqual({ runtime: 'pi', id: PI_UUID });
  });
});

describe('session-meta — migrateV1ToV2', () => {
  it('migrates archived Pi paths to pi:<uuid> records with legacyKey', () => {
    const v2 = migrateV1ToV2({ archivedSessionPaths: [PI_PATH] }, resolveNothing, 1000);
    expect(Object.keys(v2.sessions)).toEqual([`pi:${PI_UUID}`]);
    expect(v2.sessions[`pi:${PI_UUID}`]).toEqual({ archived: true, legacyKey: PI_PATH, updatedAt: 1000 });
  });
  it('migrates display names keyed by bare id to <runtime>:<id>', () => {
    const v2 = migrateV1ToV2({ sessionDisplayNames: { '28bdeecd-3a05-452c-809a-4e91066ce241': 'Refactor' } }, resolveClaude, 1000);
    expect(v2.sessions['claude:28bdeecd-3a05-452c-809a-4e91066ce241']).toEqual({
      displayName: 'Refactor', legacyKey: '28bdeecd-3a05-452c-809a-4e91066ce241', updatedAt: 1000,
    });
  });
  it('merges archived + display name for the same session into one record', () => {
    const v2 = migrateV1ToV2(
      { archivedSessionPaths: [PI_PATH], sessionDisplayNames: { [PI_PATH]: 'My Name' } },
      resolveNothing, 1000,
    );
    expect(v2.sessions[`pi:${PI_UUID}`]).toEqual({
      archived: true, displayName: 'My Name', legacyKey: PI_PATH, updatedAt: 1000,
    });
  });
  it('archived + pinned for the same session both set; archive-auto-unpin is a delta concern', () => {
    const v2 = migrateV1ToV2({ archivedSessionPaths: [PI_PATH], pinnedSessionPaths: [PI_PATH] }, resolveNothing, 1);
    expect(v2.sessions[`pi:${PI_UUID}`].archived).toBe(true);
    expect(v2.sessions[`pi:${PI_UUID}`].pinned).toBe(true);
  });
  it('preserves the same Pi session across two different paths with the same uuid (path-change immunity)', () => {
    const altPath = '/root/.pi/agent/sessions/--root-other--/2026-01-01T00-00-00-000Z_019f28dd-aaa5-7f7e-9e33-bcf084ed86cf.jsonl';
    const v2 = migrateV1ToV2({ archivedSessionPaths: [PI_PATH], sessionDisplayNames: { [altPath]: 'X' } }, resolveNothing, 1);
    // Both map to pi:<uuid> → one record (the metadata travels with the uuid, not the path).
    expect(Object.keys(v2.sessions)).toEqual([`pi:${PI_UUID}`]);
    expect(v2.sessions[`pi:${PI_UUID}`].archived).toBe(true);
    expect(v2.sessions[`pi:${PI_UUID}`].displayName).toBe('X');
  });
  it('is lossless: deriveLegacyArrays(round-trip) reproduces the v1 input exactly', () => {
    const v1 = {
      archivedSessionPaths: [PI_PATH, '28bdeecd-3a05-452c-809a-4e91066ce241'],
      pinnedSessionPaths: ['28bdeecd-3a05-452c-809a-4e91066ce241'],
      sessionDisplayNames: { [PI_PATH]: 'A', '28bdeecd-3a05-452c-809a-4e91066ce241': 'B' },
    };
    const v2 = migrateV1ToV2(v1, resolveClaude, 1);
    const derived = deriveLegacyArrays(v2);
    expect(derived.archivedSessionPaths.sort()).toEqual([...v1.archivedSessionPaths].sort());
    expect(derived.pinnedSessionPaths).toEqual(v1.pinnedSessionPaths);
    expect(derived.sessionDisplayNames).toEqual(v1.sessionDisplayNames);
  });
  it('preserves count for unresolvable bare ids (lossless, no drops)', () => {
    const ids = ['aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002'];
    const v2 = migrateV1ToV2({ archivedSessionPaths: ids }, resolveNothing, 1);
    expect(Object.keys(v2.sessions)).toHaveLength(2);
    const derived = deriveLegacyArrays(v2);
    expect(derived.archivedSessionPaths.sort()).toEqual([...ids].sort());
  });
});

describe('session-meta — isV2', () => {
  it('recognizes v2', () => {
    expect(isV2({ version: 2, sessions: {} })).toBe(true);
  });
  it('rejects v1', () => {
    expect(isV2({ archivedSessionPaths: [] })).toBe(false);
  });
});

describe('session-meta — applyLWW', () => {
  it('applies an incoming record when there is no stored record', () => {
    const { record, changed } = applyLWW(undefined, { archived: true, updatedAt: 10 });
    expect(changed).toBe(true);
    expect(record.archived).toBe(true);
    expect(record.updatedAt).toBe(10);
  });
  it('newer updatedAt wins', () => {
    const { record, changed } = applyLWW({ archived: true, updatedAt: 10 }, { archived: false, updatedAt: 20 } as never);
    // archived:false is not stored (absent === not archived), but LWW accepts the newer write.
    expect(changed).toBe(true);
    expect(record.updatedAt).toBe(20);
  });
  it('older incoming is rejected (stale device does not resurrect)', () => {
    const stored = { archived: true, updatedAt: 100 } as never;
    const incoming = { archived: false as never, updatedAt: 50 } as never;
    const { record, changed } = applyLWW(stored, incoming);
    expect(changed).toBe(false);
    expect(record.archived).toBe(true); // unchanged
    expect(record.updatedAt).toBe(100);
  });
  it('equal updatedAt is accepted (>=, last writer within same tick wins)', () => {
    const { changed } = applyLWW({ archived: true, updatedAt: 10 }, { archived: false as never, updatedAt: 10 } as never);
    expect(changed).toBe(true);
  });
});
