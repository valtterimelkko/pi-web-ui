import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';
import { PassThrough, Writable } from 'stream';
import { createSessionRoutes } from '../../../src/internal-api/routes/sessions.js';
import type { NormalizedEvent } from '@pi-web-ui/shared';

function createJsonReq(method: string, url: string, body?: unknown): IncomingMessage {
  const req = new PassThrough() as IncomingMessage;
  (req as any).method = method;
  (req as any).url = url;
  (req as any).headers = { 'content-type': 'application/json' };
  process.nextTick(() => {
    if (body !== undefined) {
      req.emit('data', Buffer.from(JSON.stringify(body)));
    }
    req.emit('end');
  });
  return req;
}

function createMockRes(): ServerResponse & { body: string; statusCode: number; chunks: string[] } {
  const chunks: Buffer[] = [];
  const res = new Writable({
    write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
      chunks.push(chunk);
      callback();
    },
  }) as unknown as ServerResponse & { body: string; statusCode: number; chunks: string[] };

  res.statusCode = 200;
  res.setHeader = vi.fn();
  res.writeHead = vi.fn(function (this: typeof res, code: number) {
    res.statusCode = code;
    return this;
  });
  res.end = vi.fn(function (this: typeof res, data?: string) {
    if (data) chunks.push(Buffer.from(data));
    res.body = Buffer.concat(chunks).toString();
    res.chunks = chunks.map((chunk) => chunk.toString());
    return this;
  });
  res.getHeader = vi.fn();
  return res;
}

