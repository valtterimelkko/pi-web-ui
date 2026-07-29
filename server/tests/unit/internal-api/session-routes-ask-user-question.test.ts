import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';
import { PassThrough, Writable } from 'stream';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createSessionRoutes } from '../../../src/internal-api/routes/sessions.js';

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

function createMockRes(): ServerResponse & { body: string; statusCode: number } {
  const chunks: Buffer[] = [];
  const res = new Writable({
    write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
      chunks.push(chunk);
      callback();
    },
  }) as unknown as ServerResponse & { body: string; statusCode: number };

  res.statusCode = 200;
  res.setHeader = vi.fn();
  res.writeHead = vi.fn(function (this: typeof res, code: number) {
    res.statusCode = code;
    return this;
  });
  res.end = vi.fn(function (this: typeof res, data?: string) {
    if (data) chunks.push(Buffer.from(data));
    res.body = Buffer.concat(chunks).toString();
    return this;
  });
  res.getHeader = vi.fn();
  return res;
}

function json(res: { body: string }): any {
  return JSON.parse(res.body);
}

describe('createSessionRoutes — AskUserQuestion approval responses', () => {
  let dir: string;
  let registry: any;
  let claudeService: any;
  let opencodeService: any;
  let antigravityService: any;
  let multiSessionManager: any;
  let piService: any;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-auq-routes-'));

    registry = {
      get: vi.fn(async (sessionId: string) => ({
        id: sessionId,
        path: sessionId,
        sdkType: 'claude',
        cwd: '/root/proj',
        model: 'sonnet',
        firstMessage: '',
        messageCount: 0,
        status: 'idle',
      })),
      listAll: vi.fn().mockResolvedValue([]),
      upsert: vi.fn().mockResolvedValue(undefined),
    };

    claudeService = {
      isRunning: vi.fn(() => false),
      isAvailable: vi.fn().mockResolvedValue(true),
      sendPermissionResponse: vi.fn(),
      isPendingAskUserQuestion: vi.fn(() => false),
      respondToAskUserQuestion: vi.fn(() => true),
      wasRecentlyResolvedAskUserQuestion: vi.fn(() => false),
      resolveAskUserQuestionKey: vi.fn(() => undefined),
      hasChannelSession: vi.fn(() => false),
      getBackendMode: vi.fn().mockResolvedValue('sdk'),
    };
    opencodeService = {
      isAvailable: vi.fn().mockResolvedValue(true),
      replyPermission: vi.fn().mockResolvedValue(undefined),
    };
    antigravityService = { isAvailable: vi.fn().mockResolvedValue(true) };
    multiSessionManager = {};
    piService = {};
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  function makeRoutes() {
    return createSessionRoutes({
      claudeService,
      opencodeService,
      antigravityService,
      multiSessionManager,
      sessionRegistry: registry,
      piService,
      internalClientId: 'internal-test',
      watchDir: path.join(dir, 'watches'),
      pinDir: path.join(dir, 'pins'),
      pinExpiryIntervalMs: 60_000,
    });
  }

  it('routes a pending AskUserQuestion answer to claudeService.respondToAskUserQuestion', async () => {
    claudeService.isPendingAskUserQuestion.mockReturnValue(true);
    const routes = makeRoutes();

    const req = createJsonReq('POST', '/api/v1/sessions/sess-1/approvals/req-1/respond', {
      approved: true,
      answers: { 'Pick a colour?': 'Blue' },
    });
    const res = createMockRes();
    await routes.handleRespondApproval(req, res, 'sess-1', 'req-1');

    expect(res.statusCode).toBe(200);
    expect(json(res)).toMatchObject({ success: true, approved: true });
    expect(claudeService.respondToAskUserQuestion).toHaveBeenCalledWith('req-1', {
      answers: { 'Pick a colour?': 'Blue' },
    });
    // Must NOT also fall through to the channel permission path.
    expect(claudeService.sendPermissionResponse).not.toHaveBeenCalled();
  });

  it('forwards answers and annotations together', async () => {
    claudeService.isPendingAskUserQuestion.mockReturnValue(true);
    const routes = makeRoutes();

    const req = createJsonReq('POST', '/x', {
      approved: true,
      answers: { 'Pick features': 'Search, Export' },
      annotations: { 'Pick features': { notes: 'multi-select' } },
    });
    const res = createMockRes();
    await routes.handleRespondApproval(req, res, 'sess-1', 'req-2');

    expect(claudeService.respondToAskUserQuestion).toHaveBeenCalledWith('req-2', {
      answers: { 'Pick features': 'Search, Export' },
      annotations: { 'Pick features': { notes: 'multi-select' } },
    });
  });

  it('maps a cancelled approval to a cancelled resolution', async () => {
    claudeService.isPendingAskUserQuestion.mockReturnValue(true);
    const routes = makeRoutes();

    const req = createJsonReq('POST', '/x', { approved: true, cancelled: true });
    const res = createMockRes();
    await routes.handleRespondApproval(req, res, 'sess-1', 'req-3');

    expect(claudeService.respondToAskUserQuestion).toHaveBeenCalledWith('req-3', { cancelled: true });
    expect(claudeService.sendPermissionResponse).not.toHaveBeenCalled();
  });

  it('rejects malformed AskUserQuestion answer payloads instead of forwarding them', async () => {
    claudeService.isPendingAskUserQuestion.mockReturnValue(true);
    const routes = makeRoutes();

    const req = createJsonReq('POST', '/x', {
      approved: true,
      answers: { 'Pick a colour?': ['Blue'] },
    });
    const res = createMockRes();
    await routes.handleRespondApproval(req, res, 'sess-1', 'req-bad');

    expect(res.statusCode).toBe(400);
    expect(json(res).code).toBe('INVALID_REQUEST');
    expect(claudeService.respondToAskUserQuestion).not.toHaveBeenCalled();
  });

  it('still routes non-AskUserQuestion Claude approvals via sendPermissionResponse for channel sessions', async () => {
    claudeService.isPendingAskUserQuestion.mockReturnValue(false);
    claudeService.hasChannelSession.mockReturnValue(true);
    const routes = makeRoutes();

    const req = createJsonReq('POST', '/x', { approved: true });
    const res = createMockRes();
    await routes.handleRespondApproval(req, res, 'sess-1', 'perm-1');

    expect(claudeService.sendPermissionResponse).toHaveBeenCalledWith('sess-1', 'perm-1', true);
    expect(claudeService.respondToAskUserQuestion).not.toHaveBeenCalled();
  });

  it('returns 409 ASK_ALREADY_CLOSED for an answer to an already-closed AskUserQuestion (not a silent 200)', async () => {
    claudeService.isPendingAskUserQuestion.mockReturnValue(false);
    claudeService.wasRecentlyResolvedAskUserQuestion.mockReturnValue(true);
    const routes = makeRoutes();

    const req = createJsonReq('POST', '/x', { approved: true, answers: { 'Pick a colour?': 'Blue' } });
    const res = createMockRes();
    await routes.handleRespondApproval(req, res, 'sess-1', 'req-stale');

    expect(res.statusCode).toBe(409);
    expect(json(res).code).toBe('ASK_ALREADY_CLOSED');
    // Must NOT be misrouted to the channel permission path.
    expect(claudeService.sendPermissionResponse).not.toHaveBeenCalled();
    expect(claudeService.respondToAskUserQuestion).not.toHaveBeenCalled();
  });

  it('returns 409 when a pending AskUserQuestion is resolved between check and respond (race)', async () => {
    claudeService.isPendingAskUserQuestion.mockReturnValue(true);
    claudeService.respondToAskUserQuestion.mockReturnValue(false); // resolved mid-flight
    const routes = makeRoutes();

    const req = createJsonReq('POST', '/x', { approved: true, answers: { 'Pick a colour?': 'Blue' } });
    const res = createMockRes();
    await routes.handleRespondApproval(req, res, 'sess-1', 'req-race');

    expect(res.statusCode).toBe(409);
    expect(json(res).code).toBe('ASK_ALREADY_CLOSED');
  });

  it('9. responding with an unknown requestId returns 404 and does not call sendPermissionResponse', async () => {
    claudeService.isPendingAskUserQuestion.mockReturnValue(false);
    claudeService.resolveAskUserQuestionKey.mockReturnValue(undefined);
    claudeService.hasChannelSession.mockReturnValue(false);
    const routes = makeRoutes();

    const req = createJsonReq('POST', '/api/v1/sessions/sess-1/approvals/unknown-id/respond', {
      approved: true,
      answers: { 'Pick a colour?': 'Blue' },
    });
    const res = createMockRes();
    await routes.handleRespondApproval(req, res, 'sess-1', 'unknown-id');

    expect(res.statusCode).toBe(404);
    expect(json(res).code).toBe('APPROVAL_REQUEST_NOT_FOUND');
    expect(claudeService.sendPermissionResponse).not.toHaveBeenCalled();
    expect(claudeService.respondToAskUserQuestion).not.toHaveBeenCalled();
  });

  it('10. responding with the toolCallId resolves the pending question and forwards answers to the SDK', async () => {
    claudeService.resolveAskUserQuestionKey.mockReturnValue({
      requestId: 'req-uuid',
      toolCallId: 'toolu_01Q3yFLqb2Q4xbgiySCvkdHh',
      sessionId: 'sess-1',
    });
    claudeService.respondToAskUserQuestion.mockReturnValue(true);
    const routes = makeRoutes();

    const req = createJsonReq('POST', '/api/v1/sessions/sess-1/approvals/toolu_01Q3yFLqb2Q4xbgiySCvkdHh/respond', {
      approved: true,
      answers: { 'Pick a colour?': 'Blue' },
    });
    const res = createMockRes();
    await routes.handleRespondApproval(req, res, 'sess-1', 'toolu_01Q3yFLqb2Q4xbgiySCvkdHh');

    expect(res.statusCode).toBe(200);
    expect(claudeService.respondToAskUserQuestion).toHaveBeenCalledWith('req-uuid', {
      answers: { 'Pick a colour?': 'Blue' },
    });
  });

  it('11. responding with a valid requestId but the wrong sessionId returns 404', async () => {
    claudeService.resolveAskUserQuestionKey.mockReturnValue({
      requestId: 'req-uuid',
      toolCallId: 'toolu_01Q3yFLqb2Q4xbgiySCvkdHh',
      sessionId: 'other-sess',
    });
    const routes = makeRoutes();

    const req = createJsonReq('POST', '/api/v1/sessions/sess-1/approvals/req-uuid/respond', {
      approved: true,
      answers: { 'Pick a colour?': 'Blue' },
    });
    const res = createMockRes();
    await routes.handleRespondApproval(req, res, 'sess-1', 'req-uuid');

    expect(res.statusCode).toBe(404);
    expect(json(res).code).toBe('APPROVAL_REQUEST_NOT_FOUND');
    expect(claudeService.respondToAskUserQuestion).not.toHaveBeenCalled();
    expect(claudeService.sendPermissionResponse).not.toHaveBeenCalled();
  });

  it('12. a channel-backed session still routes non-AskUserQuestion responses to sendPermissionResponse', async () => {
    claudeService.isPendingAskUserQuestion.mockReturnValue(false);
    claudeService.resolveAskUserQuestionKey.mockReturnValue(undefined);
    claudeService.hasChannelSession.mockReturnValue(true);
    const routes = makeRoutes();

    const req = createJsonReq('POST', '/api/v1/sessions/sess-1/approvals/perm-1/respond', { approved: true });
    const res = createMockRes();
    await routes.handleRespondApproval(req, res, 'sess-1', 'perm-1');

    expect(res.statusCode).toBe(200);
    expect(claudeService.sendPermissionResponse).toHaveBeenCalledWith('sess-1', 'perm-1', true);
    expect(claudeService.respondToAskUserQuestion).not.toHaveBeenCalled();
  });

  it('13. success body carries resolved, requestId and toolCallId', async () => {
    claudeService.resolveAskUserQuestionKey.mockReturnValue({
      requestId: 'req-uuid',
      toolCallId: 'toolu_01Q3yFLqb2Q4xbgiySCvkdHh',
      sessionId: 'sess-1',
    });
    claudeService.respondToAskUserQuestion.mockReturnValue(true);
    const routes = makeRoutes();

    const req = createJsonReq('POST', '/api/v1/sessions/sess-1/approvals/toolu_01Q3yFLqb2Q4xbgiySCvkdHh/respond', {
      approved: true,
      answers: { 'Pick a colour?': 'Blue' },
    });
    const res = createMockRes();
    await routes.handleRespondApproval(req, res, 'sess-1', 'toolu_01Q3yFLqb2Q4xbgiySCvkdHh');

    expect(res.statusCode).toBe(200);
    const body = json(res);
    expect(body).toMatchObject({
      success: true,
      resolved: true,
      kind: 'ask_user_question',
      sessionId: 'sess-1',
      requestId: 'req-uuid',
      toolCallId: 'toolu_01Q3yFLqb2Q4xbgiySCvkdHh',
    });
  });
});
