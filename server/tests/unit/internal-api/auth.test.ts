/**
 * Tests for Internal API Auth Middleware
 */

import { describe, it, expect, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';
import { Writable } from 'stream';
import { createAuthMiddleware } from '../../../src/internal-api/middleware/auth.js';

function createMockReq(url: string, authHeader?: string): IncomingMessage {
  return {
    url,
    method: 'GET',
    headers: authHeader ? { authorization: authHeader } : {},
  } as unknown as IncomingMessage;
}

function createMockRes(): ServerResponse & { body: string; statusCode: number } {
  const chunks: Buffer[] = [];
  const res = new Writable({
    write(chunk: Buffer, _encoding: string, callback: () => void) {
      chunks.push(chunk);
      callback();
    },
  }) as unknown as ServerResponse & { body: string; statusCode: number };

  res.statusCode = 200;
  res.setHeader = vi.fn();
  res.writeHead = vi.fn(function (this: typeof res, code: number, _headers?: Record<string, string>) {
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

describe('createAuthMiddleware', () => {
  const apiKey = 'test-api-key-12345';
  const middleware = createAuthMiddleware(apiKey);

  it('allows health endpoint without auth', () => {
    const req = createMockReq('/api/v1/health');
    const res = createMockRes();
    const next = vi.fn();

    middleware(req, res as unknown as ServerResponse, next);

    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  it('allows GET health without auth', () => {
    const req = createMockReq('/api/v1/health');
    (req as Record<string, unknown>).method = 'GET';
    const res = createMockRes();
    const next = vi.fn();

    middleware(req, res as unknown as ServerResponse, next);

    expect(next).toHaveBeenCalled();
  });

  it('rejects requests with no Authorization header', () => {
    const req = createMockReq('/api/v1/sessions');
    const res = createMockRes();
    const next = vi.fn();

    middleware(req, res as unknown as ServerResponse, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toMatchObject({
      error: 'Missing Authorization header',
      code: 'UNAUTHORIZED',
    });
  });

  it('rejects requests with wrong auth scheme', () => {
    const req = createMockReq('/api/v1/sessions', 'Basic dGVzdDp0ZXN0');
    const res = createMockRes();
    const next = vi.fn();

    middleware(req, res as unknown as ServerResponse, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toMatchObject({
      error: 'Authorization header must be: Bearer <token>',
      code: 'UNAUTHORIZED',
    });
  });

  it('rejects requests with invalid API key', () => {
    const req = createMockReq('/api/v1/sessions', 'Bearer wrong-key');
    const res = createMockRes();
    const next = vi.fn();

    middleware(req, res as unknown as ServerResponse, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toMatchObject({
      error: 'Invalid API key',
      code: 'UNAUTHORIZED',
    });
  });

  it('allows requests with valid API key', () => {
    const req = createMockReq('/api/v1/sessions', `Bearer ${apiKey}`);
    const res = createMockRes();
    const next = vi.fn();

    middleware(req, res as unknown as ServerResponse, next);

    expect(next).toHaveBeenCalled();
  });

  it('allows access to models endpoint with valid key', () => {
    const req = createMockReq('/api/v1/models', `Bearer ${apiKey}`);
    const res = createMockRes();
    const next = vi.fn();

    middleware(req, res as unknown as ServerResponse, next);

    expect(next).toHaveBeenCalled();
  });

  it('allows access to sessions endpoint with valid key', () => {
    const req = createMockReq('/api/v1/sessions/abc-123/prompt', `Bearer ${apiKey}`);
    (req as Record<string, unknown>).method = 'POST';
    const res = createMockRes();
    const next = vi.fn();

    middleware(req, res as unknown as ServerResponse, next);

    expect(next).toHaveBeenCalled();
  });
});
