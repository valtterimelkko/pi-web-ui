import { describe, it, expect, beforeEach } from 'vitest';
import {
  useDriveModeStore,
  MAX_VOICE_LANES,
  type DriveModeLane,
} from '../../../src/store/driveModeStore';

/**
 * Voice lanes in one tab (multi-lane work, 2026-09-15).
 *
 * ONE tab holds the lanes — no cross-tab coordination, no server registry.
 * The store keeps the lane set (empty = today's single-lane surface), the
 * cap of 3, and the in-place add-lane flow. A fourth lane never appears
 * silently: at the cap the UI must ask (replace or choose), so `addVoiceLane`
 * refuses with 'full' instead of adding.
 */

const A = 'session-a';
const B = 'session-b';
const C = 'session-c';
const D = 'session-d';

function resetStore(activeSessionId: string | null = null) {
  useDriveModeStore.setState({
    isOpen: false,
    phase: 'entry',
    selectedModelId: null,
    activeSessionId,
    lastAssistantText: null,
    lanes: [] as DriveModeLane[],
    addingLane: false,
    replacingLaneId: null,
  });
}

describe('voice lanes — the cap and the asking rule', () => {
  beforeEach(() => resetStore(A));

  it('the cap is 3 — the decided number', () => {
    expect(MAX_VOICE_LANES).toBe(3);
  });

  it('a single-lane surface has no lanes: today\'s behaviour is the empty set', () => {
    expect(useDriveModeStore.getState().lanes).toEqual([]);
  });

  it('adding the first extra lane seeds the addressed session as lane 1', () => {
    const outcome = useDriveModeStore.getState().addVoiceLane(B);
    expect(outcome).toBe('added');
    expect(useDriveModeStore.getState().lanes).toEqual([{ sessionId: A }, { sessionId: B }]);
  });

  it('refuses a lane whose session is already a lane (duplicate) without changing the set', () => {
    useDriveModeStore.getState().addVoiceLane(B);
    const outcome = useDriveModeStore.getState().addVoiceLane(A);
    expect(outcome).toBe('duplicate');
    expect(useDriveModeStore.getState().lanes).toEqual([{ sessionId: A }, { sessionId: B }]);
  });

  it('never adds a fourth lane silently: at the cap addVoiceLane refuses with "full"', () => {
    useDriveModeStore.getState().addVoiceLane(B);
    useDriveModeStore.getState().addVoiceLane(C);
    expect(useDriveModeStore.getState().lanes).toHaveLength(3);
    expect(useDriveModeStore.getState().addVoiceLane(D)).toBe('full');
    expect(useDriveModeStore.getState().lanes).toHaveLength(3);
  });

  it('replaceVoiceLane swaps in place, keeping lane order', () => {
    useDriveModeStore.getState().addVoiceLane(B);
    useDriveModeStore.getState().addVoiceLane(C);
    const outcome = useDriveModeStore.getState().replaceVoiceLane(B, D);
    expect(outcome).toBe('replaced');
    expect(useDriveModeStore.getState().lanes).toEqual([
      { sessionId: A },
      { sessionId: D },
      { sessionId: C },
    ]);
  });

  it('replaceVoiceLane refuses a session that is already a lane', () => {
    useDriveModeStore.getState().addVoiceLane(B);
    expect(useDriveModeStore.getState().replaceVoiceLane(B, A)).toBe('duplicate');
    expect(useDriveModeStore.getState().lanes).toEqual([{ sessionId: A }, { sessionId: B }]);
  });

  it('removing a lane keeps the rest; removing down to one collapses to the single-lane set', () => {
    useDriveModeStore.getState().addVoiceLane(B);
    useDriveModeStore.getState().addVoiceLane(C);
    useDriveModeStore.getState().removeVoiceLane(B);
    expect(useDriveModeStore.getState().lanes).toEqual([{ sessionId: A }, { sessionId: C }]);
    useDriveModeStore.getState().removeVoiceLane(C);
    // One lane left = the operator's original single-lane surface.
    expect(useDriveModeStore.getState().lanes).toEqual([]);
    expect(useDriveModeStore.getState().activeSessionId).toBe(A);
  });
});

describe('voice lanes — the in-place add flow', () => {
  beforeEach(() => resetStore(A));

  it('openAddLane opens the picker without leaving the dictate phase or unmounting lanes', () => {
    useDriveModeStore.getState().setPhase('dictate');
    useDriveModeStore.getState().openAddLane();
    const state = useDriveModeStore.getState();
    expect(state.addingLane).toBe(true);
    expect(state.phase).toBe('dictate');
  });

  it('cancelAddLane closes the picker and clears any replace context', () => {
    useDriveModeStore.getState().addVoiceLane(B);
    useDriveModeStore.getState().addVoiceLane(C);
    useDriveModeStore.getState().openAddLane();
    useDriveModeStore.getState().beginLaneReplace(A);
    useDriveModeStore.getState().cancelAddLane();
    const state = useDriveModeStore.getState();
    expect(state.addingLane).toBe(false);
    expect(state.replacingLaneId).toBeNull();
  });

  it('adding a lane closes the picker', () => {
    useDriveModeStore.getState().openAddLane();
    useDriveModeStore.getState().addVoiceLane(B);
    expect(useDriveModeStore.getState().addingLane).toBe(false);
  });

  it('replacing a lane closes the picker and clears the replace context', () => {
    useDriveModeStore.getState().addVoiceLane(B);
    useDriveModeStore.getState().addVoiceLane(C);
    useDriveModeStore.getState().openAddLane();
    useDriveModeStore.getState().beginLaneReplace(B);
    useDriveModeStore.getState().replaceVoiceLane(B, D);
    const state = useDriveModeStore.getState();
    expect(state.addingLane).toBe(false);
    expect(state.replacingLaneId).toBeNull();
    expect(useDriveModeStore.getState().lanes).toEqual([
      { sessionId: A },
      { sessionId: D },
      { sessionId: C },
    ]);
  });
});
