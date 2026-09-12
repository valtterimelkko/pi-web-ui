import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { clearBrowserDiagnostics, createBrowserDiagnosticBundle } from '../../../src/lib/browserDiagnostics.js';

vi.mock('../../../src/hooks/useAuth.js', () => ({
  useAuth: {
    getState: () => ({ csrfToken: null }),
    setState: vi.fn(),
  },
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

describe('WebSocketClient mobile resume durability', () => {
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

  // RED 1a: a send made while the socket is down must be queued (not dropped).
  it('queues a send made while the socket is closed and delivers it on connect', async () => {
    const { WebSocketClient } = await import('../../../src/lib/websocket.js');
    const client = new WebSocketClient({ onMessage: vi.fn(), onStatusChange: vi.fn() });

    // No connection exists at all — the dictation path hits exactly this state
    // on a phone whose tab was frozen long enough for the socket to die.
    const result = client.send({ type: 'prompt', message: 'never leave the device' });
    expect(result).toBe('queued');

    // When a connection later opens, the queued message must be delivered.
    client.connect();
    FakeWebSocket.instances[0].readyState = FakeWebSocket.OPEN;
    FakeWebSocket.instances[0].onopen?.();
    const sentFrames = FakeWebSocket.instances[0].send.mock.calls.map((c) => JSON.parse(c[0]));
    expect(sentFrames).toContainEqual({ type: 'prompt', message: 'never leave the device' });
  });

  // Ordered case: the queued prompt goes out only AFTER session re-subscription
  // has been ACKNOWLEDGED. The server processes switch_session asynchronously
  // (it rehydrates the session), so a prompt merely wire-ordered after the
  // switch frame can still arrive before the switch completes and be refused
  // with SESSION_NOT_FOUND. This models the production reconnect path:
  // useWebSocket's onStatusChange handler re-subscribes (switch_session) when
  // the status turns 'connected', and the flush waits for session_switched.
  it('flushes queued messages after the session_switched acknowledgement on reconnect', async () => {
    const { WebSocketClient } = await import('../../../src/lib/websocket.js');
    const client = new WebSocketClient({
      onMessage: vi.fn(),
      onStatusChange: (status) => {
        // Mirror useWebSocket.ts: re-subscribe to the current session on reconnect.
        if (status === 'connected') {
          client.send({ type: 'switch_session', sessionPath: 'sess-1' });
        }
      },
      reconnectDelay: 100, random: () => 0.5,
    });
    client.connect();
    const first = FakeWebSocket.instances[0];
    first.readyState = FakeWebSocket.OPEN;
    first.onopen?.();
    expect(first.send.mock.calls.map((c) => JSON.parse(c[0]))).toEqual([
      { type: 'switch_session', sessionPath: 'sess-1' },
    ]);

    first.onclose?.({ code: 1006, reason: 'signal lost' });
    // Tab resumes: reconnect immediately instead of waiting on the backoff timer.
    client.handleResume();
    await vi.advanceTimersByTimeAsync(0); // flush the CSRF refresh microtask
    expect(FakeWebSocket.instances).toHaveLength(2);
    const second = FakeWebSocket.instances[1];

    // The user speaks while the new socket is still connecting.
    const queued = client.send({ type: 'prompt', message: 'spoken instruction' });
    expect(queued).toBe('queued');

    second.readyState = FakeWebSocket.OPEN;
    second.onopen?.();
    // switch_session was sent, but the queued prompt must NOT go out before
    // the server acknowledges the (asynchronous) switch.
    expect(second.send.mock.calls.map((c) => JSON.parse(c[0]))).toEqual([
      { type: 'switch_session', sessionPath: 'sess-1' },
    ]);

    // Server acknowledges the completed switch → held prompt is released.
    second.onmessage?.({ data: JSON.stringify({ type: 'session_switched', sessionId: 's1' }) });
    const sentFrames = second.send.mock.calls.map((c) => JSON.parse(c[0]));
    // Re-subscription MUST precede the queued prompt, or the server refuses it.
    expect(sentFrames).toEqual([
      { type: 'switch_session', sessionPath: 'sess-1' },
      { type: 'prompt', message: 'spoken instruction' },
    ]);
  });

  // The pendingSessionReconnect path (connect(targetSessionId)) must also
  // order its re-subscription before the queue flush; its acknowledgement is
  // session_subscribed. Here the FIRST connection never opens, so the
  // reconnect consumes the still-pending re-subscription.
  it('flushes queued messages after the session_subscribed acknowledgement', async () => {
    const { WebSocketClient } = await import('../../../src/lib/websocket.js');
    const client = new WebSocketClient({
      onMessage: vi.fn(), onStatusChange: vi.fn(),
      reconnectDelay: 100, random: () => 0.5,
    });
    client.connect('sess-1');
    FakeWebSocket.instances[0].onclose?.({ code: 1006, reason: 'never opened' });

    client.handleResume();
    await vi.advanceTimersByTimeAsync(0); // flush the CSRF refresh microtask
    const second = FakeWebSocket.instances[1];
    client.send({ type: 'prompt', message: 'queued prompt' });
    second.readyState = FakeWebSocket.OPEN;
    second.onopen?.();
    // Re-subscription goes out; the prompt is held for the ack.
    expect(second.send.mock.calls.map((c) => JSON.parse(c[0]))).toEqual([
      { type: 'subscribe_session', sessionPath: 'sess-1' },
    ]);

    second.onmessage?.({ data: JSON.stringify({ type: 'session_subscribed', sessionId: 's1' }) });
    const sentFrames = second.send.mock.calls.map((c) => JSON.parse(c[0]));
    expect(sentFrames).toEqual([
      { type: 'subscribe_session', sessionPath: 'sess-1' },
      { type: 'prompt', message: 'queued prompt' },
    ]);
  });

  // A lost acknowledgement must not stall the queue forever.
  it('flushes queued messages via the fallback timer when no switch ack arrives', async () => {
    const { WebSocketClient } = await import('../../../src/lib/websocket.js');
    const client = new WebSocketClient({
      onMessage: vi.fn(),
      onStatusChange: (status) => {
        if (status === 'connected') {
          client.send({ type: 'switch_session', sessionPath: 'sess-1' });
        }
      },
      reconnectDelay: 100, random: () => 0.5,
    });
    client.connect();
    FakeWebSocket.instances[0].readyState = FakeWebSocket.OPEN;
    FakeWebSocket.instances[0].onopen?.();
    FakeWebSocket.instances[0].onclose?.({ code: 1006, reason: '' });
    client.handleResume();
    await vi.advanceTimersByTimeAsync(0);
    const second = FakeWebSocket.instances[1];
    client.send({ type: 'prompt', message: 'waited prompt' });
    second.readyState = FakeWebSocket.OPEN;
    second.onopen?.();
    expect(second.send.mock.calls).toHaveLength(1); // only the switch

    await vi.advanceTimersByTimeAsync(15_000); // fallback fires
    expect(second.send.mock.calls.map((c) => JSON.parse(c[0]))).toEqual([
      { type: 'switch_session', sessionPath: 'sess-1' },
      { type: 'prompt', message: 'waited prompt' },
    ]);
  });

  // RED 2a: a resume event must reconnect without waiting on the (frozen) timer.
  it('reconnects immediately on resume when the socket is down', async () => {
    const { WebSocketClient } = await import('../../../src/lib/websocket.js');
    const client = new WebSocketClient({
      onMessage: vi.fn(), onStatusChange: vi.fn(),
      reconnectDelay: 1000, random: () => 0.5,
    });
    client.connect();
    FakeWebSocket.instances[0].onclose?.({ code: 1006, reason: 'signal lost' });

    // Suspended tab: no timer ever fires. The user returns to the tab.
    client.handleResume();
    await vi.advanceTimersByTimeAsync(0); // flush the CSRF refresh microtask

    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  // RED 2b: a budget exhausted while frozen must not strand the resumed tab.
  it('resets the reconnect budget on resume after it was exhausted while suspended', async () => {
    const { WebSocketClient } = await import('../../../src/lib/websocket.js');
    const { useAuth } = await import('../../../src/hooks/useAuth.js');
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ csrfToken: 'fresh-token' }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new WebSocketClient({
      onMessage: vi.fn(), onStatusChange: vi.fn(),
      maxReconnectAttempts: 1, reconnectDelay: 10, random: () => 0.5,
    });
    client.connect();
    FakeWebSocket.instances[0].onclose?.({ code: 1006, reason: '' });
    await vi.advanceTimersByTimeAsync(100); // attempt 1 → second socket
    FakeWebSocket.instances[1].onclose?.({ code: 1006, reason: '' });
    await vi.advanceTimersByTimeAsync(1000); // budget exhausted → gives up
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(client.getStatus()).toBe('disconnected');

    // The user returns to the tab: resume must try again, not stay dead.
    client.handleResume();
    await vi.advanceTimersByTimeAsync(0); // flush the CSRF refresh microtask

    expect(FakeWebSocket.instances).toHaveLength(3);
    expect(client.getStatus()).toBe('connecting');
    // The CSRF token is refreshed before the reconnect so queued messages are
    // not refused after a backend restart. Only the token is updated — the
    // auth state must stay untouched so the app does not log out mid-outage.
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/auth/me'),
      expect.objectContaining({ credentials: 'include' }),
    );
    expect(useAuth.setState).toHaveBeenCalledWith({ csrfToken: 'fresh-token' });
    vi.unstubAllGlobals();
  });

  it('adopts a disconnected singleton that still holds queued messages instead of dropping them', async () => {
    const { WebSocketClient, createWebSocketClient } = await import('../../../src/lib/websocket.js');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    const first = createWebSocketClient({
      onMessage: vi.fn(), onStatusChange: vi.fn(),
      maxReconnectAttempts: 1, reconnectDelay: 10, random: () => 0.5,
    });
    first.connect();
    FakeWebSocket.instances[0].onopen?.();
    FakeWebSocket.instances[0].onclose?.({ code: 1006, reason: '' });
    await vi.advanceTimersByTimeAsync(100); // attempt 1 → second socket
    FakeWebSocket.instances[1].onclose?.({ code: 1006, reason: '' });
    await vi.advanceTimersByTimeAsync(1000); // budget exhausted
    expect(first.getStatus()).toBe('disconnected');

    // A prompt sent while down is queued; the send itself forces a resume
    // reconnect (which fails again, re-exhausting the budget).
    expect(first.send({ type: 'prompt', message: 'precious' })).toBe('queued');
    await vi.advanceTimersByTimeAsync(0); // resume connect → third socket
    FakeWebSocket.instances[2].onclose?.({ code: 1006, reason: '' });
    await vi.advanceTimersByTimeAsync(100); // attempt → fourth socket
    FakeWebSocket.instances[3].onclose?.({ code: 1006, reason: '' });
    await vi.advanceTimersByTimeAsync(1000); // exhausted again → 'disconnected'
    expect(first.getStatus()).toBe('disconnected');
    expect(first.hasQueuedMessages()).toBe(true);

    // Any component remounting useWebSocket must NOT replace (and thereby
    // disconnect) a singleton that still holds queued messages.
    const second = createWebSocketClient({ onMessage: vi.fn(), onStatusChange: vi.fn() });
    expect(second).toBe(first);
    expect(first.hasQueuedMessages()).toBe(true);
    vi.unstubAllGlobals();
  });

  it('ignores resume when an intentional disconnect is in force', async () => {
    const { WebSocketClient } = await import('../../../src/lib/websocket.js');
    const client = new WebSocketClient({ onMessage: vi.fn(), onStatusChange: vi.fn() });
    client.connect();
    client.disconnect();
    client.handleResume();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('skips resume when the socket is already open or connecting', async () => {
    const { WebSocketClient } = await import('../../../src/lib/websocket.js');
    const client = new WebSocketClient({ onMessage: vi.fn(), onStatusChange: vi.fn() });
    client.connect();
    FakeWebSocket.instances[0].onopen?.();
    client.handleResume();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('records a send that cannot be queued via onSendFailed', async () => {
    const { WebSocketClient } = await import('../../../src/lib/websocket.js');
    const onSendFailed = vi.fn();
    const client = new WebSocketClient({
      onMessage: vi.fn(), onStatusChange: vi.fn(), onSendFailed,
      maxQueuedMessages: 1,
    });
    expect(client.send({ type: 'prompt', message: 'first' })).toBe('queued');
    expect(client.send({ type: 'prompt', message: 'overflow' })).toBe('failed');
    expect(onSendFailed).toHaveBeenCalledTimes(1);
  });

  it('fails sends after an intentional disconnect and drops the queue with a report', async () => {
    const { WebSocketClient } = await import('../../../src/lib/websocket.js');
    const onSendFailed = vi.fn();
    const client = new WebSocketClient({
      onMessage: vi.fn(), onStatusChange: vi.fn(), onSendFailed,
    });
    client.send({ type: 'prompt', message: 'queued while down' });
    client.connect();
    FakeWebSocket.instances[0].readyState = FakeWebSocket.OPEN;
    FakeWebSocket.instances[0].onopen?.();
    client.disconnect();

    expect(client.send({ type: 'prompt', message: 'after disconnect' })).toBe('failed');
    expect(onSendFailed).toHaveBeenCalled();

    // The dropped queue must not resurface on a later connection.
    client.connect();
    FakeWebSocket.instances[1].readyState = FakeWebSocket.OPEN;
    FakeWebSocket.instances[1].onopen?.();
    const sentFrames = FakeWebSocket.instances[1].send.mock.calls.map((c) => JSON.parse(c[0]));
    expect(sentFrames).not.toContainEqual({ type: 'prompt', message: 'queued while down' });
  });

  it('re-queues a message whose synchronous send fails on an open socket', async () => {
    const { WebSocketClient } = await import('../../../src/lib/websocket.js');
    const client = new WebSocketClient({ onMessage: vi.fn(), onStatusChange: vi.fn() });
    client.connect();
    const socket = FakeWebSocket.instances[0];
    socket.readyState = FakeWebSocket.OPEN;
    socket.onopen?.();
    socket.send.mockImplementationOnce(() => { throw new Error('half-open socket'); });

    expect(client.send({ type: 'prompt', message: 'kept' })).toBe('queued');
  });
});

describe('WebSocketClient resume event listeners', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    clearBrowserDiagnostics();
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    const { disconnectWebSocket } = await import('../../../src/lib/websocket.js');
    disconnectWebSocket();
  });

  it.each(['visibilitychange', 'online', 'focus'] as const)('%s resume event reconnects a downed socket via the singleton', async (event) => {
    const { createWebSocketClient } = await import('../../../src/lib/websocket.js');
    const client = createWebSocketClient({
      onMessage: vi.fn(), onStatusChange: vi.fn(),
      reconnectDelay: 60_000, random: () => 0.5,
    });
    client.connect();
    FakeWebSocket.instances[0].onclose?.({ code: 1006, reason: 'phone slept' });
    expect(FakeWebSocket.instances).toHaveLength(1);

    if (event === 'visibilitychange') {
      document.dispatchEvent(new Event('visibilitychange'));
    } else {
      window.dispatchEvent(new Event(event));
    }
    await vi.advanceTimersByTimeAsync(0); // flush the CSRF refresh microtask

    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});
