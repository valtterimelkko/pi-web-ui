import { EventEmitter } from 'events';

// node-pty is optional – gracefully degrade when not installed
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type NodePty = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type IPty = any;

// Lazy-loaded node-pty module (ESM compatible)
let ptyModule: NodePty | null | undefined = undefined;

async function getPty(): Promise<NodePty | null> {
  if (ptyModule === undefined) {
    try {
      // Dynamic import for ESM compatibility
      const mod = await import('node-pty');
      ptyModule = mod.default || mod;
      console.log('[TerminalManager] node-pty loaded successfully');
    } catch (err) {
      console.warn('[TerminalManager] node-pty not available, terminal feature disabled:', (err as Error).message);
      ptyModule = null;
    }
  }
  return ptyModule;
}

interface TerminalSession {
  pid: number;
  cwd: string;
  cols: number;
  rows: number;
  createdAt: number;
  lastActivity: number;
  process: IPty;
  emitter: EventEmitter;
}

const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const MAX_TERMINALS = 10;

export class TerminalManager {
  private terminals = new Map<string, TerminalSession>();
  private idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

  async isAvailable(): Promise<boolean> {
    const pty = await getPty();
    return pty !== null;
  }

  async create(clientId: string, cwd: string = process.env.HOME || '/', cols: number = 80, rows: number = 24): Promise<{ success: boolean; error?: string; info?: { clientId: string; cwd: string; pid: number; cols: number; rows: number; createdAt: number; lastActivity: number } }> {
    const pty = await getPty();
    if (!pty) return { success: false, error: 'node-pty not available' };
    if (this.terminals.size >= MAX_TERMINALS) {
      return { success: false, error: 'Maximum terminals reached' };
    }

    // Destroy existing terminal for this client
    this.destroy(clientId);

    const shell = process.env.SHELL || '/bin/bash';
    const emitter = new EventEmitter();

    const process_ = pty.spawn(shell, [], {
      name: 'xterm-color',
      cols,
      rows,
      cwd,
      env: { ...process.env } as Record<string, string>,
    });

    const now = Date.now();
    const session: TerminalSession = {
      pid: process_.pid,
      cwd,
      cols,
      rows,
      createdAt: now,
      lastActivity: now,
      process: process_,
      emitter,
    };

    this.terminals.set(clientId, session);

    process_.onData((data: string) => {
      session.lastActivity = Date.now();
      this.resetIdleTimer(clientId);
      emitter.emit('data', data);
    });

    process_.onExit(({ exitCode, signal }: { exitCode: number; signal?: number }) => {
      emitter.emit('exit', { exitCode, signal });
      this.terminals.delete(clientId);
      this.clearIdleTimer(clientId);
    });

    this.resetIdleTimer(clientId);

    return {
      success: true,
      info: {
        clientId,
        cwd,
        pid: process_.pid,
        cols,
        rows,
        createdAt: now,
        lastActivity: now,
      },
    };
  }

  write(clientId: string, data: string): boolean {
    const session = this.terminals.get(clientId);
    if (!session) return false;
    session.lastActivity = Date.now();
    this.resetIdleTimer(clientId);
    session.process.write(data);
    return true;
  }

  resize(clientId: string, cols: number, rows: number): boolean {
    const session = this.terminals.get(clientId);
    if (!session) return false;
    session.cols = cols;
    session.rows = rows;
    session.process.resize(cols, rows);
    return true;
  }

  getEmitter(clientId: string): EventEmitter | null {
    return this.terminals.get(clientId)?.emitter ?? null;
  }

  destroy(clientId: string): void {
    const session = this.terminals.get(clientId);
    if (!session) return;
    this.clearIdleTimer(clientId);
    try {
      session.process.kill();
    } catch {
      // ignore
    }
    this.terminals.delete(clientId);
  }

  destroyAll(): void {
    for (const clientId of this.terminals.keys()) {
      this.destroy(clientId);
    }
  }

  list(): Array<{ clientId: string; pid: number; cwd: string; createdAt: number; lastActivity: number }> {
    return Array.from(this.terminals.entries()).map(([clientId, s]) => ({
      clientId,
      pid: s.pid,
      cwd: s.cwd,
      createdAt: s.createdAt,
      lastActivity: s.lastActivity,
    }));
  }

  private resetIdleTimer(clientId: string): void {
    this.clearIdleTimer(clientId);
    const timer = setTimeout(() => {
      this.destroy(clientId);
    }, IDLE_TIMEOUT_MS);
    this.idleTimers.set(clientId, timer);
  }

  private clearIdleTimer(clientId: string): void {
    const timer = this.idleTimers.get(clientId);
    if (timer) {
      clearTimeout(timer);
      this.idleTimers.delete(clientId);
    }
  }
}

export const terminalManager = new TerminalManager();
