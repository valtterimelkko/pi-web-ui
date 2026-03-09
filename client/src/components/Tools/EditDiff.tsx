interface EditDiffProps {
  original: string;
  modified: string;
  path: string;
}

export function EditDiff({ original, modified, path }: EditDiffProps) {
  const originalLines = original.split('\n');
  const modifiedLines = modified.split('\n');

  return (
    <div className="rounded-lg overflow-hidden border border-slate-700">
      {/* Header */}
      <div className="px-3 py-2 bg-slate-800 text-xs text-slate-400 font-mono">
        {path}
      </div>
      
      {/* Diff */}
      <div className="bg-slate-950 text-xs font-mono">
        {originalLines.map((line, i) => (
          <div key={`orig-${i}`} className="flex">
            <span className="w-8 text-right pr-2 text-slate-600 select-none">{i + 1}</span>
            <span className="text-red-400 bg-red-900/20 flex-1 px-2">-{line}</span>
          </div>
        ))}
        
        {modifiedLines.map((line, i) => (
          <div key={`mod-${i}`} className="flex">
            <span className="w-8 text-right pr-2 text-slate-600 select-none">{i + 1}</span>
            <span className="text-green-400 bg-green-900/20 flex-1 px-2">+{line}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
