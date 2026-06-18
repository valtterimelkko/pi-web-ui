import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';
import { PassThrough, Writable } from 'stream';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createSessionRoutes } from '../../../src/internal-api/routes/sessions.js';

function createJsonReq(method: string, url: string, body?: unknown): IncomingMessage {
  const req = new PassThrough() as unknown as IncomingMessage;
  (req as { method?: string }).method = method;
  (req as { url?: string }).url = url;
  (req as { headers?: Record<string, string> }).headers = { 'content-type': 'application/json' };
  process.nextTick(() => {
    if (body !== undefined) (req as PassThrough).emit('data', Buffer.from(JSON.stringify(body)));
    (req as PassThrough).emit('end');
  });
  return req;
}

function createMockRes(): ServerResponse & { body: string; statusCode: number } {
  const chunks: Buffer[] = [];
  const res = new Writable({
    write(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null) => void) { chunks.push(chunk); cb(); },
  }) as unknown as ServerResponse & { body: string; statusCode: number };
  res.statusCode = 200;
  res.setHeader = vi.fn();
  res.writeHead = vi.fn(function (this: typeof res, code: number) { res.statusCode = code; return this; }) as never;
  res.write = vi.fn(function (chunk: Buffer | string) { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); return true; }) as never;
  res.end = vi.fn(function (this: typeof res, data?: string | Buffer) {
    if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
    res.body = Buffer.concat(chunks).toString();
    return this;
  }) as never;
  res.on = vi.fn(() => res) as never;
  return res;
}

const ev = (type: string, data: Record<string, unknown> = {}) => ({ type, timestamp: Date.now(), data });

describe('watch routes — POST/GET/DELETE /sessions/:id/watch', () => {
  let dir: string;
  let registry: { get: ReturnType<typeof vi.fn> };
  let observers: Array<(e: unknown) => void>;
  let multiSessionManager: Record<string, ReturnType<typeof vi.fn>>;
  let routes: ReturnType<typeof createSessionRoutes>;

  const piEntry = { id: 'pi-1', path: 'pi-1', sdkType: 'pi', cwd: '/tmp', firstMessage: '', messageCount: 0, status: 'idle', createdAt: '', lastActivity: '' };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-watch-routes-'));
    observers = [];
    registry = { get: vi.fn().mockResolvedValue(piEntry) };
    multiSessionManager = {
      addApiObserver: vi.fn((_p: string, o: (e: unknown) => void) => observers.push(o)),
      removeApiObserver: vi.fn(),
      pinSession: vi.fn(() => true),
    };
    routes = createSessionRoutes({
      claudeService: {} as never,
      opencodeService: {} as never,
      antigravityService: {} as never,
      multiSessionManager: multiSessionManager as never,
      sessionRegistry: registry as never,
      piService: {} as never,
      internalClientId: 'test',
      watchDir: dir,
    });
  });

  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 50)); // let in-flight ledger writes settle
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  function emit(event: unknown) {
    for (const o of observers) o(event);
  }

  it('registers a watch, records firings with no live consumer, and reports allFired', async () => {
    const reg = createMockRes();
    await routes.handleRegisterWatch(
      createJsonReq('POST', '/api/v1/sessions/pi-1/watch', { conditions: [{ type: 'tool', toolName: 'Bash' }, { type: 'event_type', eventType: 'agent_end' }] }),
      reg, 'pi-1',
    );
    expect(reg.statusCode).toBe(201);
    const created = JSON.parse(reg.body);
    expect(created.conditions).toHaveLength(2);
    expect(created.pinned).toBe(true);
    expect(multiSessionManager.pinSession).toHaveBeenCalledWith('pi-1');

    // No /events subscriber — only the standing watch observes.
    emit(ev('tool_execution_start', { toolName: 'Bash' }));
    emit(ev('agent_end'));

    const get = createMockRes();
    await routes.handleGetWatch(createJsonReq('GET', '/api/v1/sessions/pi-1/watch'), get, 'pi-1', new URLSearchParams());
    const watch = JSON.parse(get.body);
    expect(watch.allFired).toBe(true);
    expect(watch.firingCount).toBe(2);
    expect(watch.snapshot.toolCallCount).toBe(1);
  });

  it('supports ?sinceIndex for incremental polling', async () => {
    await routes.handleRegisterWatch(
      createJsonReq('POST', '/api/v1/sessions/pi-1/watch', { conditions: [{ type: 'tool', toolName: 'Bash', once: false }] }),
      createMockRes(), 'pi-1',
    );
    emit(ev('tool_execution_start', { toolName: 'Bash' }));
    emit(ev('tool_execution_start', { toolName: 'Bash' }));

    const get = createMockRes();
    await routes.handleGetWatch(createJsonReq('GET', '/api/v1/sessions/pi-1/watch?sinceIndex=1'), get, 'pi-1', new URLSearchParams('sinceIndex=1'));
    const watch = JSON.parse(get.body);
    expect(watch.firings).toHaveLength(1); // only the firing after index 1
    expect(watch.firingCount).toBe(2);     // absolute total preserved
  });

  it('deletes a watch and then 404s', async () => {
    await routes.handleRegisterWatch(
      createJsonReq('POST', '/api/v1/sessions/pi-1/watch', { conditions: [{ type: 'event_type', eventType: 'agent_end' }] }),
      createMockRes(), 'pi-1',
    );
    const del = createMockRes();
    await routes.handleDeleteWatch(createJsonReq('DELETE', '/api/v1/sessions/pi-1/watch'), del, 'pi-1');
    expect(del.statusCode).toBe(200);

    const get = createMockRes();
    await routes.handleGetWatch(createJsonReq('GET', '/api/v1/sessions/pi-1/watch'), get, 'pi-1', new URLSearchParams());
    expect(get.statusCode).toBe(404);
    expect(JSON.parse(get.body).code).toBe('WATCH_NOT_FOUND');
  });

  it('rejects empty conditions with 400', async () => {
    const res = createMockRes();
    await routes.handleRegisterWatch(createJsonReq('POST', '/api/v1/sessions/pi-1/watch', { conditions: [] }), res, 'pi-1');
    expect(res.statusCode).toBe(400);
  });

  it('404s when the session does not exist', async () => {
    registry.get.mockResolvedValueOnce(null);
    const res = createMockRes();
    await routes.handleRegisterWatch(createJsonReq('POST', '/api/v1/sessions/ghost/watch', { conditions: [{ type: 'event_type', eventType: 'agent_end' }] }), res, 'ghost');
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).code).toBe('SESSION_NOT_FOUND');
  });
});
