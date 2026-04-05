import React, { memo } from 'react';
import { Streamdown, type Components } from 'streamdown';

/**
 * Shared markdown component overrides for both streaming and static rendering.
 * Preserves the exact CSS classes from the original react-markdown implementation
 * to ensure identical visual output.
 */
const sharedComponents: Components = {
  code({
    className,
    children,
    node: _node,
    ...rest
  }) {
    // Streamdown uses 'data-block' attribute to distinguish block vs inline code.
    // If 'data-block' is present in props, it's a fenced code block.
    // Otherwise it's inline code.
    const isBlock = 'data-block' in (rest as Record<string, unknown>);
    const classStr = typeof className === 'string' ? className : '';
    const match = /language-(\w+)/.exec(classStr);

    if (isBlock) {
      return (
        <pre className="bg-slate-100 border border-slate-200 rounded-md p-2 overflow-x-auto my-1.5 text-xs">
          <code className={`text-slate-800 ${match ? `language-${match[1]}` : ''}`} {...rest}>
            {children}
          </code>
        </pre>
      );
    }

    return (
      <code className="bg-slate-200 text-slate-900 px-1 py-0.5 rounded text-xs font-mono font-medium" {...rest}>
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

  thead: ({ children }) => (
    <thead className="bg-gray-50">{children}</thead>
  ),

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

  p: ({ children }) => (
    <p className="mb-1 last:mb-0 leading-normal text-sm">{children}</p>
  ),

  ul: ({ children }) => (
    <ul className="list-disc pl-4 mb-1 space-y-0.5">{children}</ul>
  ),

  ol: ({ children }) => (
    <ol className="list-decimal pl-4 mb-1 space-y-0.5">{children}</ol>
  ),

  li: ({ children }) => (
    <li className="leading-normal text-sm">{children}</li>
  ),

  h1: ({ children }) => (
    <h1 className="text-base font-bold mt-3 mb-1">{children}</h1>
  ),

  h2: ({ children }) => (
    <h2 className="text-sm font-bold mt-2.5 mb-1">{children}</h2>
  ),

  h3: ({ children }) => (
    <h3 className="text-sm font-semibold mt-2 mb-0.5">{children}</h3>
  ),

  h4: ({ children }) => (
    <h4 className="text-sm font-semibold mt-1.5 mb-0.5">{children}</h4>
  ),

  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-gray-300 pl-3 my-1.5 text-gray-600 text-sm italic">
      {children}
    </blockquote>
  ),

  hr: () => <hr className="my-2 border-gray-200" />,

  strong: ({ children }) => <strong>{children}</strong>,
  em: ({ children }) => <em>{children}</em>,
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
};

/**
 * Full markdown renderer for completed messages.
 * Uses Streamdown in static mode for optimal rendering performance.
 */
export const MarkdownRenderer = memo(function MarkdownRenderer({
  content,
}: {
  content: string;
}) {
  if (!content) return null;

  return (
    <Streamdown
      mode="static"
      controls={false}
      lineNumbers={false}
      components={sharedComponents}
    >
      {content}
    </Streamdown>
  );
});

/**
 * Lightweight streaming markdown renderer for in-progress messages.
 * Uses Streamdown in streaming mode with a blinking cursor.
 */
export function StreamingMarkdownRenderer({
  text,
}: {
  text: string;
}) {
  if (!text) {
    return (
      <span className="inline-block w-2 h-4 ml-0.5 bg-blue-500 animate-pulse align-middle" />
    );
  }

  return (
    <Streamdown
      mode="streaming"
      controls={false}
      lineNumbers={false}
      components={sharedComponents}
      caret="block"
    >
      {text}
    </Streamdown>
  );
}
