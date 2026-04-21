import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { OpenCodeClient } from '../../../src/opencode/opencode-client.js';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockHttpGet(resOptions: { statusCode?: number; headers?: Record<string, string> } = {}) {
  const emitter = new EventEmitter() as EventEmitter & { destroy: () => void };
  const stream = new PassThrough();
  const statusCode = resOptions.statusCode ?? 200;

  emitter.destroy = vi.fn();

  const mockRes = Object.assign(stream, {
    statusCode,
    headers: resOptions.headers ?? { 'content-type': 'text/event-stream' },
    setEncoding: vi.fn(),
  });

  const spy = vi.spyOn(http, 'get').mockImplementation(((_opts: unknown, cb?: (res: unknown) => void) => {
    if (cb) cb(mockRes);
    return emitter as unknown as http.ClientRequest;
  }) as unknown as typeof http.get);

  return { emitter, stream, mockRes, spy };
}

describe('OpenCodeClient — getProviders', () => {
  let client: OpenCodeClient;

  beforeEach(() => {
    client = new OpenCodeClient('http://localhost:8080', {});
    mockFetch.mockReset();
  });

  it('calls GET /config/providers and returns parsed response', async () => {
    const providersData = {
      providers: [
        { id: 'zai-coding-plan', models: [{ id: 'glm-5.1' }] },
      ],
    };
    mockFetch.mockResolvedValueOnce(jsonResponse(providersData));

    const result = await client.getProviders();

    expect(result).toEqual(providersData);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8080/config/providers',
      expect.objectContaining({ headers: expect.any(Object) }),
    );
  });

  it('passes directory as query parameter', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ providers: [] }));

    await client.getProviders('/root/project');

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8080/config/providers?directory=%2Froot%2Fproject',
      expect.anything(),
    );
  });

  it('includes auth headers', async () => {
    const authed = new OpenCodeClient('http://localhost:8080', {
      Authorization: 'Bearer test-token',
    });
    mockFetch.mockResolvedValueOnce(jsonResponse({}));

    await authed.getProviders();

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(opts.headers).toMatchObject({ Authorization: 'Bearer test-token' });
  });
});

