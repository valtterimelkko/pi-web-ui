import { describe, it, expect, beforeEach } from 'vitest';
import {
  useReadingLevelStore,
  DEFAULT_READING_LEVEL,
} from '../../../../src/components/DriveMode/readingLevel';

/**
 * Per-lane reading level (multi-lane work, 2026-09-15).
 *
 * Each lane carries its own reading level once a tab holds several workers;
 * the single persisted default stays exactly what it was for single-lane
 * use. A lane with no explicit choice reads at the shared default.
 */

const A = 'session-a';
const B = 'session-b';

beforeEach(() => {
  useReadingLevelStore.setState({ level: DEFAULT_READING_LEVEL, levels: {} });
});

describe('reading level — per-lane overrides', () => {
  it('a lane with no choice reads at the shared default', () => {
    const level = useReadingLevelStore.getState().levelFor(A);
    expect(level).toBe(DEFAULT_READING_LEVEL);
  });

  it('setLevelFor overrides one lane without touching the default or other lanes', () => {
    useReadingLevelStore.getState().setLevelFor(A, 'verbatim');
    expect(useReadingLevelStore.getState().levelFor(A)).toBe('verbatim');
    expect(useReadingLevelStore.getState().levelFor(B)).toBe(DEFAULT_READING_LEVEL);
    // The persisted single-lane default is unchanged.
    expect(useReadingLevelStore.getState().level).toBe(DEFAULT_READING_LEVEL);
  });

  it('setLevel (the single-lane control) is untouched by lane overrides', () => {
    useReadingLevelStore.getState().setLevelFor(A, 'verbatim');
    useReadingLevelStore.getState().setLevel('headlines');
    expect(useReadingLevelStore.getState().level).toBe('headlines');
    expect(useReadingLevelStore.getState().levelFor(A)).toBe('verbatim');
  });

  it('junk levels are refused, never stored', () => {
    // @ts-expect-error — deliberately junk input
    useReadingLevelStore.getState().setLevelFor(A, 'telepathic');
    expect(useReadingLevelStore.getState().levelFor(A)).toBe(DEFAULT_READING_LEVEL);
  });
});
