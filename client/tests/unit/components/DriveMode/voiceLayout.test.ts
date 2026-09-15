/**
 * Voice Mode layout selection — the operator's two modes.
 *
 * Operator, verbatim (2026-09-15):
 *   "Two modes for voice mode? For a computer screen, one that also shows the
 *    session itself on one half of the screen - the current version could stay
 *    as 'mobile mode' as mobile screen can't really handle more information."
 *
 * The rules this pins:
 *   - the mode is an explicit, persisted operator preference (set once);
 *   - 'mobile' is the existing surface, unchanged at every width;
 *   - 'desktop' splits only when the window can actually hold two readable
 *     halves — a wide preference on a narrow window degrades to mobile rather
 *     than squashing both;
 *   - nothing about the choice can break the surface (unreadable/corrupt
 *     storage falls back to mobile).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  DEFAULT_VOICE_LAYOUT_MODE,
  SPLIT_MIN_WIDTH,
  VOICE_LAYOUT_STORAGE_KEY,
  isVoiceLayoutMode,
  nextVoiceLayoutMode,
  resolveVoiceLayout,
  selectViewportWidth,
  useVoiceLayoutStore,
  resetVoiceLayoutStore,
} from '../../../../src/components/DriveMode/voiceLayout';

describe('resolveVoiceLayout', () => {
  it('splits a desktop preference on a window with room for two halves', () => {
    expect(resolveVoiceLayout('desktop', 1440)).toBe('split');
    expect(resolveVoiceLayout('desktop', SPLIT_MIN_WIDTH)).toBe('split');
  });

  it('degrades a desktop preference to the mobile layout when the window is narrow', () => {
    expect(resolveVoiceLayout('desktop', SPLIT_MIN_WIDTH - 1)).toBe('mobile');
    expect(resolveVoiceLayout('desktop', 390)).toBe('mobile');
  });

  it('keeps the mobile preference on the mobile layout at every width', () => {
    expect(resolveVoiceLayout('mobile', 390)).toBe('mobile');
    expect(resolveVoiceLayout('mobile', 1024)).toBe('mobile');
    expect(resolveVoiceLayout('mobile', 2560)).toBe('mobile');
  });

  it('never splits without a usable viewport width', () => {
    // jsdom and prerender both report 0; a split decision must not be taken on
    // an unknown width.
    expect(resolveVoiceLayout('desktop', 0)).toBe('mobile');
    expect(resolveVoiceLayout('desktop', Number.NaN)).toBe('mobile');
  });
});

describe('selectViewportWidth', () => {
  it('reads the window width when it is usable', () => {
    expect(selectViewportWidth({ innerWidth: 1200 })).toBe(1200);
  });

  it('reports 0 for a missing or unusable width', () => {
    expect(selectViewportWidth({})).toBe(0);
    expect(selectViewportWidth({ innerWidth: Number.NaN })).toBe(0);
    expect(selectViewportWidth({ innerWidth: -10 })).toBe(0);
    expect(selectViewportWidth(undefined)).toBe(0);
  });
});

describe('voice layout persistence', () => {
  beforeEach(() => {
    localStorage.clear();
    resetVoiceLayoutStore();
  });

  afterEach(() => {
    localStorage.clear();
    resetVoiceLayoutStore();
    vi.restoreAllMocks();
  });

  it('defaults to mobile — the existing surface — before the operator chooses', () => {
    expect(DEFAULT_VOICE_LAYOUT_MODE).toBe('mobile');
    expect(useVoiceLayoutStore.getState().mode).toBe('mobile');
  });

  it('persists the operator choice so it survives a reload', () => {
    useVoiceLayoutStore.getState().setMode('desktop');
    expect(useVoiceLayoutStore.getState().mode).toBe('desktop');

    const raw = localStorage.getItem(VOICE_LAYOUT_STORAGE_KEY);
    expect(raw).toBeTruthy();
    // A reload constructs the store again from the same storage.
    const reloaded = JSON.parse(raw as string) as { state?: { mode?: unknown } };
    expect(reloaded.state?.mode).toBe('desktop');
  });

  it('toggles between the two modes', () => {
    expect(nextVoiceLayoutMode('mobile')).toBe('desktop');
    expect(nextVoiceLayoutMode('desktop')).toBe('mobile');
  });

  it('refuses an unknown stored mode and falls back to mobile', () => {
    localStorage.setItem(VOICE_LAYOUT_STORAGE_KEY, JSON.stringify({ state: { mode: 'hologram' }, version: 0 }));
    resetVoiceLayoutStore();
    expect(useVoiceLayoutStore.getState().mode).toBe('mobile');
  });

  it('refuses corrupt storage instead of throwing', () => {
    localStorage.setItem(VOICE_LAYOUT_STORAGE_KEY, '{not json');
    expect(() => resetVoiceLayoutStore()).not.toThrow();
    expect(useVoiceLayoutStore.getState().mode).toBe('mobile');
  });

  it('refuses an unknown mode passed to setMode', () => {
    useVoiceLayoutStore.getState().setMode('sideways' as never);
    expect(useVoiceLayoutStore.getState().mode).toBe('mobile');
  });

  it('isVoiceLayoutMode accepts only the two real modes', () => {
    expect(isVoiceLayoutMode('mobile')).toBe(true);
    expect(isVoiceLayoutMode('desktop')).toBe(true);
    expect(isVoiceLayoutMode('split')).toBe(false);
    expect(isVoiceLayoutMode(undefined)).toBe(false);
  });
});
