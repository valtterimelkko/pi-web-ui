import { StreamingMarkdownRenderer } from '../../lib/markdown';

interface StreamingTextProps {
  text: string;
}

export function StreamingText({ text }: StreamingTextProps) {
  return (
    <div className="prose prose-sm max-w-none prose-gray prose-table:w-full prose-compact">
      <StreamingMarkdownRenderer text={text} />
    </div>
  );
}
