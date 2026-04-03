import { Terminal } from 'lucide-react';

export function ShellTab() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center p-8 bg-gray-950">
      <Terminal size={48} className="text-gray-600 mb-4" />
      <h3 className="text-lg font-semibold text-gray-400 mb-2">Terminal Loading...</h3>
      <p className="text-sm text-gray-600">Shell integration coming in a moment.</p>
    </div>
  );
}
