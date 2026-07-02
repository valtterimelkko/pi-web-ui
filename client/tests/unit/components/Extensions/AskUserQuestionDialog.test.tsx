import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  AskUserQuestionDialog,
  type AskUserQuestion,
} from '../../../../src/components/Extensions/AskUserQuestionDialog';

describe('AskUserQuestionDialog', () => {
  let onSubmit: ReturnType<typeof vi.fn>;
  let onCancel: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onSubmit = vi.fn();
    onCancel = vi.fn();
  });

  it('single-select: submit disabled until an option is chosen, then returns the label', () => {
    const questions: AskUserQuestion[] = [
      {
        question: 'Which library?',
        header: 'Library',
        multiSelect: false,
        options: [
          { label: 'A', description: 'option a' },
          { label: 'B', description: 'option b' },
        ],
      },
    ];

    render(<AskUserQuestionDialog questions={questions} onSubmit={onSubmit} onCancel={onCancel} />);

    const submit = screen.getByRole('button', { name: /^submit$/i });
    expect(submit).toBeDisabled();

    fireEvent.click(screen.getByText('B'));
    expect(submit).not.toBeDisabled();

    fireEvent.click(submit);
    expect(onSubmit).toHaveBeenCalledWith({
      answers: { 'Which library?': 'B' },
    });
  });

  it('multiple questions: submit disabled until all are answered, keyed by exact question text', () => {
    const questions: AskUserQuestion[] = [
      {
        question: 'Pick a colour?',
        header: 'Colour',
        multiSelect: false,
        options: [{ label: 'Red', description: 'r' }, { label: 'Blue', description: 'b' }],
      },
      {
        question: 'Pick a size?',
        header: 'Size',
        multiSelect: false,
        options: [{ label: 'Small', description: 's' }, { label: 'Large', description: 'l' }],
      },
      {
        question: 'Pick a shape?',
        header: 'Shape',
        multiSelect: false,
        options: [{ label: 'Circle', description: 'c' }, { label: 'Square', description: 'sq' }],
      },
    ];

    render(<AskUserQuestionDialog questions={questions} onSubmit={onSubmit} onCancel={onCancel} />);
    const submit = screen.getByRole('button', { name: /^submit$/i });
    expect(submit).toBeDisabled();

    fireEvent.click(screen.getByText('Blue'));
    expect(submit).toBeDisabled(); // only 1 of 3

    fireEvent.click(screen.getByText('Large'));
    expect(submit).toBeDisabled(); // only 2 of 3

    fireEvent.click(screen.getByText('Square'));
    expect(submit).not.toBeDisabled();

    fireEvent.click(submit);
    expect(onSubmit).toHaveBeenCalledWith({
      answers: {
        'Pick a colour?': 'Blue',
        'Pick a size?': 'Large',
        'Pick a shape?': 'Square',
      },
    });
  });

  it('multi-select: returns a comma-separated list of selected labels', () => {
    const questions: AskUserQuestion[] = [
      {
        question: 'Which features?',
        header: 'Features',
        multiSelect: true,
        options: [
          { label: 'A', description: 'a' },
          { label: 'B', description: 'b' },
          { label: 'C', description: 'c' },
        ],
      },
    ];

    render(<AskUserQuestionDialog questions={questions} onSubmit={onSubmit} onCancel={onCancel} />);
    fireEvent.click(screen.getByText('A'));
    fireEvent.click(screen.getByText('C'));
    fireEvent.click(screen.getByRole('button', { name: /^submit$/i }));

    expect(onSubmit).toHaveBeenCalledWith({
      answers: { 'Which features?': 'A, C' },
    });
  });

  it('cancel: calls onCancel and does not submit', () => {
    const questions: AskUserQuestion[] = [
      {
        question: 'Q?',
        header: 'H',
        multiSelect: false,
        options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }],
      },
    ];

    render(<AskUserQuestionDialog questions={questions} onSubmit={onSubmit} onCancel={onCancel} />);
    fireEvent.click(screen.getByText('A'));
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

    expect(onCancel).toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('freeform "Other" text overrides the structured selection', () => {
    const questions: AskUserQuestion[] = [
      {
        question: 'Which framework?',
        header: 'FW',
        multiSelect: false,
        options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }],
      },
    ];

    render(<AskUserQuestionDialog questions={questions} onSubmit={onSubmit} onCancel={onCancel} />);
    fireEvent.click(screen.getByText('A'));

    const other = screen.getByPlaceholderText(/other/i);
    fireEvent.change(other, { target: { value: 'Svelte' } });
    fireEvent.click(screen.getByRole('button', { name: /^submit$/i }));

    expect(onSubmit).toHaveBeenCalledWith({
      answers: { 'Which framework?': 'Svelte' },
    });
  });

  it('includes per-question notes as annotations when provided', () => {
    const questions: AskUserQuestion[] = [
      {
        question: 'Which framework?',
        header: 'FW',
        multiSelect: false,
        options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }],
      },
    ];

    render(<AskUserQuestionDialog questions={questions} onSubmit={onSubmit} onCancel={onCancel} />);
    fireEvent.click(screen.getByText('B'));

    const notes = screen.getByPlaceholderText(/notes/i);
    fireEvent.change(notes, { target: { value: 'prefer morning slot' } });
    fireEvent.click(screen.getByRole('button', { name: /^submit$/i }));

    expect(onSubmit).toHaveBeenCalledWith({
      answers: { 'Which framework?': 'B' },
      annotations: { 'Which framework?': { notes: 'prefer morning slot' } },
    });
  });

  it('omits annotations when no notes are entered', () => {
    const questions: AskUserQuestion[] = [
      {
        question: 'Q?',
        header: 'H',
        multiSelect: false,
        options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }],
      },
    ];

    render(<AskUserQuestionDialog questions={questions} onSubmit={onSubmit} onCancel={onCancel} />);
    fireEvent.click(screen.getByText('A'));
    fireEvent.click(screen.getByRole('button', { name: /^submit$/i }));

    expect(onSubmit).toHaveBeenCalledWith({ answers: { 'Q?': 'A' } });
  });

  it('renders an accessible modal (role=dialog, aria-modal) with a scrollable content region', () => {
    const questions: AskUserQuestion[] = [
      {
        question: 'Q?',
        header: 'H',
        multiSelect: false,
        options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }],
      },
    ];
    const { container } = render(
      <AskUserQuestionDialog questions={questions} onSubmit={onSubmit} onCancel={onCancel} />,
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');

    // Tall content scrolls internally instead of overflowing the viewport…
    expect(container.querySelector('[class*="overflow-y-auto"]')).not.toBeNull();
    // …and the panel is height- + width-constrained so it stays usable on narrow screens.
    expect(container.querySelector('[class*="max-h-"]')).not.toBeNull();
    expect(container.querySelector('[class*="max-w-lg"]')).not.toBeNull();
  });

  it('exposes option controls as focusable buttons with an aria-pressed state', () => {
    const questions: AskUserQuestion[] = [
      {
        question: 'Q?',
        header: 'H',
        multiSelect: false,
        options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }],
      },
    ];
    const { container } = render(
      <AskUserQuestionDialog questions={questions} onSubmit={onSubmit} onCancel={onCancel} />,
    );

    const optionButtons = container.querySelectorAll('button[aria-pressed]');
    expect(optionButtons).toHaveLength(2);
    expect(Array.from(optionButtons).every((b) => b.tagName === 'BUTTON')).toBe(true);

    // Native <button>s are keyboard-focusable and browser-activated by Enter/Space.
    const first = optionButtons[0] as HTMLButtonElement;
    first.focus();
    expect(first).toHaveFocus();
    expect(first).toHaveAttribute('aria-pressed', 'false');
  });

  it('does not execute raw HTML in preview content (rendered as escaped text)', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const questions: AskUserQuestion[] = [
      {
        question: 'Pick one?',
        header: 'H',
        multiSelect: false,
        options: [
          { label: 'A', description: 'a', preview: evil },
          { label: 'B', description: 'b' },
        ],
      },
    ];

    const { container } = render(
      <AskUserQuestionDialog questions={questions} onSubmit={onSubmit} onCancel={onCancel} />,
    );
    // Selecting A surfaces its preview.
    fireEvent.click(screen.getByText('A'));

    // No real <img>/executable node is created from the preview string.
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[onerror]')).toBeNull();
    // The raw markup is shown as inert, escaped text.
    expect(screen.getByText(/onerror=alert\(1\)/)).toBeInTheDocument();
  });

  // ── Near-expiry deadline warning (§8.2) ─────────────────────────────────────

  it('shows a near-expiry warning only when under 60 seconds remain', () => {
    vi.useFakeTimers({ now: 1_000_000 });
    try {
      const questions: AskUserQuestion[] = [
        { question: 'Q?', header: 'H', multiSelect: false, options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }] },
      ];

      // 5 minutes remain — no warning.
      const { rerender } = render(
        <AskUserQuestionDialog questions={questions} onSubmit={onSubmit} onCancel={onCancel} expiresAt={1_000_000 + 5 * 60_000} />,
      );
      expect(screen.queryByRole('status')).toBeNull();

      // 30 seconds remain — warning appears.
      rerender(
        <AskUserQuestionDialog questions={questions} onSubmit={onSubmit} onCancel={onCancel} expiresAt={1_000_000 + 30_000} />,
      );
      const warning = screen.getByRole('status');
      expect(warning.textContent).toMatch(/expire|closing|seconds/i);

      // Submit still works normally while not expired.
      fireEvent.click(screen.getByText('A'));
      fireEvent.click(screen.getByRole('button', { name: /^submit$/i }));
      expect(onSubmit).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  // ── Expired state (§8.3) ────────────────────────────────────────────────────

  it('expired state shows an explanatory message, preserves the draft, and dismisses instead of submitting', () => {
    const onDismissExpired = vi.fn();
    const questions: AskUserQuestion[] = [
      { question: 'Pick a colour?', header: 'Colour', multiSelect: false, options: [{ label: 'Red', description: 'r' }, { label: 'Blue', description: 'b' }] },
    ];

    const { rerender } = render(
      <AskUserQuestionDialog questions={questions} onSubmit={onSubmit} onCancel={onCancel} />,
    );
    fireEvent.click(screen.getByText('Blue')); // create a draft selection

    // Server signals the dialog closed mid-answer.
    rerender(
      <AskUserQuestionDialog
        questions={questions}
        onSubmit={onSubmit}
        onCancel={onCancel}
        expired
        expiredReason="timeout"
        onDismissExpired={onDismissExpired}
      />,
    );

    expect(screen.getByText(/expired|moved on|closed/i)).toBeInTheDocument();
    // Draft preserved: the selected option label is still visible.
    expect(screen.getByText('Blue')).toBeInTheDocument();
    // No submit path in the expired state.
    expect(screen.queryByRole('button', { name: /^submit$/i })).toBeNull();
    // Explicit dismiss.
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(onDismissExpired).toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
