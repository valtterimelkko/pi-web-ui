import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_READING_LEVEL,
  DIGEST_KINDS,
  IN_SHORT_PREFIX,
  READING_LEVELS,
  READING_LEVEL_LABEL,
  READING_LEVEL_STORAGE_KEY,
  SHORT_TURN_VERBATIM_CHARS,
  digestSpokenText,
  planSpeechForText,
  remainderAfterChunks,
  resetReadingLevelStore,
  useReadingLevelStore,
} from '../../../../src/components/DriveMode/readingLevel';
import { chunkIntoSentences } from '../../../../src/lib/speechArbiter';

/**
 * P17 package A — the reading levels, as pure decisions.
 *
 * The verbosity the operator complained about is NOT the talker being chatty:
 * the worker's final answer is read VERBATIM by the auto-speak path, with no
 * talker involvement at all. A reading level is putting the talker into the
 * reading path where there currently is none.
 *
 * These tests pin the decision table (which text is spoken how) and the
 * persisted default. The operator-visible behaviour is pinned through the real
 * surface in DriveModeDictate.reading-levels.test.tsx.
 */

const LONG_TEXT = 'a'.repeat(SHORT_TURN_VERBATIM_CHARS);
const SHORT_TEXT = 'The build is green.';

describe('reading levels — the decision table', () => {
  it('is exactly the three agreed levels, with Summary as the persisted default', () => {
    expect(READING_LEVELS).toEqual(['verbatim', 'summary', 'headlines']);
    expect(DEFAULT_READING_LEVEL).toBe('summary');
    expect(READING_LEVEL_LABEL.verbatim).toBe('Verbatim');
    expect(READING_LEVEL_LABEL.summary).toBe('Summary');
    expect(READING_LEVEL_LABEL.headlines).toBe('Headlines');
  });

  it('names the short-turn threshold, because the number is a decision, not a magic value', () => {
    // ~30 seconds of speech at a comfortable TTS rate. Under it, summarising
    // two sentences is pure overhead AND risks distorting them.
    expect(SHORT_TURN_VERBATIM_CHARS).toBe(400);
  });

  it('Verbatim reads the worker word for word, whatever the length', () => {
    expect(planSpeechForText('verbatim', SHORT_TEXT)).toEqual({ kind: 'read', text: SHORT_TEXT });
    expect(planSpeechForText('verbatim', LONG_TEXT)).toEqual({ kind: 'read', text: LONG_TEXT });
  });

  it('Summary reads a SHORT turn verbatim (the threshold is the rule)', () => {
    expect(planSpeechForText('summary', SHORT_TEXT)).toEqual({ kind: 'read', text: SHORT_TEXT });
  });

  it('Summary digests a LONG turn instead of reading it raw', () => {
    expect(planSpeechForText('summary', LONG_TEXT)).toEqual({
      kind: 'digest',
      digestKind: 'summary',
    });
  });

  it('Headlines is EXEMPT from the threshold: always the one line, however short the turn', () => {
    expect(planSpeechForText('headlines', SHORT_TEXT)).toEqual({
      kind: 'digest',
      digestKind: 'headlines',
    });
    expect(planSpeechForText('headlines', LONG_TEXT)).toEqual({
      kind: 'digest',
      digestKind: 'headlines',
    });
  });

  it('digest kinds are only the two the talker can produce', () => {
    expect(DIGEST_KINDS).toEqual(['summary', 'headlines']);
  });

  it('a Summary digest is announced with the same marker wherever it speaks', () => {
    expect(IN_SHORT_PREFIX).toBe('In short: ');
    expect(digestSpokenText('summary', 'the build is green')).toBe('In short: the build is green');
  });

  it('a Headlines digest is the line itself — its shape is the marker, not a prefix', () => {
    expect(digestSpokenText('headlines', 'Done: the build. Needs you: nothing.')).toBe(
      'Done: the build. Needs you: nothing.'
    );
  });

  it('never speaks an empty digest as if it were the answer', () => {
    expect(digestSpokenText('summary', '   ')).toBeNull();
    expect(digestSpokenText('headlines', '')).toBeNull();
  });
});

describe('reading levels — the unplayed remainder (the mid-speech flip)', () => {
  it('returns exactly the chunks the operator has NOT heard yet', () => {
    const chunks = chunkIntoSentences('One. Two. Three.');
    expect(chunks).toHaveLength(3);
    expect(remainderAfterChunks(chunks, 0)).toBe('One. Two. Three.');
    expect(remainderAfterChunks(chunks, 1)).toBe('Two. Three.');
    expect(remainderAfterChunks(chunks, 2)).toBe('Three.');
    expect(remainderAfterChunks(chunks, 3)).toBe('');
  });

  it('never invents a remainder past the end of the text', () => {
    expect(remainderAfterChunks(chunkIntoSentences('Only one.'), 9)).toBe('');
    expect(remainderAfterChunks([], 0)).toBe('');
  });
});

describe('reading levels — the persisted default', () => {
  beforeEach(() => {
    localStorage.clear();
    resetReadingLevelStore();
  });

  it('starts at Summary and keeps the operator’s choice across a reload', () => {
    expect(useReadingLevelStore.getState().level).toBe(DEFAULT_READING_LEVEL);

    useReadingLevelStore.getState().setLevel('headlines');
    expect(useReadingLevelStore.getState().level).toBe('headlines');

    const raw = localStorage.getItem(READING_LEVEL_STORAGE_KEY);
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw as string).state.level).toBe('headlines');
  });

  it('falls back to the default when the stored value is corrupt, rather than breaking the surface', () => {
    localStorage.setItem(READING_LEVEL_STORAGE_KEY, '{not json at all');
    resetReadingLevelStore();
    expect(useReadingLevelStore.getState().level).toBe(DEFAULT_READING_LEVEL);
    // …and the surface still works afterwards.
    useReadingLevelStore.getState().setLevel('headlines');
    expect(useReadingLevelStore.getState().level).toBe('headlines');
  });

  it('ignores a stored value that is not one of the three levels', () => {
    localStorage.setItem(
      READING_LEVEL_STORAGE_KEY,
      JSON.stringify({ state: { level: 'loud' }, version: 0 })
    );
    resetReadingLevelStore();
    expect(useReadingLevelStore.getState().level).toBe(DEFAULT_READING_LEVEL);
  });
});
