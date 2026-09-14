import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { installGlobalErrorReporting } from './lib/clientDiagnosticsReporter.js';
import { speechArbiter } from './lib/speechArbiter.js';
import '@xterm/xterm/css/xterm.css';
import './index.css';

// P13: uncaught errors and unhandled rejections land in the browser ring AND
// upload to the server diagnostics ring (component=ClientVoice) — a crash is
// no longer invisible to server-side queries. Fire-and-forget; never alters
// app behaviour.
installGlobalErrorReporting();

// Dev-only validation probe: lets a driver read the frozen arbiter's state
// without touching product behaviour. Compiled out of production builds.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__speechArbiter = speechArbiter;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
