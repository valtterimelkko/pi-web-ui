/**
 * C24 — the picker's worker switch must stop the old lane's native session.
 *
 * The Drive Mode session picker swaps a lane's worker IN PLACE (store
 * `replaceVoiceLane`), so the server never sees a lane re-attach and the
 * contract's §3.2 step-1 stop (`voice_session_stop`, reason `worker_switch`)
 * is never sent — a pending proposal silently outlives the switch. This pins
 * the wiring: committing a replacement calls `stopVoiceLaneForWorkerSwitch`
 * for the OLD session, BEFORE the store swaps the lane's worker.
 *
 * `DriveModeDictate` is stubbed (its surface harness is unit-tested elsewhere;
 * see DriveModeDictate.native-primary.test.tsx and surface.test.ts); the
 * overlay, the real drive-mode store, the lane strip and the picker are real.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';

const calls = vi.hoisted(() => {
  const state: {
    stoppedFor: Array<{ sessionId: string; lanesAtStop: Array<{ sessionId: string }> }>;
    driveModeState: (() => { lanes: Array<{ sessionId: string }> }) | null;
  } = { stoppedFor: [], driveModeState: null };
  return state;
});

vi.mock('../../hooks/useVoiceLiveLane', () => ({
  useVoiceLiveLane: vi.fn(() => {
    throw new Error('DriveModeDictate is stubbed in this suite; the real hook is not needed here');
  }),
  stopVoiceLaneForWorkerSwitch: vi.fn((workerSessionId: string) => {
    const snapshot = calls.driveModeState?.();
    calls.stoppedFor.push({
      sessionId: workerSessionId,
      lanesAtStop: snapshot ? snapshot.lanes.map((lane) => ({ ...lane })) : [],
    });
    return true;
  }),
}));

vi.mock('./DriveModeDictate', () => ({
  DriveModeDictate: (props: { sessionId: string }) => (
    <div data-testid="dictate-stub" data-session={props.sessionId} />
  ),
}));

vi.mock('../../hooks/useVoiceLayout', () => ({
  useVoiceLayout: () => ({ layout: 'mobile' }),
}));

const uiState = {
  driveModeOpen: true,
  closeDriveMode: vi.fn(),
  addToast: vi.fn(),
};
vi.mock('../../store/uiStore', () => ({
  useUIStore: Object.assign(
    vi.fn((selector: (s: typeof uiState) => unknown) => selector(uiState)),
    { getState: () => uiState },
  ),
}));

const sessionState = {
  currentSessionId: 'session-a',
  currentModel: 'test-model',
  streamingSessions: {} as Record<string, boolean>,
  sessions: [
    { id: 'session-a', path: '/tmp/a', name: 'Worker A', sdkType: 'pi' },
    { id: 'session-b', path: '/tmp/b', name: 'Worker B', sdkType: 'pi' },
    { id: 'session-c', path: '/tmp/c', name: 'Worker C', sdkType: 'pi' },
  ],
  archivedSessionPaths: [] as string[],
  getSessionDisplayName: (path: string) =>
    path === '/tmp/a' ? 'Worker A' : path === '/tmp/b' ? 'Worker B' : 'Worker C',
};
vi.mock('../../store/sessionStore', () => ({
  useSessionStore: Object.assign(
    vi.fn((selector: (s: unknown) => unknown) => selector(sessionState)),
    { getState: () => sessionState },
  ),
}));

vi.mock('../../hooks/useWebSocket', () => ({
  useWebSocket: () => ({
    createNewSession: vi.fn(),
    switchSession: vi.fn(),
    setModel: vi.fn(),
    abortGeneration: vi.fn(),
    subscribeToSession: vi.fn(),
    unsubscribeFromSession: vi.fn(),
  }),
}));

import { DriveModeOverlay } from './DriveModeOverlay';
import { useDriveModeStore } from '../../store/driveModeStore';
import { stopVoiceLaneForWorkerSwitch } from '../../hooks/useVoiceLiveLane';

// The hoisted mock factory cannot import the store; hand it a snapshot getter
// instead (assigned before any test runs).
calls.driveModeState = () => useDriveModeStore.getState();

beforeEach(() => {
  calls.stoppedFor = [];
  vi.clearAllMocks();
  useDriveModeStore.setState({
    isOpen: true,
    phase: 'dictate',
    selectedModelId: null,
    activeSessionId: 'session-a',
    lanes: [{ sessionId: 'session-a' }, { sessionId: 'session-b' }],
    addingLane: false,
    replacingLaneId: null,
  });
});

/** Open the in-place switch picker for a lane and pick a session by name. */
function switchLaneTo(laneLabel: string, pickLabel: string): void {
  fireEvent.click(screen.getByRole('button', { name: `Switch session for ${laneLabel}` }));
  const picker = screen.getByRole('heading', { name: 'Switch session' }).parentElement as HTMLElement;
  fireEvent.click(within(picker).getByText(pickLabel).closest('button') as HTMLButtonElement);
}

describe('DriveModeOverlay — the picker worker switch stops the old lane (C24)', () => {
  it('calls stopVoiceLaneForWorkerSwitch for the OLD session before the store swaps the lane', () => {
    useDriveModeStore.setState({
      isOpen: true,
      phase: 'dictate',
      activeSessionId: 'session-a',
      lanes: [{ sessionId: 'session-a' }, { sessionId: 'session-b' }],
      addingLane: false,
      replacingLaneId: null,
    });
    render(<DriveModeOverlay />);

    // Open the picker for lane A and pick session C as the replacement
    // (session B is already a lane and would be refused as a duplicate).
    switchLaneTo('Worker A', 'Worker C');

    // The lane was stopped by its OLD worker session id, while the lane still
    // held it (before the swap).
    expect(stopVoiceLaneForWorkerSwitch).toHaveBeenCalledTimes(1);
    expect(stopVoiceLaneForWorkerSwitch).toHaveBeenCalledWith('session-a');
    expect(calls.stoppedFor[0]?.lanesAtStop).toEqual([
      { sessionId: 'session-a' },
      { sessionId: 'session-b' },
    ]);

    // And the store swap happened: the lane now holds session C, in place.
    expect(useDriveModeStore.getState().lanes).toEqual([
      { sessionId: 'session-c' },
      { sessionId: 'session-b' },
    ]);
  });

  it('a refused duplicate pick never stops the lane', () => {
    useDriveModeStore.setState({
      isOpen: true,
      phase: 'dictate',
      activeSessionId: 'session-a',
      lanes: [
        { sessionId: 'session-a' },
        { sessionId: 'session-b' },
      ],
      addingLane: false,
      replacingLaneId: null,
    });
    render(<DriveModeOverlay />);

    // Try to switch lane A to session B — which is already lane B.
    switchLaneTo('Worker A', 'Worker B');

    expect(uiState.addToast).toHaveBeenCalled();
    expect(stopVoiceLaneForWorkerSwitch).not.toHaveBeenCalled();
    // The lane set is untouched.
    expect(useDriveModeStore.getState().lanes).toEqual([
      { sessionId: 'session-a' },
      { sessionId: 'session-b' },
    ]);
  });
});
