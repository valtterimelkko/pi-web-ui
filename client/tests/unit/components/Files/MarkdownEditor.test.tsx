import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MarkdownEditor } from '../../../../src/components/Files/MarkdownEditor';

// MarkdownEditor is a presentational (props-only) component — no store mock is
// needed. FilesTab wires it to the filesStore.
describe('MarkdownEditor', () => {
  const baseProps = {
    content: '',
    truncated: false,
    isDirty: false,
    isSaving: false,
    saveError: null as string | null,
    onChange: vi.fn(),
    onSave: vi.fn(),
    onRefresh: vi.fn(),
    onClose: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the textarea in edit mode showing the current content', () => {
    render(<MarkdownEditor {...baseProps} content="# Hello world" />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(textarea).toBeInTheDocument();
    expect(textarea.value).toBe('# Hello world');
  });

  it('toggles to a rendered GFM preview (table renders as HTML, not raw text)', () => {
    const table = '| a | b |\n| --- | --- |\n| 1 | 2 |\n';
    const { container } = render(<MarkdownEditor {...baseProps} content={table} />);

    // Edit mode: raw markdown, no rendered table yet.
    expect(container.querySelector('table')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /preview/i }));

    // Preview mode: GFM table is rendered as real HTML.
    expect(container.querySelector('table')).not.toBeNull();
    expect(container.querySelectorAll('td')).toHaveLength(2);
  });

  it('renders a rich GFM document in preview (headings, lists, code, link, quote, hr)', () => {
    const doc = [
      '# Heading 1',
      '## Heading 2',
      '### Heading 3',
      '#### Heading 4',
      '',
      'A paragraph with **bold** and a [link](https://example.com).',
      '',
      '- unordered item',
    '',
      '1. ordered item',
      '',
      '> a blockquote',
      '',
      '```js',
      'const x = 1;',
      '```',
      '',
      'inline `code` here.',
      '',
      '---',
      '',
      '| h1 | h2 |',
      '| --- | --- |',
      '| a | b |',
      '',
    ].join('\n');
    const { container } = render(<MarkdownEditor {...baseProps} content={doc} />);
    fireEvent.click(screen.getByRole('button', { name: /preview/i }));

    // Exercises every react-markdown component override.
    expect(container.querySelector('h1')).not.toBeNull();
    expect(container.querySelector('h2')).not.toBeNull();
    expect(container.querySelector('h3')).not.toBeNull();
    expect(container.querySelector('h4')).not.toBeNull();
    expect(container.querySelector('ul')).not.toBeNull();
    expect(container.querySelector('ol')).not.toBeNull();
    expect(container.querySelector('blockquote')).not.toBeNull();
    expect(container.querySelector('pre')).not.toBeNull();
    expect(container.querySelector('code')).not.toBeNull();
    expect(container.querySelector('hr')).not.toBeNull();
    expect(container.querySelector('table')).not.toBeNull();
    const link = container.querySelector('a');
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toBe('https://example.com');
  });

  it('disables Save when there are no unsaved changes', () => {
    render(<MarkdownEditor {...baseProps} isDirty={false} />);
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
  });

  it('disables Save while a save is in progress', () => {
    render(<MarkdownEditor {...baseProps} isDirty={true} isSaving={true} />);
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
  });

  it('enables Save when dirty and invokes onSave on click', () => {
    const onSave = vi.fn();
    render(<MarkdownEditor {...baseProps} isDirty={true} onSave={onSave} />);
    const saveBtn = screen.getByRole('button', { name: /save/i });
    expect(saveBtn).not.toBeDisabled();
    fireEvent.click(saveBtn);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('forwards textarea edits through onChange', () => {
    const onChange = vi.fn();
    render(<MarkdownEditor {...baseProps} content="start" onChange={onChange} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'start edited' } });
    expect(onChange).toHaveBeenCalledWith('start edited');
  });

  it('prompts before closing when there are unsaved changes', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onClose = vi.fn();
    render(<MarkdownEditor {...baseProps} isDirty={true} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringMatching(/unsaved/i));
    expect(onClose).toHaveBeenCalledTimes(1);
    confirmSpy.mockRestore();
  });

  it('does not close when the unsaved-changes prompt is cancelled', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const onClose = vi.fn();
    render(<MarkdownEditor {...baseProps} isDirty={true} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(onClose).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('closes without prompting when there are no unsaved changes', () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    const onClose = vi.fn();
    render(<MarkdownEditor {...baseProps} isDirty={false} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    confirmSpy.mockRestore();
  });

  it('invokes onRefresh when the refresh button is clicked', () => {
    const onRefresh = vi.fn();
    render(<MarkdownEditor {...baseProps} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('shows a read-only notice and no editor for a truncated file', () => {
    const { container } = render(
      <MarkdownEditor {...baseProps} truncated={true} totalSize={300_000} />,
    );
    expect(container.querySelector('textarea')).toBeNull();
    expect(screen.getByText(/too large/i)).toBeInTheDocument();
  });
});
