import { Search, Folder, X } from 'lucide-react';

interface SessionFiltersProps {
  filter: string;
  onFilterChange: (value: string) => void;
  cwdFilter: string | null;
  onCwdFilterChange: (value: string | null) => void;
  uniqueCwds: string[];
}

export function SessionFilters({
  filter,
  onFilterChange,
  cwdFilter,
  onCwdFilterChange,
  uniqueCwds,
}: SessionFiltersProps) {
  return (
    <div className="p-4 space-y-3 border-b border-slate-800">
      {/* Text search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
        <input
          type="text"
          value={filter}
          onChange={(e) => onFilterChange(e.target.value)}
          placeholder="Search sessions..."
          aria-label="Search sessions"
          className="w-full pl-10 pr-8 py-2 bg-slate-800 rounded-lg text-sm text-slate-200 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-600"
        />
        {filter && (
          <button
            onClick={() => onFilterChange('')}
            className="absolute right-3 top-1/2 -translate-y-1/2"
            aria-label="Clear search"
          >
            <X className="w-4 h-4 text-slate-400 hover:text-slate-200" />
          </button>
        )}
      </div>

      {/* CWD filter */}
      {uniqueCwds.length > 0 && (
        <div className="flex items-center gap-2">
          <Folder className="w-4 h-4 text-slate-400" />
          <select
            value={cwdFilter || ''}
            onChange={(e) => onCwdFilterChange(e.target.value || null)}
            aria-label="Filter by project"
            className="flex-1 bg-slate-800 rounded-lg text-sm text-slate-200 py-1.5 px-3 focus:outline-none focus:ring-2 focus:ring-violet-600"
          >
            <option value="">All projects</option>
            {uniqueCwds.map((cwd) => (
              <option key={cwd} value={cwd}>
                {cwd.split('/').pop() || cwd}
              </option>
            ))}
          </select>
          {cwdFilter && (
            <button
              onClick={() => onCwdFilterChange(null)}
              className="p-1.5 hover:bg-slate-800 rounded"
              aria-label="Clear project filter"
            >
              <X className="w-4 h-4 text-slate-400" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
