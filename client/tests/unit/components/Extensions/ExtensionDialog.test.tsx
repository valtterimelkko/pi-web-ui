import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ExtensionDialog, type ExtensionUIRequest } from '../../../../src/components/Extensions/ExtensionDialog';

describe('ExtensionDialog — ask_user_question delegation', () => {
  function makeAskRequest(): ExtensionUIRequest {
    return {
      id: 'req-1',
      type: 'ask_user_question',
      method: 'claude.askUserQuestion',
      params: {
        toolCallId: 'toolu_1',
        questions: [
          {
            question: 'Pick a colour?',
            header: 'Colour',
            multiSelect: false,
            options: [
              { label: 'Red', description: 'r' },
              { label: 'Blue', description: 'b' },
            ],
          },
        ],
      },
      timeout: 300000,
    };
  }

  it('renders the AskUserQuestion dialog and returns approved + structured value on submit', () => {
    const onResponse = vi.fn();
    render(<ExtensionDialog request={makeAskRequest()} onResponse={onResponse} />);

    fireEvent.click(screen.getByText('Blue'));
    fireEvent.click(screen.getByRole('button', { name: /^submit$/i }));

    expect(onResponse).toHaveBeenCalledWith({
      id: 'req-1',
      approved: true,
      value: { answers: { 'Pick a colour?': 'Blue' } },
    });
  });

  it('returns cancelled on cancel', () => {
    const onResponse = vi.fn();
    render(<ExtensionDialog request={makeAskRequest()} onResponse={onResponse} />);

    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

    expect(onResponse).toHaveBeenCalledWith({ id: 'req-1', cancelled: true });
  });

  it('still renders the legacy confirm dialog for non-ask request types', () => {
    const onResponse = vi.fn();
    const request: ExtensionUIRequest = {
      id: 'req-2',
      type: 'confirm',
      method: 'claude.permission.Bash',
      params: { title: 'Allow Bash?', description: 'Claude wants to use Bash' },
      timeout: 120000,
    };
    render(<ExtensionDialog request={request} onResponse={onResponse} />);

    // Legacy confirm renders Yes/No buttons.
    expect(screen.getByRole('button', { name: /^yes$/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^yes$/i }));
    expect(onResponse).toHaveBeenCalledWith(expect.objectContaining({ id: 'req-2', approved: true }));
  });
});
