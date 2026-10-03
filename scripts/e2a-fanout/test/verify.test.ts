/**
 * 08-correction items 1–3 (Luna review findings 3, 4, 5), all RED before
 * implementation:
 *
 * 1. Cleanup verification fails closed: exit 0 required, the status JSON is
 *    parsed, `children` must be empty AND every created session id must
 *    answer 404. Unparsable output, a surviving child (busy or not), or a
 *    non-zero exit is a cleanup failure.
 * 2. Any exception after the first create runs cleanupAll (and the
 *    verification) BEFORE the lock is released.
 * 3. Route checks run for every child BEFORE any prompt dispatch, fail
 *    closed: one malformed status or one fallbackApplied child means zero
 *    prompts.
 */
import { describe, expect, it } from 'vitest';
import { verifyCleanup, checkRoutes, withFailClosedCleanup } from '../lib/verify.ts';

const OWNER_STATUS_EMPTY = JSON.stringify({ owner: 'orch-e2-0798cc10-E2a-4-fan', children: [] });

describe('item 1 — verifyCleanup fails closed', () => {
  const fetch404 = async (): Promise<number> => 404;

  it('passes on exit 0, an empty children list, and 404 for every created id', async () => {
    const out = await verifyCleanup({
      statusExitCode: 0,
      statusStdout: OWNER_STATUS_EMPTY,
      createdIds: ['id-1', 'id-2'],
      fetchSessionStatus: fetch404,
    });
    expect(out.ok).toBe(true);
    expect(out.failures).toEqual([]);
  });

  it('fails on a non-zero status exit', async () => {
    const out = await verifyCleanup({ statusExitCode: 1, statusStdout: OWNER_STATUS_EMPTY, createdIds: [], fetchSessionStatus: fetch404 });
    expect(out.ok).toBe(false);
    expect(out.failures.join(' ')).toMatch(/exit/i);
  });

  it('fails on unparsable status output', async () => {
    const out = await verifyCleanup({ statusExitCode: 0, statusStdout: 'pi-orch: transport lost', createdIds: [], fetchSessionStatus: fetch404 });
    expect(out.ok).toBe(false);
    expect(out.failures.join(' ')).toMatch(/pars/i);
  });

  it('fails when a child survives with busy:false', async () => {
    const out = await verifyCleanup({
      statusExitCode: 0,
      statusStdout: JSON.stringify({ owner: 'x', children: [{ sessionId: 'id-1', busy: false }] }),
      createdIds: ['id-1'],
      fetchSessionStatus: fetch404,
    });
    expect(out.ok).toBe(false);
    expect(out.failures.join(' ')).toMatch(/id-1/);
  });

  it('fails when a created session still answers non-404', async () => {
    const out = await verifyCleanup({
      statusExitCode: 0,
      statusStdout: OWNER_STATUS_EMPTY,
      createdIds: ['id-1', 'id-2'],
      fetchSessionStatus: async (id) => (id === 'id-2' ? 200 : 404),
    });
    expect(out.ok).toBe(false);
    expect(out.failures.join(' ')).toMatch(/id-2/);
    expect(out.failures.join(' ')).not.toMatch(/id-1[^,]/);
  });
});

describe('item 2 — exceptions after the first create run cleanup before release', () => {
  it('cleans up both created ids and verifies BEFORE releasing when work throws', async () => {
    const order: string[] = [];
    const out = await withFailClosedCleanup({
      createChildren: async () => [{ sessionId: 'id-a' }, { sessionId: 'id-b' }],
      work: async () => {
        order.push('work');
        throw new Error('evidence writer exploded');
      },
      cleanupAll: async (ids) => {
        order.push(`cleanup:${ids.join(',')}`);
      },
      verifyCleanupAfter: async () => {
        order.push('verify');
        return { ok: true, failures: [] };
      },
      releaseLock: () => {
        order.push('release');
      },
    });
    expect(out.error).toBeInstanceOf(Error);
    expect(out.cleanupIds).toEqual(['id-a', 'id-b']);
    expect(out.cleanupRan).toBe(true);
    expect(out.verification?.ok).toBe(true);
    expect(order.indexOf('cleanup:id-a,id-b')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('release')).toBe(order.length - 1);
    expect(order.indexOf('release')).toBeGreaterThan(order.indexOf('verify'));
  });

  it('does not clean up or release-verify when nothing was created', async () => {
    const events: string[] = [];
    const out = await withFailClosedCleanup({
      createChildren: async () => {
        events.push('create');
        throw new Error('pre-check failed');
      },
      work: async () => undefined,
      cleanupAll: async () => {
        events.push('cleanup');
      },
      verifyCleanupAfter: async () => ({ ok: true, failures: [] }),
      releaseLock: () => {
        events.push('release');
      },
    });
    expect(out.cleanupRan).toBe(false);
    expect(events).toEqual(['create', 'release']);
  });

  it('runs cleanup exactly once on success too', async () => {
    const cleanups: number[] = [];
    const out = await withFailClosedCleanup({
      createChildren: async () => [{ sessionId: 'id-a' }],
      work: async () => 'done',
      cleanupAll: async (ids) => {
        cleanups.push(ids.length);
      },
      verifyCleanupAfter: async () => ({ ok: true, failures: [] }),
      releaseLock: () => undefined,
    });
    expect(out.error).toBeUndefined();
    expect(out.result).toBe('done');
    expect(cleanups).toEqual([1]);
  });
});

describe('item 3 — route checks fail closed before any dispatch', () => {
  const okStatus = (child: string): { child: string; code: number; stdout: string } => ({
    child,
    code: 0,
    stdout: JSON.stringify({ sessionId: child, busy: false, fallbackApplied: false }),
  });

  it('passes when every child status is healthy', () => {
    const out = checkRoutes([okStatus('c0'), okStatus('c1')]);
    expect(out.ok).toBe(true);
    expect(out.violations).toEqual([]);
    expect(out.dispatchableChildren).toEqual(['c0', 'c1']);
  });

  it('fails closed when ONE child has fallbackApplied true — zero dispatchable children', () => {
    const statuses = [okStatus('c0'), { child: 'c1', code: 0, stdout: JSON.stringify({ sessionId: 'c1', fallbackApplied: true }) }];
    const out = checkRoutes(statuses);
    expect(out.ok).toBe(false);
    expect(out.violations.join(' ')).toMatch(/fallback.*c1|c1.*fallback/i);
    expect(out.dispatchableChildren).toEqual([]);
  });

  it('fails closed on a malformed status — zero dispatchable children', () => {
    const out = checkRoutes([okStatus('c0'), { child: 'c1', code: 0, stdout: 'pi-orch: transport lost' }]);
    expect(out.ok).toBe(false);
    expect(out.violations.join(' ')).toMatch(/c1/);
    expect(out.dispatchableChildren).toEqual([]);
  });

  it('fails closed on a failed status command', () => {
    const out = checkRoutes([okStatus('c0'), { child: 'c1', code: 12, stdout: '' }]);
    expect(out.ok).toBe(false);
    expect(out.dispatchableChildren).toEqual([]);
  });
});
