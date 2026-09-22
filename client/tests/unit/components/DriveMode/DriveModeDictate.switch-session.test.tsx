import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DriveModeDictate } from '../../../../src/components/DriveMode/DriveModeDictate';
import { resetTalkerTurnBus } from '../../../../src/lib/talkerBus';
import { speechArbiter } from '../../../../src/lib/speechArbiter';

/**
 * Switching the worker a voice surface is attached to (operator request,
 * 2026-09-16):
 *
 *   "I don't see an easy 'switch session' button that would allow me to adjust
 *    quickly (per lane) what session / worker is the voice mode attached to …
 *    so I don't have to exit the voice mode entirely and then having to rebuild
 *    the 3 lanes view again from scratch."
 *
 * The surface offers the control; the overlay owns what switching MEANS (swap
 * this lane's session / re-address the single lane). Nothing else about the
 * surface changes.
 */

vi.mock('../../../../src/hooks/useWebSocket', () => ({
  useWebSocket: vi.fn(() => ({ sendMessage: vi.fn(), sendPrompt: vi.fn() })),
}));

vi.mock('../../../../src/hooks/useDictation', () => ({
  useDictation: vi.fn(() => ({
    state: 'idle',
    errorMessage: '',
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    toggle: vi.fn(),
  })),
}));

const sessionState = { isStreaming: false, messages: [] as Array<Record<string, unknown>> };
vi.mock('../../../../src/store/sessionStore', () => ({
  useSessionStore: vi.fn((selector: (s: unknown) => unknown) =>
    selector ? selector(sessionState) : sessionState
  ),
}));

const driveState = { phase: 'dictate', setPhase: vi.fn() };
vi.mock('../../../../src/store/driveModeStore', () => ({
  useDriveModeStore: vi.fn((selector: (s: unknown) => unknown) =>
    selector ? selector(driveState) : driveState
  ),
}));

vi.mock('lucide-react', () => ({
  Mic: () => <span data-testid="icon-mic" />,
  Smartphone: () => <span data-testid="icon-smartphone" />,
  Monitor: () => <span data-testid="icon-monitor" />,
  MicOff: () => <span data-testid="icon-micoff" />,
  Square: () => <span data-testid="icon-square" />,
  VolumeX: () => <span data-testid="icon-volumex" />,
  Check: () => <span data-testid="icon-check" />,
  X: () => <span data-testid="icon-x" />,
  Send: () => <span data-testid="icon-send" />,
  Car: () => <span data-testid="icon-car" />,
  Eye: () => <span data-testid="icon-eye" />,
  EyeOff: () => <span data-testid="icon-eyeoff" />,
  Inbox: () => <span data-testid="icon-inbox" />,
  RefreshCw: () => <span data-testid="icon-switch" />,
  Radio: () => <span data-testid="icon-radio" />,
  Keyboard: () => <span data-testid="icon-keyboard" />,
  AlertTriangle: () => <span data-testid="icon-alerttriangle" />,
  BellRing: () => <span data-testid="icon-bellring" />,
  Clock: () => <span data-testid="icon-clock" />,
  HelpCircle: () => <span data-testid="icon-helpcircle" />,
}));

const WORKER = '/pi/worker.jsonl';

function renderSurface(props: {
  onSwitchSession?: () => void;
  compact?: boolean;
  laneEnabled?: boolean;
} = {}) {
  return render(
    <DriveModeDictate
      sessionId={WORKER}
      sdkType="pi"
      modelName="test-model"
      sessionDisplayName="Worker"
      onExit={vi.fn()}
      onAbort={vi.fn()}
      {...props}
    />
  );
}

beforeEach(() => {
  driveState.phase = 'dictate';
  sessionState.isStreaming = false;
  sessionState.messages = [];
  speechArbiter.stopAll();
});

afterEach(() => {
  resetTalkerTurnBus();
  speechArbiter.stopAll();
});

describe('DriveModeDictate — switch the worker in place', () => {
  it('offers no switch control when the surface is not given one', () => {
    renderSurface();
    expect(screen.queryByTestId('drive-switch-session')).toBeNull();
  });

  it('offers the switch control when the overlay provides the handler, and reports the tap', () => {
    const onSwitchSession = vi.fn();
    renderSurface({ onSwitchSession });
    const control = screen.getByTestId('drive-switch-session');
    expect(control).toBeInTheDocument();
    fireEvent.click(control);
    expect(onSwitchSession).toHaveBeenCalledTimes(1);
  });

  it('offers the control for a lane surface too', () => {
    renderSurface({ onSwitchSession: vi.fn(), laneEnabled: true });
    expect(screen.getByTestId('drive-switch-session')).toBeInTheDocument();
  });

  it('names what it does, as a visible action next to the worker it changes', () => {
    // Operator, 2026-09-16: the switcher must be findable, not inferred.
    renderSurface({ onSwitchSession: vi.fn() });
    const control = screen.getByTestId('drive-switch-session');
    expect(control.textContent?.trim()).toBe('Switch session');
    expect(control.getAttribute('title')).toMatch(/different worker session/i);
  });
});

describe('DriveModeDictate — the compact desktop variant', () => {
  it('is the same surface by default', () => {
    renderSurface();
    expect(screen.getByTestId('drive-mode-surface')).not.toHaveAttribute('data-compact', 'true');
  });

  it('marks the surface compact when the desktop arrangement asks for it', () => {
    renderSurface({ compact: true });
    expect(screen.getByTestId('drive-mode-surface')).toHaveAttribute('data-compact', 'true');
  });
});
