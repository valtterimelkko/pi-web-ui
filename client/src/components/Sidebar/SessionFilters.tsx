import { Search, X } from 'lucide-react';

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
    <div className="px-3 py-2 space-y-2">
      {/* Text search */}
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
        <input
          type="text"
          value={filter}
          onChange={(e) => onFilterChange(e.target.value)}
          placeholder="Search sessions..."
          aria-label="Search sessions"
          className="w-full pl-8 pr-7 py-1.5 bg-white border border-gray-200 rounded-md text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-base"
        />
        {filter && (
          <button
            onClick={() => onFilterChange('')}
            className="absolute right-2 top-1/2 -translate-y-1/2"
            aria-label="Clear search"
          >
            <X className="w-3.5 h-3.5 text-gray-400 hover:text-gray-600" />
          </button>
        )}
      </div>

      {/* CWD filter */}
      {uniqueCwds.length > 1 && (
        <div className="flex items-center gap-1.5">
          <select
            value={cwdFilter || ''}
            onChange={(e) => onCwdFilterChange(e.target.value || null)}
            aria-label="Filter by project"
            className="flex-1 bg-white border border-gray-200 rounded-md text-xs text-gray-600 py-1.5 px-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
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
              className="p-1 hover:bg-gray-200 rounded"
              aria-label="Clear project filter"
            >
              <X className="w-3.5 h-3.5 text-gray-400" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
