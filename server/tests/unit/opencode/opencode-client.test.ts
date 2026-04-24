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

  it('createSession() calls POST /session with directory query and correct headers', async () => {
    const session = { id: 'sess-1' };
    mockFetch.mockResolvedValueOnce(jsonResponse(session));

    const result = await client.createSession('/root');

    expect(result).toEqual(session);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8080/session?directory=%2Froot',
      expect.objectContaining({ method: 'POST' }),
    );
    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(opts.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(JSON.parse(opts.body as string)).toEqual({});
  });

  it('createSession() can set session permission rules', async () => {
    const session = { id: 'sess-1' };
    const permission = [{ permission: '*', action: 'allow' as const, pattern: '*' }];
    mockFetch.mockResolvedValueOnce(jsonResponse(session));

    await client.createSession('/root', permission);

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(opts.body as string)).toEqual({ permission });
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

  it('getMessages(sessionId) calls GET /session/:id/message with directory query', async () => {
    const msgs = [{ id: 'm1', role: 'user' as const, parts: [] }];
    mockFetch.mockResolvedValueOnce(jsonResponse(msgs));

    const result = await client.getMessages('sess-42', '/root');

    expect(result).toEqual(msgs);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8080/session/sess-42/message?directory=%2Froot',
      expect.anything(),
    );
  });

  it('promptAsync(sessionId, msg) calls POST /session/:id/prompt_async with directory query and model object', async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await client.promptAsync('sess-5', '/root', 'hello world', 'zai-coding-plan/glm-5.1');

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8080/session/sess-5/prompt_async?directory=%2Froot',
      expect.anything(),
    );
    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body as string)).toEqual({
      model: { providerID: 'zai-coding-plan', modelID: 'glm-5.1' },
      parts: [{ type: 'text', text: 'hello world' }],
    });
  });

  it('abort(sessionId) calls POST /session/:id/abort with directory query', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(null));

    await client.abort('sess-9', '/root');

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(opts.method).toBe('POST');
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8080/session/sess-9/abort?directory=%2Froot',
      expect.anything(),
    );
  });

  it('replyPermission(sessionId, permId, true) defaults to always for OpenCode response semantics', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(null));

    await client.replyPermission('sess-1', '/root', 'perm-7', true);

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body as string)).toEqual({ response: 'always' });
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8080/session/sess-1/permissions/perm-7?directory=%2Froot',
      expect.anything(),
    );
  });

  it('replyPermission(sessionId, permId, true, once) can approve only once', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(null));

    await client.replyPermission('sess-1', '/root', 'perm-7', true, 'once');

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(opts.body as string)).toEqual({ response: 'once' });
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
