import { useState, useEffect } from 'react';

interface SlashCommand {
  name: string;
  description: string;
}

const commands: SlashCommand[] = [
  { name: '/compact', description: 'Summarize conversation to free context' },
  { name: '/clear', description: 'Clear the current conversation' },
  { name: '/plan', description: 'Create an implementation plan' },
  { name: '/yolo', description: 'Execute without confirmations' },
  { name: '/export', description: 'Export session to file' },
  { name: '/help', description: 'Show available commands' },
];

interface SlashPaletteProps {
  filter: string;
  onSelect: (command: string) => void;
  onClose: () => void;
}

export function SlashPalette({ filter, onSelect, onClose }: SlashPaletteProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  const query = filter.toLowerCase();
  const filtered = commands.filter(cmd =>
    cmd.name.toLowerCase().includes(query) || cmd.description.toLowerCase().includes(query)
  );

  useEffect(() => {
    setSelectedIndex(0);
  }, [filter]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
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
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [filtered, selectedIndex, onSelect, onClose]);

  if (filtered.length === 0) return null;

  return (
    <div className="absolute bottom-full left-0 right-0 mb-2 bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden z-50">
      <div className="py-1 max-h-64 overflow-y-auto">
        {filtered.map((cmd, index) => (
          <button
            key={cmd.name}
            onClick={() => onSelect(cmd.name)}
            className={`w-full flex items-center gap-3 px-3 py-2 text-left transition-colors ${
              index === selectedIndex ? 'bg-gray-100' : 'hover:bg-gray-50'
            }`}
          >
            <span className="font-mono text-sm font-medium text-gray-900">{cmd.name}</span>
            <span className="text-sm text-gray-500">{cmd.description}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
