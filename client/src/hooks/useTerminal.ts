import { useEffect, useRef, useCallback } from 'react';
import { useTerminalStore } from '../store/terminalStore';
import { useAuth } from './useAuth';

interface UseTerminalOptions {
  cwd?: string;
  cols?: number;
  rows?: number;
}

export function useTerminal(containerRef: React.RefObject<HTMLDivElement | null>, options: UseTerminalOptions = {}) {
  const wsRef = useRef<WebSocket | null>(null);
  const termRef = useRef<import('@xterm/xterm').Terminal | null>(null);
  const fitAddonRef = useRef<import('@xterm/addon-fit').FitAddon | null>(null);
  const { setConnected, setError } = useTerminalStore();
  // useAuth is a zustand store - access csrfToken from state
  const csrfToken = useAuth((s) => s.csrfToken);

  const connect = useCallback(() => {
    if (!containerRef.current) return;

    // Dynamically import xterm to avoid SSR issues
    Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
    ]).then(([{ Terminal }, { FitAddon }]) => {
      // Clean up any existing terminal
      if (termRef.current) {
        termRef.current.dispose();
        termRef.current = null;
      }

      const term = new Terminal({
        cursorBlink: true,
        fontSize: 14,
        fontFamily: '"Cascadia Code", "Fira Code", monospace',
        theme: {
          background: '#0f0f0f',
          foreground: '#d4d4d4',
          cursor: '#d4d4d4',
        },
        convertEol: true,
        scrollback: 5000,
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);

      if (containerRef.current) {
        term.open(containerRef.current);
        fitAddon.fit();
        fitAddonRef.current = fitAddon;
        termRef.current = term;
      }

      // Connect WebSocket
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws/terminal`);
      wsRef.current = ws;

      ws.onopen = () => {
        // Send auth token via first message + create command
        const cwd = options.cwd || '/root';
        const cols = term.cols || options.cols || 80;
        const rows = term.rows || options.rows || 24;
        ws.send(JSON.stringify({ type: 'create', cwd, cols, rows }));
      };

      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'ready') {
            // Server ready signal
          } else if (msg.type === 'created') {
            setConnected(true);
            setError(null);
          } else if (msg.type === 'exit') {
            setConnected(false);
            term.writeln('\r\n[Process exited]');
          } else if (msg.type === 'error') {
            setError(msg.error);
            term.writeln(`\r\n[Error: ${msg.error}]`);
          }
        } catch {
          // Binary/text terminal output
          term.write(e.data);
        }
      };

      ws.onclose = () => {
        setConnected(false);
      };

      ws.onerror = () => {
        setError('Connection failed');
        setConnected(false);
      };

      // Forward terminal input to server
      term.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(data);
        }
      });

      // Handle resize
      const resizeObserver = new ResizeObserver(() => {
        if (fitAddonRef.current && termRef.current) {
          fitAddonRef.current.fit();
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'resize',
              cols: termRef.current.cols,
              rows: termRef.current.rows,
            }));
          }
        }
      });

      if (containerRef.current) {
        resizeObserver.observe(containerRef.current);
      }

      // Store cleanup reference on ws object
      (wsRef.current as WebSocket & { _resizeObserver?: ResizeObserver })._resizeObserver = resizeObserver;
    });
  }, [containerRef, options.cwd, options.cols, options.rows, setConnected, setError]);

  const disconnect = useCallback(() => {
    if (wsRef.current) {
      const wsWithObserver = wsRef.current as WebSocket & { _resizeObserver?: ResizeObserver };
      if (wsWithObserver._resizeObserver) {
        wsWithObserver._resizeObserver.disconnect();
      }
      wsRef.current.close();
      wsRef.current = null;
    }
    if (termRef.current) {
      termRef.current.dispose();
      termRef.current = null;
    }
    fitAddonRef.current = null;
    setConnected(false);
  }, [setConnected]);

  useEffect(() => {
    return () => {
      disconnect();
    };
  }, [disconnect]);

  // Suppress unused variable warning - csrfToken may be used for future auth header support
  void csrfToken;

  return { connect, disconnect, termRef };
}
