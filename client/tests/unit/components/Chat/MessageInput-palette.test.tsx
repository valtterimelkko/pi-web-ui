import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MessageInput } from '../../../../src/components/Chat/MessageInput';
import { useSessionStore } from '../../../../src/store/sessionStore';
import { useDraftStore } from '../../../../src/store/draftStore';

vi.mock('../../../../src/hooks/useWebSocket', () => ({
  useWebSocket: () => ({ sendPrompt: vi.fn(), abortGeneration: vi.fn(), compactSession: vi.fn() }),
}));
vi.mock('../../../../src/components/Chat/SlashPalette', () => ({
  SlashPalette: () => <div data-testid="slash-palette" />,
}));
vi.mock('../../../../src/lib/api', () => ({ uploadFile: vi.fn() }));

describe('MessageInput slash palette', () => {
  beforeEach(() => {
    useDraftStore.setState({ drafts: {}, currentDraft: '' } as Partial<ReturnType<typeof useDraftStore.getState>>);
    useSessionStore.setState({
      currentSessionId: 'session-1',
      currentSessionSdkType: 'pi',
      isStreaming: false,
      contextPercent: 18.044086021505375,
      contextUsageEstimated: false,
      messages: [],
    } as Partial<ReturnType<typeof useSessionStore.getState>>);
  });

  it('opens while the command name is being typed', () => {
    render(<MessageInput />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '/goal' } });

    expect(screen.getByTestId('slash-palette')).toBeTruthy();
  });

  it('closes as soon as arguments follow the command', () => {
    render(<MessageInput />);
    const textarea = screen.getByRole('textbox');

    fireEvent.change(textarea, { target: { value: '/goal' } });
    expect(screen.getByTestId('slash-palette')).toBeTruthy();

    fireEvent.change(textarea, { target: { value: '/goal report' } });
    expect(screen.queryByTestId('slash-palette')).toBeNull();
  });

  it('stays closed for ordinary prose', () => {
    render(<MessageInput />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hello there' } });

    expect(screen.queryByTestId('slash-palette')).toBeNull();
  });

  it('renders the context meter as a whole number', () => {
    render(<MessageInput />);
    expect(screen.getByText('18%')).toBeTruthy();
  });
});
