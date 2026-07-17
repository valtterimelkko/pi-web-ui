import { Component, type ReactNode } from 'react';
import { AlertCircle, Copy, Download } from 'lucide-react';
import {
  copyBrowserDiagnostics,
  downloadBrowserDiagnostics,
  recordBrowserDiagnostic,
} from '../lib/browserDiagnostics.js';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
  diagnosticActionError?: string;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    recordBrowserDiagnostic({ kind: 'ui_error', errorName: error.name, operation: 'react_render' });
    console.error('ErrorBoundary caught:', error, errorInfo);
  }

  private copyDiagnostics = async (): Promise<void> => {
    try {
      await copyBrowserDiagnostics();
      this.setState({ diagnosticActionError: undefined });
    } catch {
      this.setState({ diagnosticActionError: 'Copy failed. Please use Download diagnostics instead.' });
    }
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="h-screen flex items-center justify-center bg-slate-950">
          <div className="text-center p-8">
            <AlertCircle className="w-16 h-16 text-red-400 mx-auto mb-4" />
            <h1 className="text-2xl font-bold text-slate-200 mb-2">Something went wrong</h1>
            <p className="text-slate-400 mb-4">{this.state.error?.message}</p>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <button
                onClick={() => window.location.reload()}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-white"
              >
                Reload Page
              </button>
              <button
                onClick={() => { void this.copyDiagnostics(); }}
                className="inline-flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-slate-700 rounded-lg text-slate-200"
              >
                <Copy className="w-4 h-4" /> Copy diagnostics
              </button>
              <button
                onClick={downloadBrowserDiagnostics}
                className="inline-flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-slate-700 rounded-lg text-slate-200"
              >
                <Download className="w-4 h-4" /> Download diagnostics
              </button>
            </div>
            {this.state.diagnosticActionError && (
              <p role="status" className="text-xs text-amber-300 mt-3">{this.state.diagnosticActionError}</p>
            )}
            <p className="text-xs text-slate-500 mt-3">Diagnostics stay in this browser until you copy or download them.</p>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
