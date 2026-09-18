import { describe, expect, it } from 'vitest';
import {
  VOICE_BRIEF_LIMITS,
  planWorkerBrief,
  searchWorkerHistory,
} from '../../../src/voice/worker-brief.js';

/**
 * The brief policy, measured before it was written (see
 * docs/plans/VOICE-TALKER-FULL-SESSION-BRIEF.md): a full session is free on the
 * live provider up to ~82k tokens and a DEAD LANE beyond ~100k. So: the whole
 * session by default, a measured ceiling, deltas afterwards, and a bounded view
 * plus retrieval above it.
 */
const entry = (role: 'user' | 'assistant', text: string) => ({ role, text });

function longSession(approximatelyChars: number): Array<{ role: 'user' | 'assistant'; text: string }> {
  const rows: Array<{ role: 'user' | 'assistant'; text: string }> = [];
  let chars = 0;
  let i = 0;
  while (chars < approximatelyChars) {
    const text = `message ${i} `.padEnd(400, 'x');
    rows.push(entry(i % 2 === 0 ? 'user' : 'assistant', text));
    chars += text.length;
    i += 1;
  }
  return rows;
}

describe('worker brief policy', () => {
  it('sends the WHOLE session when it fits under the measured ceiling', () => {
    const entries = longSession(120_000); // ~30k tokens: measured comfortably safe
    const plan = planWorkerBrief({ entries, total: entries.length, acknowledgedEntries: 0 });

    expect(plan.mode).toBe('full');
    expect(plan.lines.join('\n')).toContain('WORKER SESSION HISTORY');
    expect(plan.lines.join('\n')).toContain('message 1 ');
    expect(plan.lines.join('\n')).toContain('message 2 '); // nothing arbitrarily dropped
    expect(plan.acknowledgedEntries).toBe(entries.length);
  });

  it('falls back to a bounded recent view above the ceiling, and says so', () => {
    const entries = longSession(400_000); // ~100k tokens: measured to STALL the lane
    const plan = planWorkerBrief({ entries, total: entries.length, acknowledgedEntries: 0 });
    const text = plan.lines.join('\n');

    expect(plan.mode).toBe('recent');
    expect(text).toContain('WORKER SESSION HISTORY');
    // The disclosure is the point: the model must know it is not seeing everything.
    expect(text).toMatch(/earlier are not included/);
    expect(text.length).toBeLessThanOrEqual(VOICE_BRIEF_LIMITS.recentChars + 2_000);
    // It still saw the most recent work, so it is not blind.
    expect(text).toContain(`message ${entries.length - 1} `);
    expect(plan.acknowledgedEntries).toBe(entries.length);
  });

  it('sends only the DELTA once the model already holds the earlier messages', () => {
    const entries = longSession(120_000);
    const first = planWorkerBrief({ entries, total: entries.length, acknowledgedEntries: 0 });
    expect(first.mode).toBe('full');

    const withNewWork = [...entries, entry('assistant', 'and the last thing was a purple triangle')];
    const delta = planWorkerBrief({ entries: withNewWork, total: withNewWork.length, acknowledgedEntries: entries.length });
    const text = delta.lines.join('\n');

    expect(delta.mode).toBe('delta');
    expect(text).toContain('purple triangle');
    // A delta is a delta: the whole history is NOT re-sent (accumulation is what
    // walks a live session into the stall measured above).
    expect(text).not.toContain('message 1 xxxx');
    expect(text.length).toBeLessThan(500);
    expect(delta.acknowledgedEntries).toBe(withNewWork.length);
  });

  it('injects nothing when there is no new work', () => {
    const entries = longSession(20_000);
    const plan = planWorkerBrief({ entries, total: entries.length, acknowledgedEntries: entries.length });
    expect(plan.mode).toBe('none');
    expect(plan.lines).toEqual([]);
  });

  it('injects nothing for a session with no conversation at all', () => {
    const plan = planWorkerBrief({ entries: [], total: 0, acknowledgedEntries: 0 });
    expect(plan.mode).toBe('none');
    expect(plan.lines).toEqual([]);
  });

  it('re-states the bounded view instead of a huge delta after a long gap', () => {
    const entries = longSession(20_000);
    const burst = [...entries, ...longSession(400_000)];
    const plan = planWorkerBrief({ entries: burst, total: burst.length, acknowledgedEntries: entries.length });
    expect(plan.mode).toBe('recent');
    expect(plan.lines.join('\n')).toMatch(/earlier are not included/);
  });
});

describe('worker history retrieval (the tool the talker can call)', () => {
  const entries = [
    entry('user', 'Please find out why the retry handler dropped the session token.'),
    entry('assistant', 'I traced it to the auth retry wrapper clearing the header early.'),
    entry('user', 'Unrelated: rename the parking lot glyph.'),
    entry('assistant', 'Renamed; the glyph is a purple triangle now.'),
  ];

  it('finds the earlier turn a bounded window would have hidden', () => {
    const result = searchWorkerHistory(entries, 'retry handler session token', { limit: 2 });
    expect(result.matches).toBeGreaterThan(0);
    expect(result.text).toContain('auth retry wrapper');
    expect(result.text).toMatch(/searched \d+ messages/);
  });

  it('says plainly when the session does not contain the thing asked about', () => {
    const result = searchWorkerHistory(entries, 'kubernetes ingress certificate rotation', {});
    expect(result.matches).toBe(0);
    expect(result.text).toMatch(/No message in this session matches/i);
    // Never an invented answer, and never silence.
    expect(result.searched).toBe(entries.length);
  });

  it('reads the START of the session when asked for it with an empty query', () => {
    const result = searchWorkerHistory(entries, '   ', { limit: 2 });
    expect(result.text).toContain('retry handler dropped the session token');
    expect(result.text).toMatch(/earliest/i);
  });

  it('stays bounded for a pathological query against a huge session', () => {
    const huge = longSession(400_000);
    const result = searchWorkerHistory(huge, 'message', { limit: 50 });
    expect(result.text.length).toBeLessThan(60_000);
  });
});
