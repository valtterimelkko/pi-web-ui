/**
 * Steering routing on the real WebSocketConnectionManager:
 * - Claude sessions route steer/follow_up to the Claude service facade.
 * - Command Code steer interrupts the running turn and delivers the text as
 *   the next prompt; follow_up queues and is drained when the run ends.
 * - Plain prompts to a running Claude session fail fast with SESSION_BUSY.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { claudeMock, opencodeMock, antigravityMock, piMock, registryMock } = vi.hoisted(() => {
  const noopRecursive: any = new Proxy(function noop() {}, {
    get: () => noopRecursive,
    apply: () => undefined,
  });
  return {
    claudeMock: {
      isAvailable: vi.fn().mockResolvedValue(true),
      isRunning: vi.fn().mockReturnValue(false),
      sendPrompt: vi.fn(),
      steer: vi.fn(),
      followUp: vi.fn(),
      abort: vi.fn(),
      hasSession: vi.fn().mockReturnValue(false),
      getSessionState: vi.fn(),
      setThinkingLevel: vi.fn(),
      createSession: vi.fn(),
      listSessions: vi.fn().mockResolvedValue([]),
      validateAuth: vi.fn().mockResolvedValue({ ok: true }),
      stop: vi.fn().mockResolvedValue(undefined),
    },
    opencodeMock: { isAvailable: vi.fn().mockResolvedValue(true), validateSetup: vi.fn().mockResolvedValue({ ok: true }), isPendingPermission: vi.fn().mockReturnValue(false), resolvePermission: vi.fn(), listSessions: vi.fn().mockResolvedValue([]), shutdown: vi.fn().mockResolvedValue(undefined) },
    antigravityMock: { isAvailable: vi.fn().mockResolvedValue(true), validateSetup: vi.fn().mockResolvedValue({ ok: true }), listSessions: vi.fn().mockResolvedValue([]), shutdown: vi.fn().mockResolvedValue(undefined) },
    piMock: noopRecursive,
    registryMock: { upsert: vi.fn(), updateStatus: vi.fn(), get: vi.fn().mockResolvedValue(undefined), list: vi.fn().mockResolvedValue([]) },
  };
});

vi.mock('../../../src/claude/index.js', () => ({ getClaudeService: () => claudeMock }));
vi.mock('../../../src/opencode/index.js', () => ({ getOpenCodeService: () => opencodeMock }));
vi.mock('../../../src/antigravity/index.js', () => ({ getAntigravityService: () => antigravityMock }));
vi.mock('../../../src/pi/index.js', () => ({ getPiService: () => piMock }));
vi.mock('../../../src/pi/session-list-cache.js', () => ({ getPiSessionListCache: () => ({ list: () => Promise.resolve([]) }) }));
vi.mock('../../../src/session-registry.js', () => ({
  getSessionRegistry: () => registryMock,
  resolveCanonicalSessionId: vi.fn().mockResolvedValue('canonical'),
}));

import { WebSocketConnectionManager } from '../../../src/websocket/connection.js';

const TEXT = 'Please pivot to the database schema now.';
const PATH = '/claude/session-a';

describe('WebSocket steering routing', () => {
  let mgr: WebSocketConnectionManager;
  let sent: Array<{ message: { type: string; code?: string } }>;

  beforeEach(() => {
    vi.clearAllMocks();
    mgr = new WebSocketConnectionManager();
    sent = [];
    (mgr as any).sendMessage = (_clientId: string, message: unknown) => {
      sent.push({ message: message as { type: string; code?: string } });
    };
    (mgr as any).multiSessionManager = {
      getClientSessionPath: () => '/pi/session.jsonl',
      getAgentSession: () => ({ steer: vi.fn(), followUp: vi.fn(), prompt: vi.fn() }),
      getSessionStatus: () => ({ status: 'idle' }),
      dispose: () => {},
    };
  });

  describe('claude sessions', () => {
    beforeEach(() => {
      (mgr as any).claudeSessionIds.add(PATH);
      (mgr as any).clientViewingSession.set('c1', PATH);
    });

    it('steer routes to the Claude service facade', async () => {
      claudeMock.steer.mockReturnValueOnce(true);
      await (mgr as any).handleSteer('c1', { type: 'steer', message: TEXT });
      expect(claudeMock.steer).toHaveBeenCalledWith(PATH, TEXT);
      expect(sent.find((s) => s.message.type === 'error')).toBeUndefined();
    });

    it('steer reports SESSION_BUSY when the facade cannot steer (no live run)', async () => {
      claudeMock.steer.mockReturnValueOnce(false);
      await (mgr as any).handleSteer('c1', { type: 'steer', message: TEXT });
      expect(sent.find((s) => s.message.code === 'STEER_NOT_RUNNING')).toBeDefined();
    });

    it('follow_up routes to the Claude service facade', async () => {
      claudeMock.followUp.mockReturnValueOnce(true);
      await (mgr as any).handleFollowUp('c1', { type: 'follow_up', message: TEXT });
      expect(claudeMock.followUp).toHaveBeenCalledWith(PATH, TEXT);
      expect(sent.find((s) => s.message.type === 'error')).toBeUndefined();
    });

    it('a plain prompt to a running Claude session fails fast with SESSION_BUSY', async () => {
      claudeMock.isRunning.mockReturnValueOnce(true);
      await (mgr as any).handlePrompt('c1', { type: 'prompt', sessionId: PATH, message: TEXT });
      expect(claudeMock.sendPrompt).not.toHaveBeenCalled();
      expect(sent.find((s) => s.message.code === 'SESSION_BUSY')).toBeDefined();
    });
  });

  describe('command code sessions', () => {
    let cmdService: {
      isRunning: ReturnType<typeof vi.fn>;
      abort: ReturnType<typeof vi.fn>;
      waitForTurnEnd: ReturnType<typeof vi.fn>;
      sendPrompt: ReturnType<typeof vi.fn>;
      hasSession: ReturnType<typeof vi.fn>;
      shutdown: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
      cmdService = {
        isRunning: vi.fn().mockReturnValue(false),
        abort: vi.fn().mockResolvedValue(undefined),
        waitForTurnEnd: vi.fn().mockResolvedValue(undefined),
        sendPrompt: vi.fn().mockResolvedValue(undefined),
        hasSession: vi.fn().mockResolvedValue(true),
        shutdown: vi.fn().mockResolvedValue(undefined),
      };
      (mgr as any).commandCodeService = cmdService;
      (mgr as any).commandCodeSessionIds.add(PATH);
      (mgr as any).clientViewingSession.set('c1', PATH);
      (mgr as any).getCommandCodeSubscribers = () => new Set(['c1']);
    });

    it('steer while idle is delivered as a normal prompt', async () => {
      await (mgr as any).handleSteer('c1', { type: 'steer', message: TEXT });
      expect(cmdService.sendPrompt).toHaveBeenCalledWith(PATH, TEXT, expect.any(Function), expect.any(Function));
      expect(cmdService.abort).not.toHaveBeenCalled();
    });

    it('steer while running aborts the turn, waits for it, then prompts the steer text', async () => {
      cmdService.isRunning.mockImplementation(() => cmdService.sendPrompt.mock.calls.length === 0);
      await (mgr as any).handleSteer('c1', { type: 'steer', message: TEXT });
      expect(cmdService.abort).toHaveBeenCalledWith(PATH);
      expect(cmdService.waitForTurnEnd).toHaveBeenCalledWith(PATH);
      expect(cmdService.sendPrompt).toHaveBeenCalledWith(PATH, TEXT, expect.any(Function), expect.any(Function));
    });

    it('follow_up while running is queued and drained after the run ends', async () => {
      cmdService.isRunning.mockReturnValueOnce(true).mockReturnValue(false);
      await (mgr as any).handleFollowUp('c1', { type: 'follow_up', message: 'queued text' });
      expect(cmdService.sendPrompt).not.toHaveBeenCalled();

      // The run ends (a normal prompt completes) → queue drains.
      await (mgr as any).handlePrompt('c1', { type: 'prompt', sessionId: PATH, message: 'main task' });
      expect(cmdService.sendPrompt).toHaveBeenCalledTimes(2);
      expect(cmdService.sendPrompt).toHaveBeenNthCalledWith(1, PATH, 'main task', expect.any(Function), expect.any(Function));
      expect(cmdService.sendPrompt).toHaveBeenNthCalledWith(2, PATH, 'queued text', expect.any(Function), expect.any(Function));
    });

    it('follow-ups queue in order and chain one after another', async () => {
      cmdService.isRunning.mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValue(false);
      await (mgr as any).handleFollowUp('c1', { type: 'follow_up', message: 'first' });
      await (mgr as any).handleFollowUp('c1', { type: 'follow_up', message: 'second' });
      expect(cmdService.sendPrompt).not.toHaveBeenCalled();

      await (mgr as any).handlePrompt('c1', { type: 'prompt', sessionId: PATH, message: 'main' });
      expect(cmdService.sendPrompt).toHaveBeenCalledTimes(3);
      expect(cmdService.sendPrompt).toHaveBeenNthCalledWith(2, PATH, 'first', expect.any(Function), expect.any(Function));
      expect(cmdService.sendPrompt).toHaveBeenNthCalledWith(3, PATH, 'second', expect.any(Function), expect.any(Function));
    });

    it('aborting the session drops queued follow-ups', async () => {
      cmdService.isRunning.mockReturnValueOnce(true).mockReturnValue(true);
      await (mgr as any).handleFollowUp('c1', { type: 'follow_up', message: 'queued text' });
      await (mgr as any).handleAbort('c1');
      cmdService.isRunning.mockReturnValue(false);
      // A later normal prompt must NOT trigger the dropped follow-up.
      await (mgr as any).handlePrompt('c1', { type: 'prompt', sessionId: PATH, message: 'next task' });
      expect(cmdService.sendPrompt).toHaveBeenCalledTimes(1);
    });
  });
});
