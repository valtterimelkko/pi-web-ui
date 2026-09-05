import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * WS-path memory robustness (2026-09-05 plan, F7): the browser-path twin of
 * broker-flood.wedge.test.ts. Drives the REAL MultiSessionManager event path
 * with an incident-shaped growing thinking stream and two consumers:
 *
 *  - FAST: drains immediately (send() delivers);
 *  - SLOW: socket never drains (bufferedAmount pinned high).
 *
 * Asserts throughout: a co-located health endpoint stays responsive, the fast
 * consumer's cumulative wire bytes stay ~linear in the message size (the
 * pre-fix shape produced ~238x amplification), the slow consumer is closed by
 * the outbound governor instead of accumulating unbounded queued frames, and
 * terminal events reach the fast consumer with full fidelity.
 */

// Mock the pi-coding-agent module (same shape as unit tests).
vi.mock('@earendil-works/pi-coding-agent', () => ({
  createAgentSession: vi.fn(),
  SessionManager: {
    create: vi.fn().mockReturnValue({}),
    open: vi.fn().mockReturnValue({}),
    inMemory: vi.fn().mockReturnValue({}),
  },
  AuthStorage: { create: vi.fn().mockReturnValue({ getAll: vi.fn().mockReturnValue([]) }) },
  ModelRegistry: vi.fn().mockImplementation(() => ({
    getAvailable: vi.fn().mockReturnValue([]),
    getAll: vi.fn().mockReturnValue([]),
    find: vi.fn().mockReturnValue(null),
    getError: vi.fn().mockReturnValue(null),
  })),
  DefaultResourceLoader: vi.fn().mockImplementation(() => ({
    reload: vi.fn().mockResolvedValue(undefined),
    getExtensions: vi.fn().mockReturnValue({ extensions: [], errors: [] }),
  })),
}));

vi.mock('../../src/config.js', () => ({
  config: {
    jwtSecret: 'test-secret',
    jwtExpiresIn: '15m',
    jwtRefreshExpiresIn: '7d',
    piAgentDir: '/tmp/pi-agent',
    sessionDir: '/tmp/sessions',
  },
}));

import { MultiSessionManager } from '../../src/pi/multi-session-manager.js';
import { OutboundGovernor } from '../../src/websocket/outbound-governor.js';

const OPEN = 1; // WebSocket.OPEN

interface FakeWs {
  readyState: number;
  bufferedAmount: number;
  sent: string[];
  closed: number | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

function fastWs(): FakeWs {
  return {
    readyState: OPEN,
    bufferedAmount: 0,
    sent: [],
    closed: null,
    send(data: string) { this.sent.push(data); },
    close(code?: number) { this.closed = code ?? null; this.readyState = 3; },
    terminate() { this.closed = -1; this.readyState = 3; },
  };
}

function slowWs(): FakeWs {
  return {
    readyState: OPEN,
    // Kernel never acks: the governor must see the socket as permanently backpressured.
    get bufferedAmount() { return 64 * 1024 * 1024; },
    sent: [],
    closed: null,
    send(data: string) { this.sent.push(data); },
    close(code?: number) { this.closed = code ?? null; this.readyState = 3; },
    terminate() { this.closed = -1; this.readyState = 3; },
  };
}

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe('WS-path flood containment', () => {
  it('keeps health responsive, wire bytes ~linear, and closes a stuck consumer through an incident-shaped stream', async () => {
    const server = http.createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"status":"ok"}');
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');

    const health = () => new Promise<number>((resolve, reject) => {
      const startedAt = performance.now();
      const request = http.get({ host: '127.0.0.1', port: address.port, path: '/health' }, (response) => {
        response.resume();
        response.once('end', () => resolve(performance.now() - startedAt));
      });
      request.once('error', reject);
    });

    const mockAgentSession = {
      sessionId: 'session-flood',
      sessionFile: '/flood/session.jsonl',
      sessionPath: '/flood/session.jsonl',
      subscribe: vi.fn(),
      dispose: vi.fn(),
      setModel: vi.fn(),
      getContextUsage: vi.fn(() => undefined),
    };
    const mockPiService: any = {
      createSession: vi.fn().mockResolvedValue(mockAgentSession),
      setEventHandler: vi.fn(),
      removeEventHandler: vi.fn(),
      releaseSessionRefs: vi.fn(),
    };

    const fast = fastWs();
    const slow = slowWs();
    const governor = new OutboundGovernor();
    const sentBytes = { fast: 0 };
    // The browser connection manager's single choke point: classify, stringify, govern.
    const broadcast = (clientId: string, message: unknown) => {
      const target = clientId === 'fast' ? fast : slow;
      const serialized = JSON.stringify(message);
      const envelope = message as { type?: string; event?: { type?: string } };
      const coalescable = envelope?.type === 'session_event' && envelope?.event?.type === 'message_update';
      governor.send(target as any, serialized, { coalescable, clientId });
    };

    const manager = new MultiSessionManager(mockPiService, broadcast);
    await manager.subscribeClient('fast', '/flood/session.jsonl');
    await manager.subscribeClient('slow', '/flood/session.jsonl');

    // Incident shape: one growing thinking message, many small deltas.
    const partial = { role: 'assistant', content: [{ type: 'thinking', thinking: '' }] };
    const DELTAS = 4_000;
    const CHUNK = 10;
    const healthLatencies: number[] = [];

    for (let i = 0; i < DELTAS; i += 1) {
      (partial.content[0] as { thinking: string }).thinking += 'abcdefghij';
      manager.handleAgentEvent('/flood/session.jsonl', {
        type: 'message_update',
        message: { ...partial },
        assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'abcdefghij', partial },
      } as any);
      if (i % 250 === 0) healthLatencies.push(await health());
    }
    manager.handleAgentEvent('/flood/session.jsonl', {
      type: 'message_end',
      message: { ...partial },
    } as any);
    manager.handleAgentEvent('/flood/session.jsonl', { type: 'agent_end' } as any);

    sentBytes.fast = fast.sent.reduce((total, frame) => total + Buffer.byteLength(frame), 0);

    // 1. Control plane stayed responsive throughout.
    expect(Math.max(...healthLatencies)).toBeLessThan(500);

    // 2. Fast consumer's wire bytes are ~linear: 40k chars of content + envelope
    //    overhead for 4000 updates must stay far below 2 MB (the unprojected
    //    shape measured 162 MB cumulative).
    expect(sentBytes.fast).toBeLessThan(2 * 1024 * 1024);

    // 3. Fast consumer received every update in order plus the terminal events.
    const fastEvents = fast.sent.map((frame) => JSON.parse(frame) as { event?: { type?: string } });
    expect(fastEvents.filter((f) => f.event?.type === 'message_update')).toHaveLength(DELTAS);
    expect(fastEvents.filter((f) => f.event?.type === 'message_end')).toHaveLength(1);
    expect(fastEvents.filter((f) => f.event?.type === 'agent_end')).toHaveLength(1);

    // 4. Stuck consumer was closed by the governor (1013), not left queueing.
    expect(slow.closed).toBe(1013);

    // 5. Memory stayed bounded for the whole episode.
    expect(process.memoryUsage().heapUsed).toBeLessThan(1_500 * 1024 * 1024);
  }, 30_000);
});
