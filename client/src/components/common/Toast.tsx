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
  info: 'bg-blue-50 text-blue-800 border border-blue-200',
  success: 'bg-green-50 text-green-800 border border-green-200',
  warning: 'bg-amber-50 text-amber-800 border border-amber-200',
  error: 'bg-red-50 text-red-800 border border-red-200',
};

export function ToastContainer() {
  const { toasts, removeToast } = useUIStore();

  return (
    <div className="fixed bottom-4 right-4 z-50 space-y-2 max-w-[calc(100vw-2rem)] sm:max-w-md">
      {toasts.map((toast) => (
        <Toast key={toast.id} toast={toast} onClose={() => removeToast(toast.id)} />
      ))}
    </div>
  );
}

interface ToastProps {
  toast: { id: string; type: 'info' | 'success' | 'warning' | 'error'; message: string; sticky?: boolean };
  onClose: () => void;
}

function Toast({ toast, onClose }: ToastProps) {
  const Icon = icons[toast.type];

  // Extensions deliver reports and multi-line explanations through this channel
  // (`/goal report` is ~20 lines) — five seconds is not enough to read one. Long
  // payloads therefore dwell four times longer, but they still clear themselves:
  // on a phone the toast sits over the composer, and everything is kept in the
  // notification tray anyway, so a permanent toast would only be in the way.
  useEffect(() => {
    const timer = setTimeout(onClose, toast.sticky ? 20000 : 5000);
    return () => clearTimeout(timer);
  }, [onClose, toast.sticky]);

  return (
    <div
      className={`
        flex items-start gap-3 px-4 py-3 rounded-lg shadow-lg
        w-full sm:min-w-[300px] animate-in slide-in-from-right
        ${colors[toast.type]}
      `}
      data-testid={`toast-${toast.type}`}
    >
      <Icon className="w-5 h-5 flex-shrink-0 mt-0.5" />
      <span
        className="flex-1 min-w-0 text-sm whitespace-pre-wrap break-words max-h-[30vh] overflow-y-auto overscroll-contain"
        data-testid="toast-message"
      >
        {toast.message}
      </span>
      <button
        onClick={onClose}
        className="p-1 hover:bg-black/10 rounded transition-colors flex-shrink-0"
        title="Dismiss"
        data-testid="toast-dismiss"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
