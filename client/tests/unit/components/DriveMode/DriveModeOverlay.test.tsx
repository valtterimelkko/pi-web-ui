import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DriveModeOverlay } from '../../../../src/components/DriveMode/DriveModeOverlay';
import { useUIStore } from '../../../../src/store/uiStore';
import { useDriveModeStore } from '../../../../src/store/driveModeStore';
import { useWebSocket } from '../../../../src/hooks/useWebSocket';
import { useSessionStore } from '../../../../src/store/sessionStore';

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

const mockDriveModeStoreState = {
  phase: 'entry',
  selectedModelId: null,
  activeSessionId: null,
};

vi.mock('../../../../src/store/driveModeStore', () => ({
  useDriveModeStore: Object.assign(vi.fn(), {
    getState: () => mockDriveModeStoreState,
    setState: vi.fn(),
    subscribe: vi.fn(),
  }),
  DRIVE_MODE_MODELS: [
    { id: 'kimi-for-coding', displayName: 'Kimi for Coding', sdkType: 'pi' },
    { id: 'zai-coding-plan/glm-5.1', displayName: 'GLM-5.1', sdkType: 'opencode' },
  ],
}));

vi.mock('../../../../src/hooks/useWebSocket', () => ({
  useWebSocket: vi.fn(),
}));

vi.mock('../../../../src/store/sessionStore', () => ({
  useSessionStore: vi.fn(),
}));

vi.mock('../../../../src/hooks/useReadAloud', () => ({
  stopCurrentAudio: vi.fn(),
}));

vi.mock('../../../../src/components/DriveMode/DriveModeEntry', () => ({
  DriveModeEntry: (props: { onNewSession: () => void; onContinueSession: () => void; onExit: () => void }) => (
    <div data-testid="drive-mode-entry">
      <button onClick={props.onNewSession}>New Session</button>
      <button onClick={props.onContinueSession}>Continue Session</button>
      <button onClick={props.onExit}>Exit</button>
    </div>
  ),
}));

vi.mock('../../../../src/components/DriveMode/DriveModeModelPicker', () => ({
  DriveModeModelPicker: (props: { onSelect: (model: { id: string; displayName: string; sdkType: string }) => void; onBack: () => void }) => (
    <div data-testid="drive-mode-model-picker">
      <button onClick={() => props.onSelect({ id: 'kimi-for-coding', displayName: 'Kimi for Coding', sdkType: 'pi' })}>
        Select Model
      </button>
      <button onClick={props.onBack}>Back</button>
    </div>
  ),
}));

vi.mock('../../../../src/components/DriveMode/DriveModeSessionPicker', () => ({
  DriveModeSessionPicker: (props: { onSelectSession: (sessionId: string, sessionPath: string) => void; onBack: () => void }) => (
    <div data-testid="drive-mode-session-picker">
      <button onClick={() => props.onSelectSession('s1', '/path/1.jsonl')}>Select Session</button>
      <button onClick={props.onBack}>Back</button>
    </div>
  ),
}));

vi.mock('../../../../src/components/DriveMode/DriveModeDictate', () => ({
  DriveModeDictate: (props: { sessionId: string; modelName: string; onExit: () => void }) => (
    <div data-testid="drive-mode-dictate">
      <span>{props.sessionId}</span>
      <span>{props.modelName}</span>
      <button onClick={props.onExit}>Exit Dictate</button>
    </div>
  ),
}));