describe('createSessionRoutes live-validation extensions', () => {
  let registry: any;
  let multiSessionManager: any;
  let claudeService: any;
  let opencodeService: any;
  let piService: any;
  let observerSets: Array<(event: unknown) => void>;

  beforeEach(() => {
    observerSets = [];
    registry = {
      get: vi.fn(async (sessionId: string) => ({
        id: sessionId,
        path: '/tmp/pi-session.jsonl',
        sdkType: 'pi',
        cwd: '/root/pi-web-ui',
        model: 'anthropic/claude-sonnet-4-20250514',
        firstMessage: 'hello',
        messageCount: 2,
        status: 'idle',
        createdAt: '2026-05-20T00:00:00.000Z',
        lastActivity: '2026-05-20T00:10:00.000Z',
      })),
      listAll: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue(undefined),
      upsert: vi.fn().mockResolvedValue(undefined),
    };

    const agentSession = {
      prompt: vi.fn(async () => {
        for (const observer of observerSets) {
          observer({ type: 'agent_end', sessionId: 'pi-session', timestamp: Date.now(), data: {} });
        }
      }),
      followUp: vi.fn(async () => {
        for (const observer of observerSets) {
          observer({ type: 'agent_end', sessionId: 'pi-session', timestamp: Date.now(), data: {} });
        }
      }),
      steer: vi.fn(async () => {
        for (const observer of observerSets) {
          observer({ type: 'agent_end', sessionId: 'pi-session', timestamp: Date.now(), data: {} });
        }
      }),
      setThinkingLevel: vi.fn(),
      getSessionStats: vi.fn(() => ({
        userMessages: 2,
        assistantMessages: 1,
        toolCalls: 1,
        toolResults: 1,
        totalMessages: 3,
        tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
        cost: 0.01,
      })),
      getContextUsage: vi.fn(() => ({ contextWindow: 200000, tokens: 1200, percent: 1 })),
      sessionFile: '/tmp/pi-session.jsonl',
      sessionId: 'pi-native-session',
      model: { provider: 'anthropic', id: 'claude-sonnet-4-20250514' },
    };

    multiSessionManager = {
      subscribeClient: vi.fn().mockResolvedValue(undefined),
      getAgentSession: vi.fn(() => agentSession),
      addApiObserver: vi.fn((_sessionPath: string, observer: (event: unknown) => void) => {
        observerSets.push(observer);
      }),
      removeApiObserver: vi.fn((_sessionPath: string, observer: (event: unknown) => void) => {
        observerSets = observerSets.filter((candidate) => candidate !== observer);
      }),
      pinSession: vi.fn(() => true),
      unpinSession: vi.fn(() => true),
      isSessionPinned: vi.fn(() => true),
    };

    piService = {
      setModel: vi.fn().mockResolvedValue(undefined),
    };

    claudeService = {
      isRunning: vi.fn(() => false),
      getSessionStats: vi.fn().mockResolvedValue({
        sessionId: 'claude-native-id',
        sessionFile: '/tmp/claude.jsonl',
        cwd: '/root/pi-web-ui',
        userMessages: 2,
        assistantMessages: 1,
        toolCalls: 1,
        toolResults: 1,
        totalMessages: 3,
        tokens: { input: 12, output: 8, total: 20 },
        cost: 0.02,
        model: 'sonnet',
        lastActivityAt: Date.now(),
      }),
      getContextUsage: vi.fn().mockResolvedValue({ contextWindow: 200000, tokens: 3400, percent: 2 }),
      getBackendMode: vi.fn().mockResolvedValue('channel'),
      getReplayEvents: vi.fn().mockResolvedValue([{ type: 'history_start' }]),
      sendPermissionResponse: vi.fn(),
      setModel: vi.fn().mockResolvedValue('opus'),
      setThinkingLevel: vi.fn(),
      pinSession: vi.fn(() => true),
      unpinSession: vi.fn(() => true),
      isSessionPinned: vi.fn(() => false),
      sendPrompt: vi.fn(async (_sessionId: string, _prompt: string, onEvent: (event: NormalizedEvent) => void, onComplete: (error?: Error) => void) => {
        onEvent({ type: 'agent_start', sessionId: 'claude-session', timestamp: Date.now(), data: {} });
        onEvent({ type: 'agent_end', sessionId: 'claude-session', timestamp: Date.now(), data: { usage: { input_tokens: 1, output_tokens: 1 } } });
        onComplete();
      }),
      abort: vi.fn(),
      isAvailable: vi.fn().mockResolvedValue(true),
    };

    opencodeService = {
      isRunning: vi.fn(() => false),
      getContextUsage: vi.fn(() => ({ contextWindow: 100000, tokens: 500, percent: 1 })),
      getSessionStats: vi.fn().mockResolvedValue({
        sessionId: 'oc-native-id',
        cwd: '/root/pi-web-ui',
        userMessages: 1,
        assistantMessages: 1,
        toolCalls: 1,
        toolResults: 1,
        totalMessages: 2,
        tokens: { input: 4, output: 5, cacheRead: 0, cacheWrite: 0, total: 9 },
        cost: 0.01,
        model: 'glm-4.5',
      }),
      getReplayEvents: vi.fn().mockResolvedValue([{ type: 'message_start' }]),
      replyPermission: vi.fn().mockResolvedValue(undefined),
      setModel: vi.fn().mockResolvedValue('glm-4.5'),
      pinSession: vi.fn().mockResolvedValue(true),
      unpinSession: vi.fn(() => true),
      isSessionPinned: vi.fn(() => false),
      sendPrompt: vi.fn(),
      abort: vi.fn(),
      isAvailable: vi.fn().mockResolvedValue(true),
    };
  });

  it('supports follow_up mode for Pi sessions', async () => {
    const routes = createSessionRoutes({
      claudeService,
      opencodeService,
      multiSessionManager,
      sessionRegistry: registry,
      piService,
      internalClientId: 'internal-test',
    });

    const req = createJsonReq('POST', '/api/v1/sessions/pi-session/prompt', {
      message: 'Continue',
      mode: 'follow_up',
      verbosity: 'answers',
    });
    const res = createMockRes();

    await routes.handleSendPrompt(req, res, 'pi-session');

    expect(multiSessionManager.getAgentSession().followUp).toHaveBeenCalledWith('Continue');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      sessionId: 'pi-session',
      turnComplete: true,
    });
  });

  it('rejects steer mode for Claude sessions', async () => {
    registry.get.mockResolvedValueOnce({
      id: 'claude-session',
      path: 'claude-session',
      sdkType: 'claude',
      cwd: '/root/pi-web-ui',
      model: 'sonnet',
      firstMessage: '',
      messageCount: 0,
      status: 'idle',
      createdAt: '2026-05-20T00:00:00.000Z',
      lastActivity: '2026-05-20T00:10:00.000Z',
    });

    const routes = createSessionRoutes({
      claudeService,
      opencodeService,
      multiSessionManager,
      sessionRegistry: registry,
      piService,
      internalClientId: 'internal-test',
    });

    const req = createJsonReq('POST', '/api/v1/sessions/claude-session/prompt', {
      message: 'steer this',
      mode: 'steer',
      verbosity: 'answers',
    });
    const res = createMockRes();

    await routes.handleSendPrompt(req, res, 'claude-session');

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({
      code: 'UNSUPPORTED_OPERATION',
    });
  });

  it('returns enriched session info including backend mode and context usage', async () => {
    registry.get.mockResolvedValueOnce({
      id: 'claude-session',
      path: 'claude-session',
      sdkType: 'claude',
      cwd: '/root/pi-web-ui',
      model: 'sonnet',
      firstMessage: 'hello',
      messageCount: 2,
      status: 'idle',
      createdAt: '2026-05-20T00:00:00.000Z',
      lastActivity: '2026-05-20T00:10:00.000Z',
    });

    const routes = createSessionRoutes({
      claudeService,
      opencodeService,
      multiSessionManager,
      sessionRegistry: registry,
      piService,
      internalClientId: 'internal-test',
    });

    const req = createJsonReq('GET', '/api/v1/sessions/claude-session/info');
    const res = createMockRes();

    await routes.handleGetSessionInfo(req, res, 'claude-session');

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      sessionId: 'claude-session',
      runtime: 'claude',
      backendMode: 'channel',
      tokens: { total: 20 },
      context: { contextWindow: 200000, used: 3400, percent: 2 },
      stats: { userMessages: 2, toolCalls: 1 },
      lastActivityAt: expect.any(Number),
    });
  });

  it('returns the OpenCode ses_* id as nativeSessionId for observability', async () => {
    registry.get.mockResolvedValueOnce({
      id: 'pi-opencode-session-id',
      path: 'pi-opencode-session-id',
      sdkType: 'opencode',
      opencodeSessionId: 'ses_realOpenCode123',
      cwd: '/root/opencode-plugins',
      model: 'zai-coding-plan/glm-5.1',
      firstMessage: '',
      messageCount: 0,
      status: 'idle',
      createdAt: '2026-05-20T00:00:00.000Z',
      lastActivity: '2026-05-20T00:10:00.000Z',
    });
    opencodeService.getSessionStats.mockResolvedValueOnce({
      sessionId: 'pi-opencode-session-id',
      cwd: '/root/opencode-plugins',
      userMessages: 1,
      assistantMessages: 1,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: 2,
      tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
      cost: 0,
      model: 'zai-coding-plan/glm-5.1',
    });

    const routes = createSessionRoutes({
      claudeService,
      opencodeService,
      multiSessionManager,
      sessionRegistry: registry,
      piService,
      internalClientId: 'internal-test',
    });

    const req = createJsonReq('GET', '/api/v1/sessions/pi-opencode-session-id/info');
    const res = createMockRes();

    await routes.handleGetSessionInfo(req, res, 'pi-opencode-session-id');

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      sessionId: 'pi-opencode-session-id',
      runtime: 'opencode',
      nativeSessionId: 'ses_realOpenCode123',
      model: 'zai-coding-plan/glm-5.1',
    });
  });

  it('rejects an unknown thinking level at the Internal API boundary', async () => {
    registry.get.mockResolvedValueOnce({
      id: 'claude-session',
      path: 'claude-session',
      sdkType: 'claude',
      cwd: '/root/pi-web-ui',
    });

    const routes = createSessionRoutes({
      claudeService,
      opencodeService,
      multiSessionManager,
      sessionRegistry: registry,
      piService,
      internalClientId: 'internal-test',
    });

    const res = createMockRes();
    await routes.handleSessionControl(
      createJsonReq('POST', '/api/v1/sessions/claude-session/control', {
        action: 'set_thinking_level',
        level: 'ultra',
      }),
      res,
      'claude-session',
    );

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ code: 'INVALID_REQUEST' });
    expect(claudeService.setThinkingLevel).not.toHaveBeenCalled();
  });

  it('supports session control actions and approval responses', async () => {
    registry.get
      .mockResolvedValueOnce({
        id: 'claude-session',
        path: 'claude-session',
        sdkType: 'claude',
        cwd: '/root/pi-web-ui',
      })
      .mockResolvedValueOnce({
        id: 'claude-session',
        path: 'claude-session',
        sdkType: 'claude',
        cwd: '/root/pi-web-ui',
      });

    const routes = createSessionRoutes({
      claudeService,
      opencodeService,
      multiSessionManager,
      sessionRegistry: registry,
      piService,
      internalClientId: 'internal-test',
    });

    const controlReq = createJsonReq('POST', '/api/v1/sessions/claude-session/control', {
      action: 'set_model',
      modelId: 'opus',
    });
    const controlRes = createMockRes();
    await routes.handleSessionControl(controlReq, controlRes, 'claude-session');

    expect(claudeService.setModel).toHaveBeenCalledWith('claude-session', 'opus');
    expect(JSON.parse(controlRes.body)).toMatchObject({ success: true, action: 'set_model', modelId: 'opus' });

    const approvalReq = createJsonReq('POST', '/api/v1/sessions/claude-session/approvals/perm-1/respond', {
      approved: true,
    });
    const approvalRes = createMockRes();
    await routes.handleRespondApproval(approvalReq, approvalRes, 'claude-session', 'perm-1');

    expect(claudeService.sendPermissionResponse).toHaveBeenCalledWith('claude-session', 'perm-1', true);
    expect(JSON.parse(approvalRes.body)).toMatchObject({ success: true, approved: true });
  });

  it('returns replay history for OpenCode sessions', async () => {
    registry.get.mockResolvedValueOnce({
      id: 'oc-session',
      path: 'oc-session',
      sdkType: 'opencode',
      cwd: '/root/pi-web-ui',
    });

    const routes = createSessionRoutes({
      claudeService,
      opencodeService,
      multiSessionManager,
      sessionRegistry: registry,
      piService,
      internalClientId: 'internal-test',
    });

    const req = createJsonReq('GET', '/api/v1/sessions/oc-session/history');
    const res = createMockRes();

    await routes.handleGetSessionHistory(req, res, 'oc-session');

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      sessionId: 'oc-session',
      runtime: 'opencode',
      events: [{ type: 'message_start' }],
    });
  });
});
