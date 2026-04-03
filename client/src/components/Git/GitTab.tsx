import { GitBranch } from 'lucide-react';

export function GitTab() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center p-8">
      <GitBranch size={48} className="text-gray-300 dark:text-gray-600 mb-4" />
      <h3 className="text-lg font-semibold text-gray-600 dark:text-gray-400 mb-2">Git Panel Loading...</h3>
      <p className="text-sm text-gray-400 dark:text-gray-500">Git integration coming in a moment.</p>
    </div>
  );
}
