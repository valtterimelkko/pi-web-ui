import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MessageBubble } from '../../../../src/components/Chat/MessageBubble';
import { useSessionStore } from '../../../../src/store/sessionStore';

vi.mock('../../../../src/components/Chat/CodeBlock', () => ({
  CodeBlock: ({ children }: { children: React.ReactNode }) => <pre>{children}</pre>,
}));

function userMessage(text: string) {
  return {
    id: 'm1',
    role: 'user' as const,
    content: [{ type: 'text' as const, text }],
    timestamp: Date.now(),
  };
}

const CONTINUATION = 'Continue working toward the goal. Report progress, completed critical-review cycles, and whether the objective has been fully achieved.';

describe('MessageBubble goal-continuation labelling', () => {
  beforeEach(() => {
    useSessionStore.setState({
      isStreaming: false,
      currentSessionSdkType: 'pi',
    } as Partial<ReturnType<typeof useSessionStore.getState>>);
  });

  it('marks a goal-engine continuation prompt as auto-sent', () => {
    render(<MessageBubble message={userMessage(CONTINUATION) as never} isLast={false} />);

    expect(screen.getByTestId('goal-continuation-label').textContent).toMatch(/goal/i);
  });

  it('leaves an operator-written message unlabelled', () => {
    render(<MessageBubble message={userMessage('Continue please') as never} isLast={false} />);

    expect(screen.queryByTestId('goal-continuation-label')).toBeNull();
  });

  it('does not label anything on runtimes without a goal engine', () => {
    useSessionStore.setState({ currentSessionSdkType: 'claude' } as Partial<ReturnType<typeof useSessionStore.getState>>);
    render(<MessageBubble message={userMessage(CONTINUATION) as never} isLast={false} />);

    expect(screen.queryByTestId('goal-continuation-label')).toBeNull();
  });
});
