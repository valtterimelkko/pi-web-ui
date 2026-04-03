import { ListTodo } from 'lucide-react';

export function TasksPlaceholder() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center p-8">
      <ListTodo size={48} className="text-gray-300 dark:text-gray-600 mb-4" />
      <h3 className="text-lg font-semibold text-gray-600 dark:text-gray-400 mb-2">Tasks Coming Soon</h3>
      <p className="text-sm text-gray-400 dark:text-gray-500">
        Use <code className="bg-gray-100 dark:bg-gray-800 px-1 rounded">/todos</code> in the Chat tab to manage your tasks.
      </p>
    </div>
  );
}
