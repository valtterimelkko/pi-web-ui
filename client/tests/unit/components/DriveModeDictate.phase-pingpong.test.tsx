import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DriveModeDictate } from '../../../src/components/DriveMode/DriveModeDictate.js';
import { useDriveModeStore } from '../../../src/store/driveModeStore.js';
import { useSessionStore, type Message } from '../../../src/store/sessionStore.js';

// Native-primary (Phase 2): these pins exercise the CASCADE phase writer,
// which now runs only while the explicit fallback is engaged (native lane
// stubbed unavailable; the render helper engages the fallback).
vi.mock('../../../src/hooks/useVoiceLiveLane.js', async () => {
  const { useVoiceLiveLaneStubModule } = await import('../../helpers/nativeLaneStub');
  return useVoiceLiveLaneStubModule();
});
import { activateCascadeFallback } from '../../helpers/nativeLaneStub';

/**
 * P13 Phase 3 — the barge-in crash, reproduced at the unit level.
 *
 * Root cause (named from a live reproduction, evidence in
 * /tmp/p13-evidence-repro5 + docs/OBSERVABILITY.md § Client error reports):
 * two DriveModeDictate phase-sync effects write the SAME driveModeStore
 * field with conflicting unconditional targets while `phase` sits in BOTH
 * effects' dependency arrays. When the operator barges in (dictation
 * 'recording') while the worker is streaming (`isStreaming`), effect A
 * demands 'dictate', effect B demands 'agent-working', and each write
 * re-fires the other — unbounded nested updates. React aborts with error
 * #185 ("Maximum update depth exceeded") and the app-level error boundary
 * replaces the whole voice surface: the operator's "full error" on screen.
 *
 * The regression pin renders the surface in exactly that state; the
 * precedence pin resolves the intended transitions with ONE writer:
 * capture (recording/processing) > worker streaming > read-aloud handback.
 */

const dictationState: { state: 'idle' | 'recording' | 'processing' | 'error' } = { state: 'recording' };

vi.mock('../../../src/hooks/useWebSocket.js', () => ({
  useWebSocket: () => ({
    sendMessage: vi.fn(() => 'sent' as const),
    sendPrompt: vi.fn(() => 'sent' as const),
  }),
}));

vi.mock('../../../src/hooks/useDictation.js', () => ({
  useDictation: () => ({
    state: dictationState.state,
    errorMessage: '',
    toggle: vi.fn(),
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
  }),
}));

const messages: Message[] = [
  { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'A verbose worker answer about photosynthesis.' }], ts: Date.now() },
] as unknown as Message[];

function renderSurface(): ReturnType<typeof render> {
  const rendered = render(
    <DriveModeDictate
      sessionId="test-session"
      sdkType="pi"
      modelName="Test model"
      sessionDisplayName="Test session"
      onExit={() => {}}
      onAbort={() => {}}
    />,
  );
  activateCascadeFallback();
  return rendered;
}

describe('DriveModeDictate phase bookkeeping (P13 barge-in crash)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    dictationState.state = 'recording';
    useDriveModeStore.setState({ phase: 'dictate' });
    useSessionStore.setState({ isStreaming: true, messages, currentSessionId: 'test-session' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useSessionStore.setState({ isStreaming: false, messages: [] });
  });

  it('does not ping-pong setPhase when the operator barges in while the worker streams', () => {
    // Buggy behaviour threw synchronously here: React error #185 —
    // Maximum update depth exceeded — from the effects flush.
    expect(() => renderSurface()).not.toThrow();
    // Capture outranks streaming: with both true, the surface settles on
    // 'dictate' instead of oscillating.
    expect(useDriveModeStore.getState().phase).toBe('dictate');
  });

  it('resolves the phase with one writer: capture > streaming > read-aloud handback', () => {
    const { rerender } = renderSurface();
    expect(useDriveModeStore.getState().phase).toBe('dictate');

    // Recording ends while the worker still streams → agent-working.
    dictationState.state = 'idle';
    act(() => { rerender(
      <DriveModeDictate
        sessionId="test-session"
        sdkType="pi"
        modelName="Test model"
        sessionDisplayName="Test session"
        onExit={() => {}}
        onAbort={() => {}}
      />,
    ); });
    expect(useDriveModeStore.getState().phase).toBe('agent-working');

    // The worker finishes too → the answer hands back to capture-ready.
    act(() => { useSessionStore.setState({ isStreaming: false }); });
    act(() => { rerender(
      <DriveModeDictate
        sessionId="test-session"
        sdkType="pi"
        modelName="Test model"
        sessionDisplayName="Test session"
        onExit={() => {}}
        onAbort={() => {}}
      />,
    ); });
    expect(useDriveModeStore.getState().phase).toBe('read-aloud-ready');
  });
});
