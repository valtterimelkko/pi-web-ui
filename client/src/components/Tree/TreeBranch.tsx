interface TreeBranchProps {
  depth: number;
  isLast: boolean;
}

export function TreeBranch({ depth, isLast }: TreeBranchProps) {
  return (
    <div
      className="absolute left-0 top-0 bottom-0 w-px bg-slate-700"
      style={{
        left: `${depth * 24 + 14}px`,
      }}
    >
      {!isLast && (
        <div className="absolute left-0 top-6 right-0 h-px bg-slate-700" />
      )}
    </div>
  );
}
