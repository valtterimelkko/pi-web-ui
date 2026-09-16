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
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-content-muted dark:text-content-muted-dark" strokeWidth={1.75} />
        <input
          type="text"
          value={filter}
          onChange={(e) => onFilterChange(e.target.value)}
          placeholder="Search sessions..."
          aria-label="Search sessions"
          className="w-full pl-8 pr-7 py-1.5 bg-surface dark:bg-surface-dark border border-outline-default dark:border-outline-default-dark rounded-lg text-sm text-content-primary dark:text-content-primary-dark placeholder:text-content-muted dark:placeholder:text-content-muted-dark focus:outline-none focus:ring-1 focus:ring-pi-primary focus:border-pi-primary transition-colors text-base"
        />
        {filter && (
          <button
            onClick={() => onFilterChange('')}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-surface-subtle dark:hover:bg-surface-dark-subtle"
            aria-label="Clear search"
          >
            <X className="w-3.5 h-3.5 text-content-muted dark:text-content-muted-dark hover:text-content-primary" strokeWidth={1.75} />
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
            className="flex-1 bg-surface dark:bg-surface-dark border border-outline-default dark:border-outline-default-dark rounded-lg text-xs text-content-secondary dark:text-content-secondary-dark py-1.5 px-2 focus:outline-none focus:ring-1 focus:ring-pi-primary"
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
              className="p-1 hover:bg-surface-subtle dark:hover:bg-surface-dark-subtle rounded text-content-muted dark:text-content-muted-dark hover:text-content-primary"
              aria-label="Clear project filter"
            >
              <X className="w-3.5 h-3.5" strokeWidth={1.75} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
