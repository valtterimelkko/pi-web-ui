import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Hb2: the doubled-first-chunk fix at the manager boundary. The transport
// projection neutralises streamed content on assistant message_start frames
// (see stream-transport.test.ts); the manager's skill-content transform must
// MARK its synthetic placeholder so the projection preserves it, and ordinary
// (non-skill) assistant starts must reach subscribers with typed-empty content
// so the client rebuilds the text from deltas exactly once.

interface MockAgentSession {
  sessionId: string;
  sessionFile: string;
  sessionPath: string;
  subscribe: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  setModel: ReturnType<typeof vi.fn>;
  getContextUsage: ReturnType<typeof vi.fn>;
}

interface MockPiService {
  createSession: ReturnType<typeof vi.fn>;
  getSession: ReturnType<typeof vi.fn>;
  setEventHandler: ReturnType<typeof vi.fn>;
  removeClient: ReturnType<typeof vi.fn>;
  cleanup: ReturnType<typeof vi.fn>;
}

function createMockAgentSession(overrides: Partial<{ sessionId: string; sessionFile: string }> = {}): MockAgentSession {
  const sessionId = overrides.sessionId ?? 'hb2-session-1';
  const sessionFile = overrides.sessionFile ?? '/path/to/hb2-session-1.jsonl';
  return {
    sessionId,
    sessionFile,
    sessionPath: sessionFile,
    subscribe: vi.fn(),
    dispose: vi.fn().mockResolvedValue(undefined),
    setModel: vi.fn().mockResolvedValue(undefined),
    getContextUsage: vi.fn().mockReturnValue({ contextWindow: 1000000, tokens: 100, percent: 1 }),
  };
}

function createMockPiService(): MockPiService {
  return {
    createSession: vi.fn(),
    getSession: vi.fn(),
    setEventHandler: vi.fn(),
    removeClient: vi.fn(),
    cleanup: vi.fn(),
  };
}

describe('MultiSessionManager message_start transport (Hb2)', () => {
  let mockPiService: MockPiService;
  let mockBroadcast: ReturnType<typeof vi.fn>;
  let MultiSessionManager: typeof import('../../../src/pi/multi-session-manager.js').MultiSessionManager;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockPiService = createMockPiService();
    mockBroadcast = vi.fn();

    vi.resetModules();
    vi.mock('../../../src/pi/pi-service.js', () => ({
      getPiService: () => mockPiService,
      PiService: class {},
    }));

    const module = await import('../../../src/pi/multi-session-manager.js');
    MultiSessionManager = module.MultiSessionManager;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  async function managerWithSession() {
    const mockSession = createMockAgentSession();
    mockPiService.createSession.mockResolvedValueOnce(mockSession);
    const manager = new MultiSessionManager(mockPiService as any, mockBroadcast);
    await manager.createAndSubscribe('client-1', '/work');
    mockBroadcast.mockClear();
    return manager;
  }

  function firstBroadcastEvent(): { type: string; message?: Record<string, unknown> } {
    expect(mockBroadcast.mock.calls.length).toBeGreaterThan(0);
    const envelope = mockBroadcast.mock.calls[0][1] as { event?: { type: string; message?: Record<string, unknown> } };
    return envelope.event as { type: string; message?: Record<string, unknown> };
  }

  it('broadcasts a raced assistant message_start with typed-empty content (no streamed text on the wire)', async () => {
    const manager = await managerWithSession();

    // The shape production captures show: the shared content array already
    // holds the first streamed chunk when handleAgentEvent runs.
    manager.handleAgentEvent('/path/to/hb2-session-1.jsonl', {
      type: 'message_start',
      message: { role: 'assistant', content: [{ type: 'text', text: 'HB' }], provider: 'zai' },
    });

    const event = firstBroadcastEvent();
    expect(event.type).toBe('message_start');
    expect((event.message as { content: Array<{ type: string; text?: string }> }).content)
      .toEqual([{ type: 'text', text: '' }]);
  });

  it('marks the transformed skill placeholder so the projection preserves its content', async () => {
    const manager = await managerWithSession();

    manager.handleAgentEvent('/path/to/hb2-session-1.jsonl', {
      type: 'message_start',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '<skill name="demo">instructions</skill>' }],
      },
    });

    const event = firstBroadcastEvent();
    expect(event.type).toBe('message_start');
    const message = event.message as { content: Array<{ text: string }>; customType?: string };
    expect(message.content[0].text).toContain('Skill loaded: demo');
    expect(message.customType).toBe('skill-content');
  });

  it('broadcasts a user message_start content verbatim (prompt echo)', async () => {
    const manager = await managerWithSession();

    manager.handleAgentEvent('/path/to/hb2-session-1.jsonl', {
      type: 'message_start',
      message: { role: 'user', content: [{ type: 'text', text: 'Reply with exactly one line: HB2 and nothing else.' }] },
    });

    const event = firstBroadcastEvent();
    expect((event.message as { content: Array<{ text: string }>; role: string }).role).toBe('user');
    expect((event.message as { content: Array<{ text: string }> }).content[0].text)
      .toBe('Reply with exactly one line: HB2 and nothing else.');
  });
});
