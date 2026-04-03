import { useState, useEffect, useCallback } from 'react';
import { getSlashCommands, type SlashCommand } from '../../lib/api';

interface SlashPaletteProps {
  filter: string;
  onSelect: (command: string) => void;
  onClose: () => void;
}

export function SlashPalette({ filter, onSelect, onClose }: SlashPaletteProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load commands from server on mount
  useEffect(() => {
    let mounted = true;
    
    async function loadCommands() {
      try {
        setLoading(true);
        const cmds = await getSlashCommands();
        if (mounted) {
          setCommands(cmds);
          setError(null);
        }
      } catch (err) {
        if (mounted) {
          setError(err instanceof Error ? err.message : 'Failed to load commands');
          // Fall back to basic commands on error
          setCommands([
            { name: '/compact', description: 'Summarize conversation to free context', type: 'builtin' },
            { name: '/clear', description: 'Clear the current conversation', type: 'builtin' },
            { name: '/export', description: 'Export session to file', type: 'builtin' },
            { name: '/help', description: 'Show available commands', type: 'builtin' },
          ]);
        }
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    }
    
    loadCommands();
    
    return () => {
      mounted = false;
    };
  }, []);

  // Filter commands based on input
  const query = filter.toLowerCase();
  const filtered = commands.filter(cmd =>
    cmd.name.toLowerCase().includes(query) || cmd.description.toLowerCase().includes(query)
  );

  // Reset selection when filter changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [filter]);

  // Keyboard navigation
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(i => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && filtered.length > 0) {
      e.preventDefault();
      onSelect(filtered[selectedIndex].name);
    } else if (e.key === 'Escape') {
      onClose();
    }
  }, [filtered, selectedIndex, onSelect, onClose]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // Get badge color based on command type
  const getTypeBadge = (type: SlashCommand['type']) => {
    switch (type) {
      case 'skill':
        return 'bg-purple-100 text-purple-700';
      case 'extension':
        return 'bg-blue-100 text-blue-700';
      case 'builtin':
      default:
        return 'bg-gray-100 text-gray-600';
    }
  };

  if (loading) {
    return (
      <div className="absolute bottom-full left-0 right-0 mb-2 bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden z-50">
        <div className="py-3 px-4 text-sm text-gray-500 flex items-center gap-2">
          <div className="w-3 h-3 border-2 border-gray-300 border-t-blue-500 rounded-full animate-spin" />
          Loading commands...
        </div>
      </div>
    );
  }

  if (filtered.length === 0) {
    return (
      <div className="absolute bottom-full left-0 right-0 mb-2 bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden z-50">
        <div className="py-3 px-4 text-sm text-gray-500">
          No commands found matching "{filter}"
        </div>
      </div>
    );
  }

  return (
    <div className="absolute bottom-full left-0 right-0 mb-2 bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden z-50">
      {error && (
        <div className="px-3 py-1.5 text-xs text-amber-600 bg-amber-50 border-b border-amber-100">
          Using cached commands ({error})
        </div>
      )}
      <div className="py-1 max-h-64 overflow-y-auto">
        {filtered.map((cmd, index) => (
          <button
            key={cmd.name}
            onClick={() => onSelect(cmd.name)}
            className={`w-full flex items-center gap-3 px-3 py-2 text-left transition-colors ${
              index === selectedIndex ? 'bg-gray-100' : 'hover:bg-gray-50'
            }`}
          >
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium uppercase ${getTypeBadge(cmd.type)}`}>
              {cmd.type}
            </span>
            <span className="font-mono text-sm font-medium text-gray-900">{cmd.name}</span>
            <span className="text-sm text-gray-500 truncate flex-1">{cmd.description}</span>
          </button>
        ))}
      </div>
      {filtered.length > 0 && (
        <div className="px-3 py-1.5 text-xs text-gray-400 border-t border-gray-100 flex gap-3">
          <span><kbd className="px-1 bg-gray-100 rounded">↑↓</kbd> navigate</span>
          <span><kbd className="px-1 bg-gray-100 rounded">↵</kbd> select</span>
          <span><kbd className="px-1 bg-gray-100 rounded">esc</kbd> close</span>
        </div>
      )}
    </div>
  );
}
