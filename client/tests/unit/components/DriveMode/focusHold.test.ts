import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  FOCUS_DISCIPLINE_HINT,
  FOCUS_OFF_LABEL,
  FOCUS_ON_LABEL,
  focusRecapAnnouncement,
  focusStatusText,
  useFocusHold,
} from '../../../../src/components/DriveMode/focusHold';

/**
 * P18 package C, deliverable 2 — the vocabulary of the operator's focus
 * control, pinned apart from the surface so a wording change is a deliberate
 * decision. The announcement especially: its one job is to make sure the
 * operator knows something happened while they were away.
 */
describe('focusHold — the operator’s control', () => {
  it('says focus is the operator’s press, and says so out loud', () => {
    expect(FOCUS_ON_LABEL).toMatch(/focus/i);
    expect(FOCUS_OFF_LABEL).toMatch(/leave|exit/i);
    expect(FOCUS_DISCIPLINE_HINT).toMatch(/only you/i);
    expect(FOCUS_DISCIPLINE_HINT).toMatch(/cannot switch|never press/i);
  });

  it('announces what arrived while focused, with the count', () => {
    expect(focusRecapAnnouncement(1)).toMatch(/while you were focused/i);
    expect(focusRecapAnnouncement(1)).toMatch(/one answer/i);
    expect(focusRecapAnnouncement(3)).toMatch(/while you were focused/i);
    expect(focusRecapAnnouncement(3)).toMatch(/3 answers/i);
    // Nothing held means nothing to say.
    expect(focusRecapAnnouncement(0)).toBe('');
  });

  it('the status line keeps the held count visible while focus is on', () => {
    expect(focusStatusText(false, 0)).toMatch(/focus is off/i);
    expect(focusStatusText(true, 0)).toMatch(/focus is on/i);
    expect(focusStatusText(true, 0)).toMatch(/nothing has arrived yet/i);
    expect(focusStatusText(true, 1)).toMatch(/one answer has arrived/i);
    expect(focusStatusText(true, 4)).toMatch(/4 answers have arrived/i);
  });

  it('toggles on the operator’s press and starts off', () => {
    const { result } = renderHook(() => useFocusHold());
    expect(result.current.focused).toBe(false);
    act(() => result.current.toggle());
    expect(result.current.focused).toBe(true);
    act(() => result.current.toggle());
    expect(result.current.focused).toBe(false);
  });
});
