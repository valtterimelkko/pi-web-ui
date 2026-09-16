import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DriveModeOverlay } from '../../../../src/components/DriveMode/DriveModeOverlay';
import { useUIStore } from '../../../../src/store/uiStore';
import { useDriveModeStore } from '../../../../src/store/driveModeStore';
import { useWebSocket } from '../../../../src/hooks/useWebSocket';
import { useSessionStore } from '../../../../src/store/sessionStore';
import { laneFloor } from '../../../../src/components/DriveMode/voiceLanes';
import { useVoiceLayoutStore } from '../../../../src/components/DriveMode/voiceLayout';

/**
 * The overlay in multi-lane mode (lane work, 2026-09-15).
 *
 * ONE tab holds the lanes: every lane's dictate surface stays MOUNTED while
 * the add-lane picker or the cap-ask opens over them (no phase change — an
 * unmount would kill capture and per-lane state). At the cap the "+" asks —
 * replace or cancel — and a fourth lane never appears silently. Switching
 * the addressed lane keeps every other lane's live subscription.
 */

const mockUIStoreState = {
  driveModeOpen: true,
  closeDriveMode: vi.fn(),
  addToast: vi.fn(),
};

vi.mock('../../../../src/store/uiStore', () => ({
  useUIStore: Object.assign(vi.fn(), {
    getState: () => mockUIStoreState,
    setState: vi.fn(),
    subscribe: vi.fn(),
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const driveModeStoreRef: { current: any } = { current: null };

vi.mock('../../../../src/store/driveModeStore', () => ({
  useDriveModeStore: Object.assign(vi.fn(), {
    getState: () => driveModeStoreRef.current,
    setState: vi.fn(),
    subscribe: vi.fn(),
  }),
  DRIVE_MODE_MODELS: [
    { id: 'kimi-coding/kimi-for-coding', displayName: 'Kimi for Coding', sdkType: 'pi' },
  ],
  MAX_VOICE_LANES: 3,
}));

const wsState = {
  createNewSession: vi.fn(),
  switchSession: vi.fn(),
  setModel: vi.fn(),
  abortGeneration: vi.fn(),
  subscribeToSession: vi.fn(),
  unsubscribeFromSession: vi.fn(),
};

vi.mock('../../../../src/hooks/useWebSocket', () => ({
  useWebSocket: vi.fn(() => wsState),
}));

vi.mock('../../../../src/store/sessionStore', () => ({
  useSessionStore: vi.fn(),
}));

vi.mock('../../../../src/hooks/useReadAloud', () => ({
  stopCurrentAudio: vi.fn(),
}));

vi.mock('../../../../src/components/DriveMode/DriveModeEntry', () => ({
  DriveModeEntry: () => <div data-testid="drive-mode-entry" />,
}));
vi.mock('../../../../src/components/DriveMode/DriveModeModelPicker', () => ({
  DriveModeModelPicker: () => <div data-testid="drive-mode-model-picker" />,
}));
vi.mock('../../../../src/components/DriveMode/DriveModeFolderPicker', () => ({
  DriveModeFolderPicker: () => <div data-testid="drive-mode-folder-picker" />,
}));
vi.mock('../../../../src/components/DriveMode/DriveModeSessionPane', () => ({
  DriveModeSessionPane: () => <div data-testid="drive-session-pane" />,
}));

vi.mock('../../../../src/components/DriveMode/DriveModeSessionPicker', () => ({
  DriveModeSessionPicker: (props: {
    onSelectSession: (sessionId: string, sessionPath: string) => void;
    onBack: () => void;
    title?: string;
  }) => (
    <div data-testid="drive-mode-session-picker" data-title={props.title ?? ''}>
      <button onClick={() => props.onSelectSession('s-new', '/path/new.jsonl')}>Select Session</button>
      <button onClick={props.onBack}>Back</button>
    </div>
  ),
}));

const dictatedLanes: Array<{ sessionId: string; laneEnabled?: boolean; addressed?: boolean }> = [];
vi.mock('../../../../src/components/DriveMode/DriveModeDictate', () => ({
  DriveModeDictate: (props: {
    sessionId: string;
    laneEnabled?: boolean;
    addressed?: boolean;
    sessionDisplayName: string;
    onSwitchSession?: () => void;
    compact?: boolean;
  }) => {
    dictatedLanes.push({
      sessionId: props.sessionId,
      laneEnabled: props.laneEnabled,
      addressed: props.addressed,
    });
    return (
      <div data-testid="drive-mode-dictate" data-lane-session={props.sessionId}>
        <span>{props.sessionDisplayName}</span>
        <button
          data-testid="switch-session"
          data-lane-session={props.sessionId}
          onClick={props.onSwitchSession}
        >
          Switch session
        </button>
      </div>
    );
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let driveModeStoreState: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sessionStoreState: any;

const LANES = [{ sessionId: 's1' }, { sessionId: 's2' }];

function baseStore(over: Record<string, unknown> = {}) {
  return {
    phase: 'dictate',
    selectedModelId: null,
    activeSessionId: 's1',
    lanes: [],
    addingLane: false,
    replacingLaneId: null,
    close: vi.fn(),
    setPhase: vi.fn(),
    selectModel: vi.fn(),
    setActiveSession: vi.fn(),
    reset: vi.fn(),
    openAddLane: vi.fn(),
    cancelAddLane: vi.fn(),
    beginLaneReplace: vi.fn(),
    addVoiceLane: vi.fn(() => 'added'),
    replaceVoiceLane: vi.fn(() => 'replaced'),
    removeVoiceLane: vi.fn(),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  laneFloor.dispose();
  dictatedLanes.length = 0;

  driveModeStoreState = baseStore();
  driveModeStoreRef.current = driveModeStoreState;

  sessionStoreState = {
    sessions: [
      { id: 's1', path: '/path/1.jsonl', name: 'Worker One', model: 'glm', firstMessage: 'a', cwd: '/' },
      { id: 's2', path: '/path/2.jsonl', name: 'Worker Two', model: 'glm', firstMessage: 'b', cwd: '/' },
      { id: 's3', path: '/path/3.jsonl', name: 'Worker Three', model: 'glm', firstMessage: 'c', cwd: '/' },
      { id: 's-new', path: '/path/new.jsonl', name: 'New Worker', model: 'glm', firstMessage: 'd', cwd: '/' },
    ],
    currentSessionId: 's1',
    currentModel: 'glm',
    streamingSessions: {},
    getSessionDisplayName: () => null,
  };

  (useUIStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (selector: (state: unknown) => unknown) => (selector ? selector(mockUIStoreState) : mockUIStoreState)
  );
  (useDriveModeStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (selector: (state: unknown) => unknown) =>
      selector ? selector(driveModeStoreState) : driveModeStoreState
  );
  (useSessionStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (selector: (state: unknown) => unknown) => (selector ? selector(sessionStoreState) : sessionStoreState)
  );
  (useWebSocket as unknown as ReturnType<typeof vi.fn>).mockReturnValue(wsState);
});

describe('DriveModeOverlay — one tab holds the lanes', () => {
  it('single-lane (no lanes): exactly today — one surface, no strip rows; only the collapsed add affordance', () => {
    render(<DriveModeOverlay />);
    const surfaces = screen.getAllByTestId('drive-mode-dictate');
    expect(surfaces).toHaveLength(1);
    expect(screen.queryByTestId('drive-mode-session-picker')).toBeNull();
    // And the single surface is NOT in lane mode.
    expect(dictatedLanes[0]?.laneEnabled).toBeFalsy();
    // The strip collapses: no rows, no cap counter — but the '+' (the feature
    // entry point the brief mandates) is still reachable in single-lane use.
    expect(screen.queryByTestId('lane-row')).toBeNull();
    expect(screen.queryByTestId('lane-cap')).toBeNull();
    expect(screen.getByRole('button', { name: /add a lane/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /add a lane/i }));
    expect(driveModeStoreState.openAddLane).toHaveBeenCalled();
  });

  it('multi-lane: one mounted surface PER lane, the strip with the cap, only the addressed lane addressed', () => {
    driveModeStoreState = baseStore({ lanes: LANES, activeSessionId: 's2' });
    render(<DriveModeOverlay />);
    const surfaces = screen.getAllByTestId('drive-mode-dictate');
    expect(surfaces).toHaveLength(2);
    expect(surfaces.map((s) => s.getAttribute('data-lane-session'))).toEqual(['s1', 's2']);
    expect(dictatedLanes.every((l) => l.laneEnabled === true)).toBe(true);
    expect(dictatedLanes.find((l) => l.sessionId === 's2')?.addressed).toBe(true);
    expect(dictatedLanes.find((l) => l.sessionId === 's1')?.addressed).toBe(false);
    expect(screen.getByTestId('lane-cap')).toHaveTextContent('2 of 3');
  });

  it('the strip switches the addressed lane and keeps the other lane subscribed', () => {
    driveModeStoreState = baseStore({ lanes: LANES, activeSessionId: 's1' });
    render(<DriveModeOverlay />);
    const rows = screen.getAllByTestId('lane-row');
    fireEvent.click(rows[1]); // address s2
    expect(driveModeStoreState.setActiveSession).toHaveBeenCalledWith('s2');
    expect(wsState.switchSession).toHaveBeenCalledWith('/path/2.jsonl');
    // s1 stays live: re-subscribed after the switch (switch unsubscribes the old current).
    expect(wsState.subscribeToSession).toHaveBeenCalledWith('/path/1.jsonl');
  });

  it('the add-lane picker opens OVER the mounted lanes — no phase change, no unmount', () => {
    driveModeStoreState = baseStore({ lanes: LANES, activeSessionId: 's1' });
    const { unmount } = render(<DriveModeOverlay />);
    expect(screen.queryByTestId('drive-mode-session-picker')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /add a lane/i }));
    expect(driveModeStoreState.openAddLane).toHaveBeenCalled();
    dictatedLanes.length = 0;
    // The store drives the picker; simulate it open (the overlay re-renders with addingLane).
    driveModeStoreState = baseStore({ lanes: LANES, activeSessionId: 's1', addingLane: true });
    unmount();
    render(<DriveModeOverlay />);
    expect(screen.getByTestId('drive-mode-session-picker')).toBeInTheDocument();
    expect(driveModeStoreState.phase).toBe('dictate'); // never left dictate
    expect(screen.getAllByTestId('drive-mode-dictate')).toHaveLength(2); // lanes stayed mounted
  });

  it('adding the FIRST extra lane opens the picker from the collapsed strip, over the mounted surface', () => {
    // The harness caught this: with one lane, the '+' must reach the same
    // in-place picker — never a dead button.
    driveModeStoreState = baseStore({ lanes: [], activeSessionId: 's1', addingLane: true });
    render(<DriveModeOverlay />);
    expect(screen.getByRole('button', { name: /add a lane/i })).toBeInTheDocument();
    expect(screen.getByTestId('drive-mode-session-picker')).toBeInTheDocument();
    expect(driveModeStoreState.phase).toBe('dictate');
    expect(screen.getAllByTestId('drive-mode-dictate')).toHaveLength(1); // surface stayed mounted
    fireEvent.click(screen.getByText('Select Session'));
    expect(driveModeStoreState.addVoiceLane).toHaveBeenCalledWith('s-new');
  });

  it('adding a lane subscribes it and addresses it', () => {
    driveModeStoreState = baseStore({ lanes: LANES, activeSessionId: 's1', addingLane: true });
    render(<DriveModeOverlay />);
    fireEvent.click(screen.getByText('Select Session')); // picks s-new
    expect(driveModeStoreState.addVoiceLane).toHaveBeenCalledWith('s-new');
    expect(wsState.subscribeToSession).toHaveBeenCalledWith('/path/new.jsonl');
    expect(driveModeStoreState.setActiveSession).toHaveBeenCalledWith('s-new');
    expect(wsState.switchSession).toHaveBeenCalledWith('/path/new.jsonl');
  });

  it('AT THE CAP the "+" asks: replace choices per lane, never a silent fourth lane', () => {
    driveModeStoreState = baseStore({
      lanes: [...LANES, { sessionId: 's3' }],
      activeSessionId: 's1',
    });
    render(<DriveModeOverlay />);
    fireEvent.click(screen.getByRole('button', { name: /add a lane/i }));
    // The ask is rendered instead of a picker: replace one, or cancel.
    expect(screen.getByTestId('lane-cap-ask')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /replace worker one/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /replace worker two/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /replace worker three/i })).toBeInTheDocument();
    expect(driveModeStoreState.openAddLane).toHaveBeenCalled();
  });

  it('choosing a lane to replace opens the picker in replace mode; the pick swaps in place', () => {
    driveModeStoreState = baseStore({
      lanes: [...LANES, { sessionId: 's3' }],
      activeSessionId: 's1',
      addingLane: true,
      replacingLaneId: 's2',
    });
    render(<DriveModeOverlay />);
    expect(screen.getByTestId('drive-mode-session-picker')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Select Session'));
    expect(driveModeStoreState.replaceVoiceLane).toHaveBeenCalledWith('s2', 's-new');
    // The replaced lane's subscription is dropped, the new one subscribed.
    expect(wsState.unsubscribeFromSession).toHaveBeenCalledWith('/path/2.jsonl');
    expect(wsState.subscribeToSession).toHaveBeenCalledWith('/path/new.jsonl');
  });

  it('closing a lane finalises its capture, removes it, and unsubscribes it', () => {
    driveModeStoreState = baseStore({ lanes: LANES, activeSessionId: 's1' });
    const stopSpy = vi.fn();
    laneFloor.registerLane('s2');
    laneFloor.setCaptureControls('s2', { stopCapture: stopSpy });
    render(<DriveModeOverlay />);
    fireEvent.click(screen.getByRole('button', { name: /close lane worker two/i }));
    expect(stopSpy).toHaveBeenCalled(); // never drop the operator's words
    expect(driveModeStoreState.removeVoiceLane).toHaveBeenCalledWith('s2');
    expect(wsState.unsubscribeFromSession).toHaveBeenCalledWith('/path/2.jsonl');
  });
});

/**
 * Lanes in the DESKTOP layout (operator request, 2026-09-16): "I can only see
 * the lanes within the mobile view, not in the desktop view … because we are
 * having maximum three lanes, I want to add the lanes to the desktop view."
 * The lane strip and the session pane must coexist: lanes in the voice block,
 * the session as a bottom panel of the same column.
 */
describe('DriveModeOverlay — lanes in the desktop layout', () => {
  const setWidth = (width: number) => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
    window.dispatchEvent(new Event('resize'));
  };

  afterEach(() => {
    useVoiceLayoutStore.setState({ mode: 'mobile' });
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1024 });
  });

  it('desktop shows the lane rows AND the session pane, in one column', () => {
    useVoiceLayoutStore.setState({ mode: 'desktop' });
    setWidth(1600);
    driveModeStoreState = baseStore({
      lanes: [...LANES, { sessionId: 's3' }],
      activeSessionId: 's1',
    });
    render(<DriveModeOverlay />);

    expect(screen.getAllByTestId('lane-row')).toHaveLength(3);
    expect(screen.getByTestId('lane-cap')).toHaveTextContent('3 of 3');
    const column = screen.getByTestId('drive-mode-column');
    expect(column).toContainElement(screen.getByTestId('lane-strip'));
    expect(column).toContainElement(screen.getByTestId('drive-session-pane'));
    expect(column.lastElementChild).toBe(screen.getByTestId('drive-session-panel'));
    expect(screen.getAllByTestId('drive-mode-dictate')).toHaveLength(3); // every lane stays mounted
  });

  it('the lane "+" is offered in desktop mode too', () => {
    useVoiceLayoutStore.setState({ mode: 'desktop' });
    setWidth(1600);
    driveModeStoreState = baseStore({ lanes: [], activeSessionId: 's1' });
    render(<DriveModeOverlay />);
    expect(screen.getByTestId('lane-strip-collapsed')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /add a lane/i }));
    expect(driveModeStoreState.openAddLane).toHaveBeenCalled();
  });
});

/**
 * Switching ONE lane's worker (operator request, 2026-09-16): the lane keeps
 * its place in the set; only its session changes. No exit, no rebuild.
 */
describe("DriveModeOverlay — switching a lane's worker in place", () => {
  it('the addressed lane can be switched from its own surface', () => {
    driveModeStoreState = baseStore({ lanes: LANES, activeSessionId: 's2' });
    render(<DriveModeOverlay />);
    // Every lane surface stays mounted, so the addressed one's control is
    // picked by its lane identity.
    const addressedSwitch = screen
      .getAllByTestId('switch-session')
      .find((button) => button.dataset.laneSession === 's2');
    expect(addressedSwitch).toBeDefined();
    fireEvent.click(addressedSwitch as HTMLElement);
    expect(driveModeStoreState.beginLaneReplace).toHaveBeenCalledWith('s2');
  });

  it('any lane can be switched from its strip row', () => {
    driveModeStoreState = baseStore({ lanes: LANES, activeSessionId: 's1' });
    render(<DriveModeOverlay />);
    fireEvent.click(screen.getByRole('button', { name: /switch session for worker two/i }));
    expect(driveModeStoreState.beginLaneReplace).toHaveBeenCalledWith('s2');
    // The lane set is untouched by the request itself — nothing is removed.
    expect(driveModeStoreState.removeVoiceLane).not.toHaveBeenCalled();
  });

  it('the picker names the flow: adding a lane, or switching a lane', () => {
    driveModeStoreState = baseStore({ lanes: LANES, activeSessionId: 's1', addingLane: true });
    const adding = render(<DriveModeOverlay />);
    expect(screen.getByTestId('drive-mode-session-picker')).toHaveAttribute('data-title', 'Add a lane');
    adding.unmount();

    driveModeStoreState = baseStore({
      lanes: LANES,
      activeSessionId: 's1',
      addingLane: true,
      replacingLaneId: 's2',
    });
    render(<DriveModeOverlay />);
    expect(screen.getByTestId('drive-mode-session-picker')).toHaveAttribute('data-title', 'Switch session');
  });

  it('the pick swaps only that lane, subscribes the new session and addresses it', () => {
    driveModeStoreState = baseStore({
      lanes: LANES,
      activeSessionId: 's1',
      addingLane: true,
      replacingLaneId: 's2',
    });
    render(<DriveModeOverlay />);
    expect(screen.getByTestId('drive-mode-session-picker')).toBeInTheDocument();
    // The other lane's surface stayed mounted while the picker was open.
    expect(screen.getAllByTestId('drive-mode-dictate')).toHaveLength(2);

    fireEvent.click(screen.getByText('Select Session'));
    expect(driveModeStoreState.replaceVoiceLane).toHaveBeenCalledWith('s2', 's-new');
    expect(wsState.unsubscribeFromSession).toHaveBeenCalledWith('/path/2.jsonl');
    expect(wsState.subscribeToSession).toHaveBeenCalledWith('/path/new.jsonl');
    expect(driveModeStoreState.setActiveSession).toHaveBeenCalledWith('s-new');
    expect(driveModeStoreState.addVoiceLane).not.toHaveBeenCalled(); // a switch, not a new lane
  });
});
