import { useEffect } from 'react';
import { X, CheckCircle, AlertCircle, Info } from 'lucide-react';
import { useUIStore } from '../../store';

const icons = {
  info: Info,
  success: CheckCircle,
  warning: AlertCircle,
  error: AlertCircle,
};

const colors = {
  info: 'bg-blue-600',
  success: 'bg-green-600',
  warning: 'bg-amber-600',
  error: 'bg-red-600',
};

export function ToastContainer() {
  const { toasts, removeToast } = useUIStore();

  return (
    <div className="fixed bottom-4 right-4 z-50 space-y-2">
      {toasts.map((toast) => (
        <Toast key={toast.id} toast={toast} onClose={() => removeToast(toast.id)} />
      ))}
    </div>
  );
}

interface ToastProps {
  toast: { id: string; type: 'info' | 'success' | 'warning' | 'error'; message: string };
  onClose: () => void;
}

function Toast({ toast, onClose }: ToastProps) {
  const Icon = icons[toast.type];

  useEffect(() => {
    const timer = setTimeout(onClose, 5000);
    return () => clearTimeout(timer);
  }, [onClose]);

  return (
    <div
      className={`
        flex items-center gap-3 px-4 py-3 rounded-lg shadow-lg
        text-white min-w-[300px] animate-in slide-in-from-right
        ${colors[toast.type]}
      `}
    >
      <Icon className="w-5 h-5 flex-shrink-0" />
      <span className="flex-1">{toast.message}</span>
      <button onClick={onClose} className="p-1 hover:bg-white/20 rounded transition-colors">
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
