import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { clearBrowserDiagnostics, createBrowserDiagnosticBundle } from '../../../src/lib/browserDiagnostics.js';

vi.mock('../../../src/hooks/useAuth.js', () => ({
  useAuth: { getState: () => ({ csrfToken: null }) },
}));

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn();
  constructor(public readonly url: string) { FakeWebSocket.instances.push(this); }
}

describe('WebSocketClient reconnect lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    clearBrowserDiagnostics();
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('does not create a replacement while the current socket is still connecting', async () => {
    const { WebSocketClient } = await import('../../../src/lib/websocket.js');
    const client = new WebSocketClient({ onMessage: vi.fn(), onStatusChange: vi.fn() });
    client.connect();
    client.connect();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('does not reconnect after an intentional disconnect', async () => {
    const { WebSocketClient } = await import('../../../src/lib/websocket.js');
    const statuses: string[] = [];
    const client = new WebSocketClient({
      onMessage: vi.fn(), onStatusChange: (status) => statuses.push(status),
      reconnectDelay: 100, random: () => 0.5,
    });
    client.connect();
    const socket = FakeWebSocket.instances[0];
    client.disconnect();
    socket.onclose?.({ code: 1000, reason: 'manual' });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(statuses.at(-1)).toBe('disconnected');
  });

  it('reconnects abnormal closes with bounded jitter and records close evidence', async () => {
    const { WebSocketClient } = await import('../../../src/lib/websocket.js');
    const client = new WebSocketClient({
      onMessage: vi.fn(), onStatusChange: vi.fn(),
      reconnectDelay: 100, random: () => 0.5,
    });
    client.connect();
    FakeWebSocket.instances[0].onclose?.({ code: 1011, reason: 'server restart' });
    await vi.advanceTimersByTimeAsync(99);
    expect(FakeWebSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(createBrowserDiagnosticBundle().events).toContainEqual(expect.objectContaining({
      kind: 'connection', state: 'disconnected', closeCode: 1011, closeReason: 'server restart', reconnectAttempt: 0,
    }));
  });
});
