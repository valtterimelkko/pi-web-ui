interface StreamingTextProps {
  text: string;
}

export function StreamingText({ text }: StreamingTextProps) {
  return (
    <div className="relative">
      <span className="whitespace-pre-wrap leading-relaxed">{text}</span>
      <span className="inline-block w-2 h-5 ml-0.5 bg-teal-500 animate-pulse align-middle" />
    </div>
  );
}
