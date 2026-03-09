interface LoadingProps {
  size?: 'sm' | 'md' | 'lg';
  text?: string;
}

const sizes = {
  sm: 'w-4 h-4',
  md: 'w-8 h-8',
  lg: 'w-12 h-12',
};

export function Loading({ size = 'md', text }: LoadingProps) {
  return (
    <div className="flex flex-col items-center gap-3">
      <div
        className={`
          ${sizes[size]} 
          border-2 border-violet-600 border-t-transparent 
          rounded-full animate-spin
        `}
      />
      {text && <p className="text-slate-400 text-sm">{text}</p>}
    </div>
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return (
    <div className={`bg-slate-800 animate-pulse rounded ${className}`} />
  );
}
