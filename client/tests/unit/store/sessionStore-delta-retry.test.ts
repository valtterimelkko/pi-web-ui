import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ApiError } from '../../../src/lib/api';
import { archiveSessionPref } from '../../../src/lib/api';
import { useSessionStore } from '../../../src/store/sessionStore';

/**
 * 2026-08-21 rate-limit incident (#4): syncPreferenceDelta used to retry ANY
 * thrown error — a 429 became four requests inside the window that was already
 * refusing them, amplifying the pressure instead of backing off.
 *
 * Contract after the fix:
 * - non-retryable 4xx (not 408/429): ONE request, immediate revert
 * - 429: retried on the ladder but honouring Retry-After when present
 * - network errors: unchanged ladder behaviour
 */
vi.mock('../../../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/api')>();
  return {
    ...actual,
    archiveSessionPref: vi.fn(),
  };
});

const mockedArchive = vi.mocked(archiveSessionPref);

describe('sessionStore preference delta retry policy', () => {
  const SESSION = { id: 's1', path: '/p/s1', sdkType: 'pi' } as never;

  function seed() {
    const s = useSessionStore.getState();
    s.setSessions([SESSION]);
    useSessionStore.setState({ sessionMeta: {}, archivedSessionPaths: [], pinnedSessionPaths: [] });
    mockedArchive.mockReset();
  }

  beforeEach(() => { seed(); });
  afterEach(() => { vi.useRealTimers(); });

  it('does NOT retry a non-retryable 4xx and reverts immediately', async () => {
    mockedArchive.mockRejectedValue(new ApiError(400, 'bad request'));
    const s = useSessionStore.getState();
    s.archiveSession('/p/s1');
    await new Promise((r) => setTimeout(r, 0));
    expect(mockedArchive).toHaveBeenCalledTimes(1); // no retry storm
    const state = useSessionStore.getState();
    expect(state.archivedSessionPaths).not.toContain('/p/s1'); // reverted
  });

  it('retries a 429 honouring Retry-After over the fixed ladder', async () => {
    vi.useFakeTimers();
    mockedArchive.mockRejectedValueOnce(new ApiError(429, 'slow down', 5000));
    mockedArchive.mockRejectedValueOnce(new ApiError(429, 'slow down', 100));
    mockedArchive.mockResolvedValue({ ok: true });
    const s = useSessionStore.getState();
    s.archiveSession('/p/s1');

    await vi.advanceTimersByTimeAsync(0);
    expect(mockedArchive).toHaveBeenCalledTimes(1);
    // First Retry-After is 5s — even though the old ladder step is 500ms, the
    // client must wait out the server's hint before the second attempt.
    await vi.advanceTimersByTimeAsync(4999);
    expect(mockedArchive).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mockedArchive).toHaveBeenCalledTimes(2);
    // Second hint is small; ladder floor (1500ms) applies as the larger wait.
    await vi.advanceTimersByTimeAsync(1499);
    expect(mockedArchive).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(mockedArchive).toHaveBeenCalledTimes(3);
    const state = useSessionStore.getState();
    expect(state.archivedSessionPaths).toContain('/p/s1'); // succeeded, kept
  });

  it('still retries transient network errors on the existing ladder', async () => {
    vi.useFakeTimers();
    mockedArchive.mockRejectedValueOnce(new TypeError('fetch failed'));
    mockedArchive.mockResolvedValue({ ok: true });
    const s = useSessionStore.getState();
    s.archiveSession('/p/s1');

    await vi.advanceTimersByTimeAsync(0);
    expect(mockedArchive).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500); // first ladder step
    expect(mockedArchive).toHaveBeenCalledTimes(2);
    expect(useSessionStore.getState().archivedSessionPaths).toContain('/p/s1');
  });
});
