import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Copy, Check } from 'lucide-react';
import { copyToClipboard } from '../../lib/clipboard';

/**
 * CodeBlock — a fenced code block ("card") rendered by ReactMarkdown's `pre`
 * override. Adds a per-block copy button so a self-contained markdown/code
 * block can be copied on its own, without grabbing the surrounding message
 * text (intro/outro chatter).
 *
 * The raw block text is read from the `<pre>` element's `textContent` at click
 * time, so this works regardless of the fenced language (markdown, yaml, ts, …)
 * and regardless of whether the block starts with YAML front-matter or a
 * heading — both render as the same `<pre>` card, and both are copyable.
 */
interface CodeBlockProps {
  children: ReactNode;
}

export function CodeBlock({ children }: CodeBlockProps) {
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  // Owns the copy-feedback timer so it is cleared on unmount and on re-copy
  // (no dangling timer, no setState-after-unmount).
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  const handleCopy = async () => {
    // The copy button itself is icon-only (no text content), so the <pre>'s
    // textContent is exactly the fenced block's raw text.
    const text = preRef.current?.textContent ?? '';
    if (!text) return;
    const ok = await copyToClipboard(text, 'Code block copied to clipboard');
    if (ok) {
      setCopied(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <pre
      ref={preRef}
      className="relative bg-surface-subtle dark:bg-surface-dark-subtle border border-outline-default dark:border-outline-default-dark rounded-xl p-3 overflow-x-auto my-2 text-xs text-content-primary dark:text-content-primary-dark font-mono"
    >
      <button
        type="button"
        onClick={handleCopy}
        title={copied ? 'Copied!' : 'Copy code'}
        aria-label={copied ? 'Copied code block to clipboard' : 'Copy code block to clipboard'}
        className={`
          absolute top-2 right-2 p-1.5 rounded-lg border border-outline-subtle dark:border-outline-subtle-dark transition-all duration-200 touch-manipulation
          ${copied
            ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30'
            : 'bg-surface dark:bg-surface-dark text-content-muted dark:text-content-muted-dark hover:bg-surface-subtle dark:hover:bg-surface-dark-subtle hover:text-content-primary dark:hover:text-content-primary-dark opacity-80 hover:opacity-100 shadow-2xs'
          }
        `}
      >
        {copied ? <Check className="w-3.5 h-3.5" strokeWidth={1.75} /> : <Copy className="w-3.5 h-3.5" strokeWidth={1.75} />}
      </button>
      {children}
    </pre>
  );
}