describe('DriveModeOverlay', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let driveModeStoreState: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sessionStoreState: any;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    driveModeStoreState = {
      phase: 'entry',
      selectedModelId: null,
      activeSessionId: null,
      close: vi.fn(),
      setPhase: vi.fn(),
      selectModel: vi.fn(),
      setActiveSession: vi.fn(),
      reset: vi.fn(),
    };

    sessionStoreState = {
      sessions: [{ id: 's1', path: '/path/1.jsonl', name: 'Test Session', model: 'claude-3-opus', firstMessage: 'Hello', messageCount: 1, cwd: '/' }],
      currentSessionId: 's1',
      currentModel: 'claude-3-opus',
    };

    mockDriveModeStoreState.phase = 'entry';
    mockDriveModeStoreState.selectedModelId = null;
    mockDriveModeStoreState.activeSessionId = null;

    mockUIStoreState.driveModeOpen = true;
    mockUIStoreState.closeDriveMode = vi.fn();
    mockUIStoreState.addToast = vi.fn();

    (useUIStore as ReturnType<typeof vi.fn>).mockImplementation((selector: (state: unknown) => unknown) => {
      return selector ? selector(mockUIStoreState) : mockUIStoreState;
    });

    (useDriveModeStore as ReturnType<typeof vi.fn>).mockImplementation((selector: (state: unknown) => unknown) => {
      return selector ? selector(driveModeStoreState) : driveModeStoreState;
    });

    (useSessionStore as ReturnType<typeof vi.fn>).mockImplementation((selector: (state: unknown) => unknown) => {
      return selector ? selector(sessionStoreState) : sessionStoreState;
    });

    (useWebSocket as ReturnType<typeof vi.fn>).mockReturnValue({
      createNewSession: vi.fn(),
      switchSession: vi.fn(),
      setModel: vi.fn(),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns null when isOpen is false', () => {
    (useUIStore as ReturnType<typeof vi.fn>).mockImplementation((selector: (state: unknown) => unknown) => {
      const state = {
        driveModeOpen: false,
        closeDriveMode: vi.fn(),
        addToast: vi.fn(),
      };
      return selector ? selector(state) : state;
    });
    const { container } = render(<DriveModeOverlay />);
    expect(container.firstChild).toBeNull();
  });

  it('renders overlay when isOpen is true', () => {
    const { container } = render(<DriveModeOverlay />);
    expect(container.firstChild).toBeInTheDocument();
  });

  it('phase routing: entry → DriveModeEntry', () => {
    driveModeStoreState.phase = 'entry';
    render(<DriveModeOverlay />);
    expect(screen.getByTestId('drive-mode-entry')).toBeInTheDocument();
  });

  it('phase routing: model-pick → DriveModeModelPicker', () => {
    driveModeStoreState.phase = 'model-pick';
    render(<DriveModeOverlay />);
    expect(screen.getByTestId('drive-mode-model-picker')).toBeInTheDocument();
  });

  it('phase routing: session-pick → DriveModeSessionPicker', () => {
    driveModeStoreState.phase = 'session-pick';
    render(<DriveModeOverlay />);
    expect(screen.getByTestId('drive-mode-session-picker')).toBeInTheDocument();
  });

  it('phase routing: dictate → DriveModeDictate', () => {
    driveModeStoreState.phase = 'dictate';
    render(<DriveModeOverlay />);
    expect(screen.getByTestId('drive-mode-dictate')).toBeInTheDocument();
  });

  it('escape key closes overlay', () => {
    const mockCloseDriveMode = vi.fn();
    const mockClose = vi.fn();
    (useUIStore as ReturnType<typeof vi.fn>).mockImplementation((selector: (state: unknown) => unknown) => {
      const state = {
        driveModeOpen: true,
        closeDriveMode: mockCloseDriveMode,
        addToast: vi.fn(),
      };
      return selector ? selector(state) : state;
    });
    (useDriveModeStore as ReturnType<typeof vi.fn>).mockImplementation((selector: (state: unknown) => unknown) => {
      const state = {
        phase: 'entry',
        selectedModelId: null,
        activeSessionId: null,
        close: mockClose,
        setPhase: vi.fn(),
        selectModel: vi.fn(),
        setActiveSession: vi.fn(),
        reset: vi.fn(),
      };
      return selector ? selector(state) : state;
    });

    render(<DriveModeOverlay />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(mockCloseDriveMode).toHaveBeenCalled();
    expect(mockClose).toHaveBeenCalled();
  });

  it('shows toast error when session creation times out', () => {
    const mockAddToast = vi.fn();
    mockUIStoreState.addToast = mockAddToast;
    (useUIStore as ReturnType<typeof vi.fn>).mockImplementation((selector: (state: unknown) => unknown) => {
      return selector ? selector(mockUIStoreState) : mockUIStoreState;
    });

    driveModeStoreState.phase = 'model-pick';
    driveModeStoreState.selectedModelId = 'kimi-for-coding';
    mockDriveModeStoreState.phase = 'model-pick';
    mockDriveModeStoreState.selectedModelId = 'kimi-for-coding';

    render(<DriveModeOverlay />);
    fireEvent.click(screen.getByText('Select Model'));

    vi.advanceTimersByTime(10000);

    expect(mockAddToast).toHaveBeenCalledWith({
      type: 'error',
      message: 'Failed to create session. Please try again.',
    });
  });
});
