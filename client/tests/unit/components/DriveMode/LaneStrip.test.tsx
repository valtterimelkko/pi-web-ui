import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { LaneStrip } from '../../../../src/components/DriveMode/LaneStrip';
import { laneFloor } from '../../../../src/components/DriveMode/voiceLanes';
import { speechArbiter, type ArbiterPlayer } from '../../../../src/lib/speechArbiter';
import { useSessionStore } from '../../../../src/store/sessionStore';

/**
 * The lane strip (multi-lane work, 2026-09-15; MULTILANE-DESIGN §4.2).
 *
 * ONE tab holds the lanes. The strip is the primary control: it shows each
 * lane's state at a glance (the same four floor states the single-lane
 * banner shows), which lane is audible, and it switches the addressed worker
 * with one tap. The cap is always visible ("2 of 3"). With fewer than two
 * lanes it renders NOTHING — the strip collapses to the shipped banner.
 */

const A = '/pi/worker-a.jsonl';
const B = '/pi/worker-b.jsonl';
const C = '/pi/worker-c.jsonl';

function makeBlockedPlayer(): ArbiterPlayer {
  return {
    playChunk: () => new Promise<void>(() => {}),
    setVolume: () => {},
    stopCurrent: () => {},
  };
}

const onAddress = vi.fn();
const onAdd = vi.fn();
const onRemove = vi.fn();

function renderStrip(over?: {
  lanes?: Array<{ sessionId: string }>;
  addressed?: string | null;
  labels?: Record<string, string>;
}) {
  const lanes = over?.lanes ?? [{ sessionId: A }, { sessionId: B }];
  return render(
    <LaneStrip
      lanes={lanes}
      addressedSessionId={over?.addressed ?? A}
      labels={over?.labels ?? { [A]: 'Worker A', [B]: 'Worker B', [C]: 'Worker C' }}
      onAddress={onAddress}
      onAdd={onAdd}
      onRemove={onRemove}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  speechArbiter.stopAll();
  speechArbiter.attachPlayer(makeBlockedPlayer());
  laneFloor.dispose();
  useSessionStore.setState({ streamingSessions: {} });
});

afterEach(() => {
  laneFloor.dispose();
  speechArbiter.stopAll();
});

describe('LaneStrip — the strip collapses when it is not needed', () => {
  it('renders nothing for a single lane (the shipped surface, unchanged)', () => {
    const { container } = renderStrip({ lanes: [{ sessionId: A }] });
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for an empty lane set', () => {
    const { container } = renderStrip({ lanes: [] });
    expect(container).toBeEmptyDOMElement();
  });
});

describe('LaneStrip — seeing the lanes', () => {
  it('shows one row per lane with the session display name and the cap counter', () => {
    renderStrip();
    expect(screen.getAllByTestId('lane-row')).toHaveLength(2);
    expect(screen.getByTestId('lane-cap')).toHaveTextContent('2 of 3');
    expect(screen.getByText('Worker A')).toBeInTheDocument();
    expect(screen.getByText('Worker B')).toBeInTheDocument();
  });

  it('marks the addressed lane', () => {
    renderStrip({ addressed: B });
    const rows = screen.getAllByTestId('lane-row');
    const rowB = rows.find((row) => row.dataset.laneSession === B);
    expect(rowB?.getAttribute('aria-current')).toBe('true');
  });

  it('the capturing lane reads "You have the floor"; the others announce it', () => {
    laneFloor.registerLane(A);
    laneFloor.registerLane(B);
    act(() => {
      laneFloor.setLaneCapture(A, true);
    });
    renderStrip();
    const rows = screen.getAllByTestId('lane-row');
    const rowA = rows.find((row) => row.dataset.laneSession === A);
    const rowB = rows.find((row) => row.dataset.laneSession === B);
    expect(rowA?.querySelector('[data-testid="lane-state-label"]')?.textContent).toMatch(/you have the floor/i);
    // §4.4 rule 4 — the OTHER lanes announce that the floor is held elsewhere.
    expect(rowB?.querySelector('[data-testid="lane-floor-marker"]')?.textContent).toMatch(/Worker A has the floor/i);
  });

  it('the speaking lane reads "Speaking"; a working lane reads "Working silently"', () => {
    laneFloor.registerLane(A);
    laneFloor.registerLane(B);
    act(() => {
      speechArbiter.submit({ id: `receipt-${B}`, tier: 2, text: 'Noted.' });
    });
    useSessionStore.setState({ streamingSessions: { [A]: true } });
    renderStrip();
    const rows = screen.getAllByTestId('lane-row');
    const rowA = rows.find((row) => row.dataset.laneSession === A);
    const rowB = rows.find((row) => row.dataset.laneSession === B);
    expect(rowB?.querySelector('[data-testid="lane-state-label"]')?.textContent).toMatch(/speaking/i);
    expect(rowA?.querySelector('[data-testid="lane-state-label"]')?.textContent).toMatch(/working silently/i);
  });

  it('a lane whose answer is queued behind another lane reads "Waiting to speak"', () => {
    laneFloor.registerLane(A);
    laneFloor.registerLane(B);
    // B is speaking; A's answer queues behind it (shared arbiter, same tier).
    act(() => {
      speechArbiter.submit({ id: `answer-${B}`, tier: 3, text: 'B speaks first.' });
      speechArbiter.submit({ id: `answer-${A}`, tier: 3, text: 'A waits its turn.' });
    });
    renderStrip();
    const rows = screen.getAllByTestId('lane-row');
    const rowA = rows.find((row) => row.dataset.laneSession === A);
    expect(rowA?.querySelector('[data-testid="lane-state-label"]')?.textContent).toMatch(/waiting to speak/i);
  });
});

describe('LaneStrip — switching, adding, closing', () => {
  it('one tap on a row addresses that worker', () => {
    renderStrip();
    const rows = screen.getAllByTestId('lane-row');
    fireEvent.click(rows[1]);
    expect(onAddress).toHaveBeenCalledWith(B);
  });

  it('the add control asks the overlay for a new lane while under the cap', () => {
    renderStrip();
    fireEvent.click(screen.getByRole('button', { name: /add a lane/i }));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it('a lane can be closed from its row', () => {
    renderStrip();
    fireEvent.click(screen.getByRole('button', { name: /close lane worker b/i }));
    expect(onRemove).toHaveBeenCalledWith(B);
  });
});
