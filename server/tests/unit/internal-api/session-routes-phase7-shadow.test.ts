import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough, Writable } from 'node:stream';
import { createSessionRoutes } from '../../../src/internal-api/routes/sessions.js';
import { RunReceiptManager } from '../../../src/internal-api/run-receipts/run-receipt-manager.js';
import { RunReceiptStore } from '../../../src/internal-api/run-receipts/run-receipt-store.js';
import { PHASE7_PI_SHADOW_THRESHOLDS } from '../../../src/internal-api/phase7-pi-shadow.js';
import { clearDiagnosticsBuffer, getRecentLogs, pushDiagnosticsRecord } from '../../../src/internal-api/diagnostics-buffer.js';
import { setLogTap } from '../../../src/logging/logger.js';
import { config } from '../../../src/config.js';

function jsonReq(body: unknown): IncomingMessage {
  const req = new PassThrough() as IncomingMessage;
  (req as any).method = 'POST';
  (req as any).url = '/api/v1/sessions/pi-shadow-session/prompt';
  (req as any).headers = { 'content-type': 'application/json' };
  process.nextTick(() => {
    req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

function mockRes(): ServerResponse & { body: string; statusCode: number; headers: Record<string, unknown> } {
  const chunks: Buffer[] = [];
  const headers: Record<string, unknown> = {};
  const res = new Writable({
    write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
      chunks.push(chunk);
      callback();
    },
  }) as unknown as ServerResponse & { body: string; statusCode: number; headers: Record<string, unknown> };
  res.statusCode = 200;
  res.headers = headers;
  res.setHeader = vi.fn((name: string, value: unknown) => { headers[name] = value; }) as any;
  res.writeHead = vi.fn(function (this: typeof res, code: number) { res.statusCode = code; return this; }) as any;
  res.end = vi.fn(function (this: typeof res, data?: string | Buffer) {
    if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
    res.body = Buffer.concat(chunks).toString();
    return this;
  }) as any;
  res.write = vi.fn((data: string | Buffer) => { chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data)); return true; }) as any;
  res.getHeader = vi.fn();
  res.on = vi.fn(() => res) as any;
  return res;
}