describe('OpenCodeClient — subscribeEvents', () => {
  let cleanup: (() => void) | null = null;
  let httpSpy: ReturnType<typeof mockHttpGet> | null = null;

  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    if (cleanup) {
      cleanup();
      cleanup = null;
    }
    if (httpSpy) {
      httpSpy.spy.mockRestore();
      httpSpy = null;
    }
  });

  it('returns a cleanup function', () => {
    httpSpy = mockHttpGet();
    const client = new OpenCodeClient('http://localhost:8080', {});
    cleanup = client.subscribeEvents(() => {});
    expect(typeof cleanup).toBe('function');
  });

  it('receives SSE events and parses them', async () => {
    httpSpy = mockHttpGet();
    const events: Array<unknown> = [];
    const client = new OpenCodeClient('http://localhost:8080', {});
    cleanup = client.subscribeEvents((event) => events.push(event));

    httpSpy.stream.write(`data: ${JSON.stringify({ type: 'session.idle', properties: { sessionId: 's1' } })}\n\n`);

    await new Promise((r) => setTimeout(r, 50));

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'session.idle', properties: { sessionId: 's1' } });
  });

  it('handles multiple SSE events in a single chunk', async () => {
    httpSpy = mockHttpGet();
    const events: Array<unknown> = [];
    const client = new OpenCodeClient('http://localhost:8080', {});
    cleanup = client.subscribeEvents((event) => events.push(event));

    httpSpy.stream.write(
      `data: ${JSON.stringify({ type: 'message.updated', properties: { a: 1 } })}\n` +
      `data: ${JSON.stringify({ type: 'session.idle', properties: { b: 2 } })}\n\n`,
    );

    await new Promise((r) => setTimeout(r, 50));

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: 'message.updated', properties: { a: 1 } });
    expect(events[1]).toEqual({ type: 'session.idle', properties: { b: 2 } });
  });

  it('ignores non-data SSE lines', async () => {
    httpSpy = mockHttpGet();
    const events: Array<unknown> = [];
    const client = new OpenCodeClient('http://localhost:8080', {});
    cleanup = client.subscribeEvents((event) => events.push(event));

    httpSpy.stream.write(': this is a comment\n');
    httpSpy.stream.write('event: custom\n');
    httpSpy.stream.write(`data: ${JSON.stringify({ type: 'test' })}\n\n`);

    await new Promise((r) => setTimeout(r, 50));

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'test' });
  });

  it('ignores malformed JSON in SSE data lines', async () => {
    httpSpy = mockHttpGet();
    const events: Array<unknown> = [];
    const client = new OpenCodeClient('http://localhost:8080', {});
    cleanup = client.subscribeEvents((event) => events.push(event));

    httpSpy.stream.write('data: not-json\n');
    httpSpy.stream.write(`data: ${JSON.stringify({ type: 'valid' })}\n\n`);

    await new Promise((r) => setTimeout(r, 50));

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'valid' });
  });

  it('stops reconnecting after cleanup is called', async () => {
    httpSpy = mockHttpGet();
    const client = new OpenCodeClient('http://localhost:8080', {});
    cleanup = client.subscribeEvents(() => {});
    cleanup();
    cleanup = null;

    await new Promise((r) => setTimeout(r, 100));

    expect(httpSpy.spy).toHaveBeenCalledTimes(1);
  });

  it('passes auth headers in http.get call', () => {
    httpSpy = mockHttpGet();
    const client = new OpenCodeClient('http://localhost:8080', {
      Authorization: 'Bearer secret',
    });
    cleanup = client.subscribeEvents(() => {});

    const callOpts = httpSpy.spy.mock.calls[0]?.[0] as http.RequestOptions;
    expect(callOpts.headers).toMatchObject({ Authorization: 'Bearer secret' });
  });

  it('connects to /global/event path', () => {
    httpSpy = mockHttpGet();
    const client = new OpenCodeClient('http://localhost:8080', {});
    cleanup = client.subscribeEvents(() => {});

    const callOpts = httpSpy.spy.mock.calls[0]?.[0] as http.RequestOptions;
    expect(callOpts.path).toBe('/global/event');
  });

  it('unwraps payload envelope from /global/event', async () => {
    httpSpy = mockHttpGet();
    const events: Array<unknown> = [];
    const client = new OpenCodeClient('http://localhost:8080', {});
    cleanup = client.subscribeEvents((event) => events.push(event));

    httpSpy.stream.write(`data: ${JSON.stringify({ payload: { type: 'session.idle', properties: { sessionId: 's1' } } })}\n\n`);

    await new Promise((r) => setTimeout(r, 50));

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'session.idle', properties: { sessionId: 's1' } });
  });
});

describe('OpenCodeClient — getSession', () => {
  let client: OpenCodeClient;

  beforeEach(() => {
    client = new OpenCodeClient('http://localhost:8080', {});
    mockFetch.mockReset();
  });

  it('calls GET /session/:id and returns the session', async () => {
    const session = { id: 'sess-42', slug: 'test' };
    mockFetch.mockResolvedValueOnce(jsonResponse(session));

    const result = await client.getSession('sess-42');

    expect(result).toEqual(session);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8080/session/sess-42',
      expect.objectContaining({ headers: expect.any(Object) }),
    );
  });
});

describe('OpenCodeClient — sendMessage', () => {
  let client: OpenCodeClient;

  beforeEach(() => {
    client = new OpenCodeClient('http://localhost:8080', {});
    mockFetch.mockReset();
  });

  it('calls POST /session/:id/message with text parts', async () => {
    const response = { id: 'msg-1' };
    mockFetch.mockResolvedValueOnce(jsonResponse(response));

    const result = await client.sendMessage('sess-5', 'hello there');

    expect(result).toEqual(response);
    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body as string)).toEqual({
      parts: [{ type: 'text', text: 'hello there' }],
    });
  });
});

describe('OpenCodeClient — promptAsync without model', () => {
  let client: OpenCodeClient;

  beforeEach(() => {
    client = new OpenCodeClient('http://localhost:8080', {});
    mockFetch.mockReset();
  });

  it('sends prompt without model field when modelId is omitted', async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await client.promptAsync('sess-5', '/root', 'hello');

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string);
    expect(body).toEqual({
      parts: [{ type: 'text', text: 'hello' }],
    });
    expect(body.model).toBeUndefined();
  });
});
