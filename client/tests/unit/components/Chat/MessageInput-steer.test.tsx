import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MessageInput } from '../../../../src/components/Chat/MessageInput';
import { useSessionStore } from '../../../../src/store/sessionStore';
import { useDraftStore } from '../../../../src/store/draftStore';

const sendPromptMock = vi.fn();
const sendSteerMock = vi.fn();
const sendFollowUpMock = vi.fn();
const abortGenerationMock = vi.fn();

vi.mock('../../../../src/hooks/useWebSocket', () => ({
  useWebSocket: () => ({
    sendPrompt: sendPromptMock,
    sendSteer: sendSteerMock,
    sendFollowUp: sendFollowUpMock,
    abortGeneration: abortGenerationMock,
    compactSession: vi.fn(),
  }),
}));
vi.mock('../../../../src/components/Chat/SlashPalette', () => ({
  SlashPalette: () => <div data-testid="slash-palette" />,
}));
vi.mock('../../../../src/lib/api', () => ({ uploadFile: vi.fn() }));

function setStore(overrides: Record<string, unknown> = {}) {
  useSessionStore.setState({
    currentSessionId: 'session-1',
    currentSessionSdkType: 'pi',
    isStreaming: false,
    contextPercent: 10,
    contextUsageEstimated: false,
    messages: [],
    ...overrides,
  } as Partial<ReturnType<typeof useSessionStore.getState>>);
  useDraftStore.setState({ drafts: {}, currentDraft: '' } as Partial<ReturnType<typeof useDraftStore.getState>>);
}

describe('MessageInput streaming steer UX (Pi sessions)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendSteerMock.mockReturnValue(true);
    sendFollowUpMock.mockReturnValue(true);
    setStore();
  });

  it('shows the Steer/After toggle only while a Pi session is streaming', () => {
    const { rerender } = render(<MessageInput />);
    expect(screen.queryByRole('button', { name: /steer/i })).toBeNull();

    setStore({ isStreaming: true });
    rerender(<MessageInput />);
    expect(screen.getByRole('button', { name: /^steer$/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^after$/i })).toBeTruthy();
  });

  it('does not show the toggle for non-Pi streaming sessions', () => {
    setStore({ isStreaming: true, currentSessionSdkType: 'opencode' });
    render(<MessageInput />);
    expect(screen.queryByRole('button', { name: /^steer$/i })).toBeNull();
  });

  it('sends free text via sendSteer while streaming and queues a chip', () => {
    setStore({ isStreaming: true });
    render(<MessageInput />);
    const textarea = screen.getByRole('textbox');

    fireEvent.change(textarea, { target: { value: 'focus on error handling' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(sendSteerMock).toHaveBeenCalledWith('focus on error handling');
    expect(sendPromptMock).not.toHaveBeenCalled();
    // Draft cleared after a successful send
    expect(useDraftStore.getState().currentDraft).toBe('');
    // Queued chip is visible until delivered
    expect(screen.getByText(/focus on error handling/)).toBeTruthy();
  });

  it('sends via sendFollowUp when the After mode is selected', () => {
    setStore({ isStreaming: true });
    render(<MessageInput />);
    const textarea = screen.getByRole('textbox');

    fireEvent.click(screen.getByRole('button', { name: /^after$/i }));
    fireEvent.change(textarea, { target: { value: 'then summarise' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(sendFollowUpMock).toHaveBeenCalledWith('then summarise');
    expect(sendSteerMock).not.toHaveBeenCalled();
  });

  it('Alt+Enter forces a follow-up regardless of the selected mode', () => {
    setStore({ isStreaming: true });
    render(<MessageInput />);
    const textarea = screen.getByRole('textbox');

    fireEvent.change(textarea, { target: { value: 'afterwards: run tests' } });
    fireEvent.keyDown(textarea, { key: 'Enter', altKey: true });

    expect(sendFollowUpMock).toHaveBeenCalledWith('afterwards: run tests');
    expect(sendSteerMock).not.toHaveBeenCalled();
  });

  it('keeps slash commands on the regular prompt path while streaming', () => {
    setStore({ isStreaming: true });
    render(<MessageInput />);
    const textarea = screen.getByRole('textbox');

    fireEvent.change(textarea, { target: { value: '/goal pause-now' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(sendSteerMock).not.toHaveBeenCalled();
    expect(sendFollowUpMock).not.toHaveBeenCalled();
    // goes through the draft-store send callback -> sendPrompt
    expect(sendPromptMock).toHaveBeenCalledWith('/goal pause-now', [], undefined);
  });

  it('shows Send alongside Stop while streaming with text ready', () => {
    setStore({ isStreaming: true });
    render(<MessageInput />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'steer this' } });

    expect(screen.getByTitle(/stop generation/i)).toBeTruthy();
    expect(screen.getByTitle(/send/i)).toBeTruthy();
  });

  it('keeps Stop-only for streaming sessions that cannot steer', () => {
    setStore({ isStreaming: true, currentSessionSdkType: 'claude' });
    render(<MessageInput />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'cannot steer' } });

    expect(screen.getByTitle(/stop generation/i)).toBeTruthy();
    expect(screen.queryByTitle(/send/i)).toBeNull();
  });

  it('clears a delivered steer chip when the matching user message reaches the transcript', async () => {
    setStore({ isStreaming: true });
    const { rerender } = render(<MessageInput />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'chip message' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(screen.getByText(/chip message/)).toBeTruthy();

    setStore({
      messages: [
        { id: 'm1', role: 'user', content: 'chip message', timestamp: Date.now(), isComplete: true },
      ] as never,
    });
    rerender(<MessageInput />);

    await waitFor(() => {
      expect(screen.queryByText(/chip message/)).toBeNull();
    });
  });

  it('aborts when Stop is clicked while streaming', () => {
    setStore({ isStreaming: true });
    render(<MessageInput />);
    fireEvent.click(screen.getByTitle(/stop generation/i));
    expect(abortGenerationMock).toHaveBeenCalled();
  });
});
