interface EditDiffProps {
  original: string;
  modified: string;
  path: string;
}

export function EditDiff({ original, modified, path }: EditDiffProps) {
  const originalLines = original.split('\n');
  const modifiedLines = modified.split('\n');

  return (
    <div className="rounded-lg overflow-hidden border border-gray-200">
      {/* Header */}
      <div className="px-3 py-2 bg-gray-50 text-xs text-gray-500 font-mono border-b border-gray-200">
        {path}
      </div>

      {/* Diff */}
      <div className="bg-white text-xs font-mono">
        {originalLines.map((line, i) => (
          <div key={`orig-${i}`} className="flex">
            <span className="w-8 text-right pr-2 text-gray-400 select-none">{i + 1}</span>
            <span className="text-red-600 bg-red-50 flex-1 px-2">-{line}</span>
          </div>
        ))}

        {modifiedLines.map((line, i) => (
          <div key={`mod-${i}`} className="flex">
            <span className="w-8 text-right pr-2 text-gray-400 select-none">{i + 1}</span>
            <span className="text-green-600 bg-green-50 flex-1 px-2">+{line}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
