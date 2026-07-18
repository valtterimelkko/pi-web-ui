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
      className="relative bg-slate-100 border border-slate-200 rounded-md p-2 overflow-x-auto my-1.5 text-xs text-slate-800"
    >
      <button
        type="button"
        onClick={handleCopy}
        title={copied ? 'Copied!' : 'Copy code'}
        aria-label={copied ? 'Copied code block to clipboard' : 'Copy code block to clipboard'}
        className={`
          absolute top-1 right-1 p-1 rounded transition-all duration-200 touch-manipulation
          ${copied
            ? 'bg-green-100 text-green-600'
            : 'bg-white/80 text-gray-500 hover:bg-white hover:text-gray-700 opacity-80 hover:opacity-100'
          }
        `}
      >
        {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
      </button>
      {children}
    </pre>
  );
}