describe('Internal API Pi Phase 7 shadow route', () => {
  let manager: RunReceiptManager;
  let routes: ReturnType<typeof createSessionRoutes>;
  let observers: Set<(event: unknown) => void>;
  let prompt: ReturnType<typeof vi.fn>;
  let originalValidationMode: boolean;

  beforeEach(async () => {
    originalValidationMode = config.validationMode;
    config.validationMode = true;
    clearDiagnosticsBuffer();
    setLogTap(pushDiagnosticsRecord);
    manager = new RunReceiptManager({
      store: new RunReceiptStore(),
      idFactory: () => 'phase7-route-run',
      turnIdleTimeoutMs: 60_000,
      turnMaxMs: 300_000,
    });
    await manager.init();
    observers = new Set();
    prompt = vi.fn(() => new Promise<void>(() => {}));
    const registry = {
      get: vi.fn().mockResolvedValue({
        id: 'pi-shadow-session',
        path: '/tmp/pi-shadow-session',
        sdkType: 'pi',
        cwd: '/root/pi-web-ui',
        model: 'openai-codex/gpt-test',
        firstMessage: '',
        messageCount: 0,
        status: 'idle',
        createdAt: new Date().toISOString(),
        lastActivity: new Date().toISOString(),
      }),
      listAll: vi.fn().mockResolvedValue([]),
      upsert: vi.fn(),
      delete: vi.fn(),
    };
    const agentSession = {
      model: { provider: 'openai-codex', id: 'gpt-test' },
      prompt,
    };
    const multiSessionManager = {
      getAgentSession: vi.fn(() => agentSession),
      subscribeClient: vi.fn().mockResolvedValue(undefined),
      unsubscribeClient: vi.fn(),
      addApiObserver: vi.fn((_path: string, observer: (event: unknown) => void) => { observers.add(observer); }),
      removeApiObserver: vi.fn((_path: string, observer: (event: unknown) => void) => { observers.delete(observer); }),
      getSessionStatus: vi.fn(() => ({ status: 'idle' })),
      pinSession: vi.fn(() => true),
      unpinSession: vi.fn(() => true),
      isSessionPinned: vi.fn(() => false),
    };
    routes = createSessionRoutes({
      claudeService: { isRunning: vi.fn(() => false) } as any,
      opencodeService: { isRunning: vi.fn(() => false), isEnabled: vi.fn(() => true) } as any,
      antigravityService: { isRunning: vi.fn(() => false) } as any,
      multiSessionManager: multiSessionManager as any,
      sessionRegistry: registry as any,
      piService: {} as any,
      internalClientId: 'phase7-test-client',
      watchDir: '/tmp/phase7-shadow-watches',
      runReceiptManager: manager,
    });
  });

  afterEach(async () => {
    config.validationMode = originalValidationMode;
    setLogTap(null);
    clearDiagnosticsBuffer();
    await routes.shutdown();
    await manager.shutdown();
  });

  it('classifies a Pi Internal API prompt without changing its existing dispatch path', async () => {
    const response = mockRes();
    await routes.handleSendPrompt(jsonReq({
      message: 'Please run npm test and report the result.',
      detach: true,
    }), response, 'pi-shadow-session');

    const body = JSON.parse(response.body);
    expect(response.statusCode).toBe(202);
    expect(body).toMatchObject({ runId: 'phase7-route-run', detached: true, status: 'accepted' });
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledWith('Please run npm test and report the result.'));
    expect(manager.get(body.runId)?.phase7Shadow).toMatchObject({
      mode: 'shadow',
      policyVersion: 'phase7-pi-shadow/v1',
      profile: 'heavy',
      resourceIdentity: { kind: 'shared-service', sessionScoped: false },
    });
  });

  it('attaches server-derived shadow evidence to batch Pi prompts', async () => {
    prompt.mockImplementation(async () => {
      for (const observer of [...observers]) {
        observer({ type: 'agent_end', sessionId: 'pi-shadow-session', timestamp: Date.now(), data: {} });
      }
    });
    const response = mockRes();
    await routes.handleBatchPrompt(jsonReq({
      prompts: [{ sessionId: 'pi-shadow-session', message: 'Please run npm test.' }],
      parallel: false,
    }), response);

    const body = JSON.parse(response.body);
    expect(response.statusCode).toBe(200);
    expect(body.successCount).toBe(1);
    const runId = body.results[0].runId as string;
    expect(manager.get(runId)?.phase7Shadow).toMatchObject({
      profile: 'heavy',
      reasonCodes: ['message_tool_signal'],
      resourceIdentity: { kind: 'shared-service', sessionScoped: false },
    });
  });

  it('does not attach shadow evidence outside disposable validation mode', async () => {
    config.validationMode = false;
    const response = mockRes();
    await routes.handleSendPrompt(jsonReq({ message: 'Keep working.', detach: true }), response, 'pi-shadow-session');
    const { runId } = JSON.parse(response.body);

    expect(manager.get(runId)?.phase7Shadow).toBeUndefined();
  });

  it('persists dynamic shadow evidence and emits bounded diagnostic metadata at terminalisation', async () => {
    const response = mockRes();
    await routes.handleSendPrompt(jsonReq({ message: 'Keep working.', detach: true }), response, 'pi-shadow-session');
    const { runId } = JSON.parse(response.body);

    await vi.waitFor(() => expect(observers.size).toBeGreaterThanOrEqual(3));
    for (let index = 0; index < PHASE7_PI_SHADOW_THRESHOLDS.toolEventCount; index += 1) {
      for (const observer of [...observers]) {
        observer({ type: 'tool_execution_start', sessionId: 'pi-shadow-session', timestamp: Date.now(), data: {} });
      }
    }
    for (const observer of [...observers]) {
      observer({ type: 'agent_end', sessionId: 'pi-shadow-session', timestamp: Date.now(), data: {} });
    }

    await vi.waitFor(() => expect(manager.get(runId)?.status).toBe('completed'));
    expect(manager.get(runId)?.phase7Shadow).toMatchObject({
      profile: 'heavy',
      reasonCodes: ['tool_event_threshold'],
      evidence: { toolEventCount: PHASE7_PI_SHADOW_THRESHOLDS.toolEventCount },
    });
    await vi.waitFor(() => expect(getRecentLogs({ runId, component: 'InternalAPI' }).some((record) => record.phase7Profile === 'heavy')).toBe(true));
    const logs = getRecentLogs({ runId, component: 'InternalAPI' });
    expect(logs.some((record) => (
      record.phase7PolicyVersion === 'phase7-pi-shadow/v1'
      && record.phase7Profile === 'heavy'
      && Array.isArray(record.phase7ReasonCodes)
      && record.phase7Affinity === 'session'
      && record.phase7AffinitySessionId === 'pi-shadow-session'
      && record.phase7ResourceIdentity === 'shared-service'
      && record.phase7ResourceBoundary === 'pi-control-process'
      && record.phase7SessionScoped === false
    ))).toBe(true);
  });
});
