/**
 * C3a (contract 1.58.0): the per-session latest-completion surface.
 *
 * Goal-driven children end in goal-engine continuation turns that hold NO
 * Internal API receipt (C2's accepted boundary), so capture on receipts alone
 * would miss most real completions. The server therefore observes every
 * session's broker-published events (pre-rate-limit, all turn sources) and
 * exposes the latest parsed completion (or parse error) per session — with
 * its source (runId, or the receipt-less session turn) and capture time — as
 * an additive `latestCompletion` field on `GET /sessions/:id`.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- route harness mirrors heterogeneous runtime service mocks */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough, Writable } from 'node:stream';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { NormalizedEvent } from '@pi-web-ui/shared';
import { createSessionRoutes, type SessionRoutesDeps } from '../../../src/internal-api/routes/sessions.js';
import { InternalApiEventBroker } from '../../../src/internal-api/event-broker.js';
import { SessionCompletionRegistry } from '../../../src/internal-api/completion/session-completion-registry.js';
import { SessionCompletionTap } from '../../../src/internal-api/completion/session-completion-tap.js';
import { RunReceiptManager } from '../../../src/internal-api/run-receipts/run-receipt-manager.js';
import { RunReceiptStore } from '../../../src/internal-api/run-receipts/run-receipt-store.js';

const e = (type: string, data: Record<string, unknown> = {}, timestamp = Date.parse('2026-07-15T12:00:05.000Z')): NormalizedEvent =>
  ({ type, timestamp, data } as NormalizedEvent);

const BLOCK_JSON = JSON.stringify({
  schema: 'pi-completion/v1',
  status: 'partial',
  summary: 'half done',
});

function turnWithBlock(blockJson: string): NormalizedEvent[] {
  return [
    e('message_start', { message: { role: 'assistant' } }),
    e('message_update', { assistantMessageEvent: { type: 'text_delta', delta: 'Working...\n' } }),
    e('message_update', { assistantMessageEvent: { type: 'text_delta', delta: '```\u200bcompletion\n' .replace('\u200b', '') } }),
    e('message_update', { assistantMessageEvent: { type: 'text_delta', delta: `${blockJson}\n` } }),
    e('message_update', { assistantMessageEvent: { type: 'text_delta', delta: '```\n' } }),
    e('agent_end', {}),
  ];
}

describe('SessionCompletionRegistry', () => {
  it('records and resolves the latest entry across alias keys, latest capturedAt wins', () => {
    const registry = new SessionCompletionRegistry({ now: () => 1000 });
    registry.record('path-alias', {
      source: { kind: 'session_turn', agentEndAt: '2026-07-15T12:00:05.000Z' },
      capturedAt: new Date(1000).toISOString(),
      completion: { schema: 'pi-completion/v1', status: 'done' },
    });
    registry.record('id-alias', {
      source: { runId: 'run-1' },
      capturedAt: new Date(2000).toISOString(),
      completion: { schema: 'pi-completion/v1', status: 'partial' },
    });
    const latest = registry.latestFor(['id-alias', 'path-alias']);
    expect(latest?.source).toEqual({ runId: 'run-1' });
    expect(latest?.completion?.status).toBe('partial');
    // A single alias also resolves.
    expect(registry.latestFor(['path-alias'])?.source).toEqual({ kind: 'session_turn', agentEndAt: '2026-07-15T12:00:05.000Z' });
    expect(registry.latestFor(['unknown'])).toBeUndefined();
  });

  it('a newer session_turn entry replaces an older receipt entry and vice versa', () => {
    const registry = new SessionCompletionRegistry({ now: () => 0 });
    registry.record('k', {
      source: { runId: 'run-1' },
      capturedAt: new Date(100).toISOString(),
      completion: { schema: 'pi-completion/v1', status: 'done' },
    });
    registry.record('k', {
      source: { kind: 'session_turn', agentEndAt: '2026-07-15T12:00:05.000Z' },
      capturedAt: new Date(200).toISOString(),
      completionError: { code: 'MALFORMED_JSON', message: 'bad' },
    });
    expect(registry.latestFor(['k'])?.completionError?.code).toBe('MALFORMED_JSON');
  });

  it('is bounded: oldest entries are evicted beyond maxEntries', () => {
    const registry = new SessionCompletionRegistry({ now: () => 0, maxEntries: 3 });
    for (let i = 0; i < 5; i++) {
      registry.record(`k${i}`, {
        source: { kind: 'session_turn', agentEndAt: '2026-07-15T12:00:05.000Z' },
        capturedAt: new Date(i).toISOString(),
      });
    }
    expect(registry.size).toBe(3);
    expect(registry.latestFor(['k0'])).toBeUndefined();
    expect(registry.latestFor(['k4'])).toBeDefined();
  });
});

