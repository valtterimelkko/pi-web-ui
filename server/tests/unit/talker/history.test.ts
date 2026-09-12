import { describe, it, expect } from 'vitest';

// RED: module does not exist yet.
import { TalkerHistory } from '../../../src/talker/history.js';

function entry(i: number, role: 'user' | 'assistant' = 'user') {
  return { role, content: `turn ${i}`, kind: role === 'user' ? ('operator' as const) : ('talker' as const), turn: i };
}

describe('TalkerHistory', () => {
  it('appends and returns the window in order', () => {
    const h = new TalkerHistory();
    h.append(entry(1));
    h.append(entry(2, 'assistant'));
    expect(h.entries().map(e => e.content)).toEqual(['turn 1', 'turn 2']);
  });

  it('trims on turn boundaries only: drops whole oldest entries down to keepEntries', () => {
    const h = new TalkerHistory({ maxEntries: 6, keepEntries: 4 });
    for (let i = 1; i <= 8; i++) h.append(entry(i, i % 2 === 0 ? 'assistant' : 'user'));
    const dropped = h.maybeTrim(false);
    expect(dropped).toBeGreaterThan(0);
    expect(h.length).toBe(4);
    expect(h.entries()[0].content).toBe('turn 5');
    expect(h.entries()[h.length - 1].content).toBe('turn 8');
  });

  it('never trims below the pending floor while a proposal is alive', () => {
    const h = new TalkerHistory({ maxEntries: 4, keepEntries: 2, maxEntriesWhenPending: 6, keepEntriesWhenPending: 4 });
    for (let i = 1; i <= 6; i++) h.append(entry(i, i % 2 === 0 ? 'assistant' : 'user'));
    h.maybeTrim(true);
    expect(h.length).toBe(6); // at the pending floor: nothing dropped
  });

  it('while pending, growth is still bounded (trims above the pending floor)', () => {
    const h = new TalkerHistory({ maxEntries: 4, keepEntries: 2, maxEntriesWhenPending: 6, keepEntriesWhenPending: 4 });
    for (let i = 1; i <= 20; i++) h.append(entry(i, i % 2 === 0 ? 'assistant' : 'user'));
    h.maybeTrim(true);
    expect(h.length).toBe(4); // keepEntriesWhenPending
    expect(h.entries()[0].content).toBe('turn 17');
  });

  it('trims to the tight floor once nothing is pending', () => {
    const h = new TalkerHistory({ maxEntries: 3, keepEntries: 2, maxEntriesWhenPending: 6, keepEntriesWhenPending: 4 });
    for (let i = 1; i <= 10; i++) h.append(entry(i, i % 2 === 0 ? 'assistant' : 'user'));
    h.maybeTrim(true);
    expect(h.length).toBe(4);
    h.maybeTrim(false);
    expect(h.length).toBe(2);
  });

  it('does nothing when under the max', () => {
    const h = new TalkerHistory({ maxEntries: 10, keepEntries: 4 });
    h.append(entry(1));
    h.append(entry(2, 'assistant'));
    expect(h.maybeTrim(false)).toBe(0);
    expect(h.length).toBe(2);
  });
});
