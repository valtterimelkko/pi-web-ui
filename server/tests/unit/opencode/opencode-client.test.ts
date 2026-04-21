import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { OpenCodeClient } from '../../../src/opencode/opencode-client.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('OpenCodeClient', () => {
  let client: OpenCodeClient;

  beforeEach(() => {
    client = new OpenCodeClient('http://localhost:8080', {});
    mockFetch.mockReset();
  });

  it('createSession() calls POST /session with correct headers', async () => {
    const session = { id: 'sess-1' };
    mockFetch.mockResolvedValueOnce(jsonResponse(session));

    const result = await client.createSession();

    expect(result).toEqual(session);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8080/session',
      expect.objectContaining({ method: 'POST' }),
    );
    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(opts.headers).toMatchObject({ 'Content-Type': 'application/json' });
  });

  it('listSessions() calls GET /session', async () => {
    const sessions = [{ id: 's1' }, { id: 's2' }];
    mockFetch.mockResolvedValueOnce(jsonResponse(sessions));

    const result = await client.listSessions();

    expect(result).toEqual(sessions);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8080/session',
      expect.objectContaining({ headers: expect.any(Object) }),
    );
  });

  it('getMessages(sessionId) calls GET /session/:id/message', async () => {
    const msgs = [{ id: 'm1', role: 'user' as const, parts: [] }];
    mockFetch.mockResolvedValueOnce(jsonResponse(msgs));

    const result = await client.getMessages('sess-42');

    expect(result).toEqual(msgs);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8080/session/sess-42/message',
      expect.anything(),
    );
  });

  it('promptAsync(sessionId, msg) calls POST /session/:id/prompt_async with body', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}));

    await client.promptAsync('sess-5', 'hello world');

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body as string)).toEqual({ message: 'hello world' });
  });

  it('abort(sessionId) calls POST /session/:id/abort', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(null));

    await client.abort('sess-9');

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(opts.method).toBe('POST');
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8080/session/sess-9/abort',
      expect.anything(),
    );
  });

  it('replyPermission(sessionId, permId, true) calls POST with correct body', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(null));

    await client.replyPermission('sess-1', 'perm-7', true);

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body as string)).toEqual({ response: true });
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8080/session/sess-1/permissions/perm-7',
      expect.anything(),
    );
  });

  it('includes auth headers when password is set', async () => {
    const authed = new OpenCodeClient('http://localhost:8080', {
      Authorization: 'Bearer secret-token',
    });
    mockFetch.mockResolvedValueOnce(jsonResponse([]));

    await authed.listSessions();

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(opts.headers).toMatchObject({ Authorization: 'Bearer secret-token' });
  });

  it('throws on non-2xx responses with status code in error message', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response('not found', { status: 404, statusText: 'Not Found' }),
    );

    await expect(client.getSession('bad')).rejects.toThrow('OpenCode API error: 404 Not Found');
  });
});