describe('SessionCompletionTap over the event broker (receipt-less turns)', () => {
  it('captures the latest completion of a turn that has NO receipt, with a session_turn source', () => {
    const registry = new SessionCompletionRegistry({ now: () => Date.parse('2026-07-15T12:00:06.000Z') });
    const seen: Array<[string, NormalizedEvent]> = [];
    const broker = new InternalApiEventBroker({
      onPublish: (key, event) => { seen.push([key, event]); },
    });
    for (const event of turnWithBlock(BLOCK_JSON)) broker.publish('session-path-1', event);

    // The tap was fed every published event pre-rate-limit.
    expect(seen.length).toBe(6);

    const tap = new SessionCompletionTap({ registry, now: () => Date.parse('2026-07-15T12:00:06.000Z') });
    for (const [key, event] of seen) tap.observe(key, event);
    const latest = registry.latestFor(['session-path-1']);
    expect(latest?.source).toEqual({ kind: 'session_turn', agentEndAt: new Date(Date.parse('2026-07-15T12:00:05.000Z')).toISOString() });
    expect(latest?.completion?.status).toBe('partial');
    expect(latest?.capturedAt).toBe(new Date(Date.parse('2026-07-15T12:00:06.000Z')).toISOString());
  });

  it('captures a typed completionError for a malformed receipt-less block', () => {
    const registry = new SessionCompletionRegistry({ now: () => 0 });
    const tap = new SessionCompletionTap({ registry, now: () => 0 });
    for (const event of turnWithBlock('{"schema": oops')) tap.observe('k', event);
    expect(registry.latestFor(['k'])?.completionError?.code).toBe('MALFORMED_JSON');
  });

  it('records nothing for a turn without a block, and the next turn replaces the entry', () => {
    const registry = new SessionCompletionRegistry({ now: () => 0 });
    let tick = 0;
    const tap = new SessionCompletionTap({ registry, now: () => ++tick });
    const noBlock: NormalizedEvent[] = [
      e('message_start', { message: { role: 'assistant' } }),
      e('message_update', { assistantMessageEvent: { type: 'text_delta', delta: 'plain text' } }),
      e('agent_end', {}),
    ];
    for (const event of noBlock) tap.observe('k', event);
    expect(registry.latestFor(['k'])).toBeUndefined();

    let t = 100;
    const tap2 = new SessionCompletionTap({ registry, now: () => (t += 100) });
    for (const event of turnWithBlock(BLOCK_JSON)) tap2.observe('k', event);
    expect(registry.latestFor(['k'])?.completion?.status).toBe('partial');
  });

  it('never throws on adversarial event shapes', () => {
    const registry = new SessionCompletionRegistry({ now: () => 0 });
    const tap = new SessionCompletionTap({ registry, now: () => 0 });
    expect(() => {
      tap.observe('k', e('message_start', {} as Record<string, unknown>));
      tap.observe('k', e('message_update', {} as Record<string, unknown>));
      tap.observe('k', e('agent_end', {} as Record<string, unknown>));
      tap.observe('k', undefined as unknown as NormalizedEvent);
    }).not.toThrow();
  });
});

