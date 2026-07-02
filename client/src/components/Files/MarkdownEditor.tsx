import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { X, Save, RefreshCw, AlertCircle } from 'lucide-react';

/**
 * MarkdownEditor — a Markdown *source* editor with a toggleable GitHub-flavored
 * live preview, for the Files tab. Deliberately small: plain `<textarea>`,
 * explicit Save, manual Refresh, no autosave, no rich-text library.
 *
 * This is a presentational (props-only) component. FilesTab wires it to the
 * filesStore (content/editBuffer, save/refresh/close handlers, dirty guard for
 * navigation). GFM rendering mirrors `MessageBubble.tsx` so the preview looks
 * consistent with chat; no raw-HTML passthrough (`rehype-raw`) is used — GFM
 * only, to keep the XSS surface unchanged.
 */
interface MarkdownEditorProps {
  /** Current text shown in both the source textarea and the live preview. */
  content: string;
  /** True when the file was loaded truncated → editor is read-only. */
  truncated: boolean;
  totalSize?: number;
  fileName?: string;
  isDirty: boolean;
  isSaving: boolean;
  saveError: string | null;
  onChange: (next: string) => void;
  onSave: () => void;
  onRefresh: () => void;
  onClose: () => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

export function MarkdownEditor({
  content,
  truncated,
  totalSize,
  fileName,
  isDirty,
  isSaving,
  saveError,
  onChange,
  onSave,
  onRefresh,
  onClose,
}: MarkdownEditorProps) {
  const [view, setView] = useState<'edit' | 'preview'>('edit');

  const handleClose = () => {
    // Unsaved-changes guard before closing the editor.
    if (isDirty && !window.confirm('Discard unsaved changes?')) return;
    onClose();
  };

  // CRITICAL safety: a file loaded truncated must never be editable here —
  // saving a partial copy over the full file would silently lose data.
  if (truncated) {
    return (
      <div
        role="dialog"
        aria-label={`Read-only preview of ${fileName ?? 'file'}`}
        className="fixed inset-0 z-50 flex flex-col bg-white dark:bg-gray-950"
      >
        <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200 dark:border-gray-800 flex-shrink-0">
          <span className="text-xs text-gray-500 truncate">{fileName ?? 'Preview'}</span>
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
            aria-label="Close editor"
            title="Close"
          >
            <X size={16} />
          </button>
        </div>
        <div className="flex items-start gap-2 px-3 py-2 bg-amber-50 dark:bg-amber-950/40 border-b border-amber-200 dark:border-amber-800 flex-shrink-0">
          <AlertCircle size={14} className="text-amber-500 flex-shrink-0 mt-0.5" />
          <div className="text-xs text-amber-700 dark:text-amber-400">
            <p className="font-medium">This file is too large to edit safely here.</p>
            <p className="mt-0.5 text-amber-600 dark:text-amber-500">
              Only part of it was loaded
              {totalSize ? ` (${formatSize(totalSize)} on disk)` : ''}, so editing is disabled to
              avoid overwriting the full file with a partial copy. It is shown read-only below.
            </p>
          </div>
        </div>
        <div className="flex-1 overflow-auto p-3">
          <pre className="text-xs font-mono text-gray-700 dark:text-gray-300 whitespace-pre-wrap break-all">
            {content}
          </pre>
        </div>
      </div>
    );
  }

  // Save is blocked when clean or while a save is in flight.
  const saveDisabled = !isDirty || isSaving;

  return (
    <div
      role="dialog"
      aria-label={`Edit ${fileName ?? 'file'}`}
      className="fixed inset-0 z-50 flex flex-col bg-white dark:bg-gray-950"
    >
      {/* Toolbar */}
      <div className="flex items-center gap-1 px-2 py-2 border-b border-gray-200 dark:border-gray-800 flex-shrink-0">
        {/* Edit ⇄ Preview toggle */}
        <div className="flex bg-gray-100 dark:bg-gray-800 rounded-md p-0.5">
          <button
            type="button"
            onClick={() => setView('edit')}
            aria-pressed={view === 'edit'}
            className={`px-2 py-1 text-xs rounded transition-colors ${
              view === 'edit'
                ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm'
                : 'text-gray-500 dark:text-gray-400'
            }`}
          >
            Edit
          </button>
          <button
            type="button"
            onClick={() => setView('preview')}
            aria-pressed={view === 'preview'}
            className={`px-2 py-1 text-xs rounded transition-colors ${
              view === 'preview'
                ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm'
                : 'text-gray-500 dark:text-gray-400'
            }`}
          >
            Preview
          </button>
        </div>

        {isDirty && (
          <span className="ml-1 text-[10px] font-medium text-amber-600 dark:text-amber-400 bg-amber-100 dark:bg-amber-900/40 px-1.5 py-0.5 rounded">
            Unsaved
          </span>
        )}

        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={onRefresh}
            disabled={isSaving}
            className="flex items-center gap-1 px-2 py-1 text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 disabled:opacity-40"
            title="Refresh from disk"
            aria-label="Refresh"
          >
            <RefreshCw size={14} className={isSaving ? 'animate-spin' : ''} />
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={saveDisabled}
            className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-blue-600 text-white hover:bg-blue-700 disabled:bg-gray-300 dark:disabled:bg-gray-700 disabled:cursor-not-allowed"
          >
            <Save size={14} />
            Save
          </button>
          <button
            type="button"
            onClick={handleClose}
            className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
            aria-label="Close editor"
            title="Close"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {/* Save error banner (buffer is retained on failure) */}
      {saveError && (
        <div className="flex items-center gap-2 px-3 py-2 bg-red-50 dark:bg-red-950 border-b border-red-200 dark:border-red-800 flex-shrink-0">
          <AlertCircle size={14} className="text-red-500 flex-shrink-0" />
          <span className="text-xs text-red-600 dark:text-red-400">{saveError}</span>
        </div>
      )}

      {/* Body: source textarea (edit) or rendered GFM (preview) */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {view === 'edit' ? (
          <textarea
            value={content}
            onChange={(e) => onChange(e.target.value)}
            spellCheck={false}
            className="flex-1 w-full p-3 text-xs font-mono text-gray-800 dark:text-gray-200 bg-transparent resize-none focus:outline-none"
          />
        ) : (
          <div className="flex-1 overflow-auto p-3">
            <div className="prose prose-sm max-w-none prose-gray prose-table:w-full prose-compact">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  pre: ({ children }) => (
                    <pre className="bg-slate-100 border border-slate-200 rounded-md p-2 overflow-x-auto my-1.5 text-xs text-slate-800">
                      {children}
                    </pre>
                  ),
                  code: ({
                    className,
                    children,
                    ...props
                  }: {
                    className?: string;
                    children?: React.ReactNode;
                  }) => {
                    const match = /language-(\w+)/.exec(className || '');
                    return (
                      <code
                        className={`bg-slate-100 text-slate-800 px-1 py-0.5 rounded text-xs font-mono font-medium [pre_&]:bg-transparent [pre_&]:p-0 [pre_&]:rounded-none [pre_&]:text-inherit ${
                          match ? `language-${match[1]}` : ''
                        }`}
                        {...props}
                      >
                        {children}
                      </code>
                    );
                  },
                  table: ({ children }) => (
                    <div className="overflow-x-auto my-1.5">
                      <table className="w-full border-collapse border border-gray-200 text-xs">
                        {children}
                      </table>
                    </div>
                  ),
                  thead: ({ children }) => <thead className="bg-gray-50">{children}</thead>,
                  tbody: ({ children }) => (
                    <tbody className="divide-y divide-gray-200">{children}</tbody>
                  ),
                  tr: ({ children }) => (
                    <tr className="border-b border-gray-200 even:bg-gray-50/50">{children}</tr>
                  ),
                  th: ({ children }) => (
                    <th className="border border-gray-200 px-2 py-1 text-left text-xs font-semibold text-gray-700">
                      {children}
                    </th>
                  ),
                  td: ({ children }) => (
                    <td className="border border-gray-200 px-2 py-1 text-xs text-gray-700">
                      {children}
                    </td>
                  ),
                  p: ({ children }) => <p className="mb-1 last:mb-0 leading-normal text-sm">{children}</p>,
                  ul: ({ children }) => <ul className="list-disc pl-4 mb-1 space-y-0.5">{children}</ul>,
                  ol: ({ children }) => <ol className="list-decimal pl-4 mb-1 space-y-0.5">{children}</ol>,
                  li: ({ children }) => <li className="leading-normal text-sm">{children}</li>,
                  h1: ({ children }) => <h1 className="text-base font-bold mt-3 mb-1">{children}</h1>,
                  h2: ({ children }) => <h2 className="text-sm font-bold mt-2.5 mb-1">{children}</h2>,
                  h3: ({ children }) => <h3 className="text-sm font-semibold mt-2 mb-0.5">{children}</h3>,
                  h4: ({ children }) => <h4 className="text-sm font-semibold mt-1.5 mb-0.5">{children}</h4>,
                  blockquote: ({ children }) => (
                    <blockquote className="border-l-2 border-gray-300 pl-3 my-1.5 text-gray-600 text-sm italic">
                      {children}
                    </blockquote>
                  ),
                  hr: () => <hr className="my-2 border-gray-200" />,
                  a: ({ children, href }) => (
                    <a
                      href={href}
                      className="text-blue-600 hover:text-blue-700 underline"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {children}
                    </a>
                  ),
                }}
              >
                {content}
              </ReactMarkdown>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