describe('C3a — latestCompletion on GET /sessions/:id', () => {
  let dir: string;
  let registry: any;
  let claudeService: any;
  let opencodeService: any;
  let antigravityService: any;
  let multiSessionManager: any;
  let piService: any;
  let manager: RunReceiptManager;
  let routes: ReturnType<typeof createSessionRoutes>;
  let completionRegistry: SessionCompletionRegistry;
  let now: number;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-c3a-surface-'));
    now = Date.parse('2026-07-15T12:00:00.000Z');
    registry = {
      get: vi.fn().mockResolvedValue(entry()),
      listAll: vi.fn().mockResolvedValue([entry()]),
      upsert: vi.fn().mockResolvedValue(undefined),
      patchSessionMeta: vi.fn().mockResolvedValue(undefined),
    };
    claudeService = {
      executionBackend: vi.fn(() => 'sdk-subscription'),
      isAvailable: vi.fn().mockResolvedValue(true),
      isRunning: vi.fn(() => false),
      sendPrompt: vi.fn(),
      isPendingAskUserQuestion: vi.fn(() => false),
      respondToAskUserQuestion: vi.fn(() => true),
      wasRecentlyResolvedAskUserQuestion: vi.fn(() => false),
      sendPermissionResponse: vi.fn(),
      getSessionStats: vi.fn().mockResolvedValue(null),
      getContextUsage: vi.fn().mockResolvedValue(null),
      getBackendMode: vi.fn().mockResolvedValue('sdk'),
    };
    opencodeService = { isAvailable: vi.fn().mockResolvedValue(true), isRunning: vi.fn(() => false), replyPermission: vi.fn() };
    antigravityService = { isAvailable: vi.fn().mockResolvedValue(true), isRunning: vi.fn(() => false) };
    piService = { setModel: vi.fn().mockResolvedValue(undefined) };
    multiSessionManager = {
      getAgentSession: vi.fn(() => null),
      getSessionStatus: vi.fn(() => ({ status: 'idle' })),
      isSessionPinned: vi.fn(() => false),
      subscribeClient: vi.fn().mockResolvedValue(undefined),
      unsubscribeClient: vi.fn().mockResolvedValue(undefined),
      addApiObserver: vi.fn(),
      removeApiObserver: vi.fn(),
      getAllSessionStatuses: vi.fn(() => []),
    };
    completionRegistry = new SessionCompletionRegistry({ now: () => now });
  });

  afterEach(async () => {
    await routes?.shutdown();
    await manager?.shutdown();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  function entry(overrides: Record<string, unknown> = {}) {
    return {
      id: 'session-1',
      path: 'session-1',
      sdkType: 'pi',
      cwd: '/root/pi-web-ui',
      model: 'provider/model',
      firstMessage: 'first',
      messageCount: 0,
      status: 'idle',
      createdAt: '2026-07-15T12:00:00.000Z',
      lastActivity: '2026-07-15T12:00:00.000Z',
      ...overrides,
    };
  }

  async function makeRoutes() {
    manager = new RunReceiptManager({
      store: new RunReceiptStore(dir, { now: () => now }),
      now: () => now,
      idFactory: (() => { let n = 0; return () => `run-${++n}`; })(),
    });
    await manager.init();
    routes = createSessionRoutes({
      claudeService,
      opencodeService,
      antigravityService,
      multiSessionManager: multiSessionManager as unknown as SessionRoutesDeps['multiSessionManager'],
      sessionRegistry: registry,
      piService,
      internalClientId: 'test-client',
      watchDir: path.join(dir, 'watches'),
      pinDir: path.join(dir, 'pins'),
      pinExpiryIntervalMs: 60_000,
      runReceiptManager: manager,
      sessionCompletionRegistry: completionRegistry,
    });
  }

  function mockRes(): ServerResponse & { body: string; statusCode: number } {
    const chunks: Buffer[] = [];
    const res = new Writable({
      write(chunk: Buffer, _enc: BufferEncoding, cb: (error?: Error | null) => void) { chunks.push(chunk); cb(); },
    }) as unknown as ServerResponse & { body: string; statusCode: number };
    res.statusCode = 200;
    res.setHeader = vi.fn() as any;
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

  it('exposes the latest completion from a receipt-less session turn (goal-continuation shape)', async () => {
    await makeRoutes();
    completionRegistry.record('session-1', {
      source: { kind: 'session_turn', agentEndAt: '2026-07-15T12:00:05.000Z' },
      capturedAt: new Date(now + 5000).toISOString(),
      completion: { schema: 'pi-completion/v1', status: 'done', summary: 'goal turn finished' },
    });

    const res = mockRes();
    await routes.handleGetSession(jsonReq('GET', '/api/v1/sessions/session-1'), res, 'session-1');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.latestCompletion?.source).toEqual({ kind: 'session_turn', agentEndAt: '2026-07-15T12:00:05.000Z' });
    expect(body.latestCompletion?.completion?.status).toBe('done');
    expect(body.latestCompletion?.capturedAt).toBe(new Date(now + 5000).toISOString());
    expect(body.latestCompletion?.completionError).toBeUndefined();
  });

  it('resolves a Pi path-keyed entry when the id key has none, and prefers the newest across aliases', async () => {
    await makeRoutes();
    registry.get.mockResolvedValue(entry({ id: 'session-1', path: '/root/.pi/agent/sessions/p-xyz.jsonl' }));
    completionRegistry.record('/root/.pi/agent/sessions/p-xyz.jsonl', {
      source: { kind: 'session_turn', agentEndAt: '2026-07-15T12:00:05.000Z' },
      capturedAt: new Date(now + 1000).toISOString(),
      completion: { schema: 'pi-completion/v1', status: 'blocked', blockedReason: 'waiting on approval' },
    });

    const res = mockRes();
    await routes.handleGetSession(jsonReq('GET', '/api/v1/sessions/session-1'), res, 'session-1');
    const body = JSON.parse(res.body);
    expect(body.latestCompletion?.completion?.status).toBe('blocked');
  });

  it('omits latestCompletion entirely when nothing was captured (additive absence)', async () => {
    await makeRoutes();
    const res = mockRes();
    await routes.handleGetSession(jsonReq('GET', '/api/v1/sessions/session-1'), res, 'session-1');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.latestCompletion).toBeUndefined();
  });

  it('exposes a completionError surface for a malformed receipt-less block', async () => {
    await makeRoutes();
    completionRegistry.record('session-1', {
      source: { kind: 'session_turn', agentEndAt: '2026-07-15T12:00:05.000Z' },
      capturedAt: new Date(now + 5000).toISOString(),
      completionError: { code: 'SCHEMA_VIOLATION', message: 'bad', fieldPath: 'status' },
    });
    const res = mockRes();
    await routes.handleGetSession(jsonReq('GET', '/api/v1/sessions/session-1'), res, 'session-1');
    const body = JSON.parse(res.body);
    expect(body.latestCompletion?.completionError?.code).toBe('SCHEMA_VIOLATION');
    expect(body.latestCompletion?.completion).toBeUndefined();
  });

  function jsonReq(method: string, url: string, body?: unknown): IncomingMessage {
    const req = new PassThrough() as IncomingMessage;
    (req as any).method = method;
    (req as any).url = url;
    (req as any).headers = { 'content-type': 'application/json' };
    process.nextTick(() => {
      if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)));
      req.emit('end');
    });
    return req;
  }
});
