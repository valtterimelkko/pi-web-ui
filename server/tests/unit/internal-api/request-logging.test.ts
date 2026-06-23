import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'http';
import { createRequestLoggingMiddleware } from '../../../src/internal-api/request-logging.js';
import { createLogger, setLogTap, type LogRecord } from '../../../src/logging/logger.js';
import { getCorrelationContext } from '../../../src/logging/correlation.js';

function mockReqRes(method: string, url: string): { req: IncomingMessage; res: ServerResponse } {
  const req = { method, url } as unknown as IncomingMessage;
  const res = new EventEmitter() as unknown as ServerResponse & { writeHead: (code: number) => ServerResponse };
  (res as Record<string, unknown>).writeHead = (code: number) => {
    (res as Record<string, unknown>).statusCode = code;
    return res as ServerResponse;
  };
  return { req, res };
}

describe('request logging middleware (Task 13)', () => {
  it('logs method/path/status/duration + requestId at debug', () => {
    const records: LogRecord[] = [];
    setLogTap((r) => records.push(r));
    try {
      const logger = createLogger('InternalAPI', { level: 'debug', sink: () => {} });
      const mw = createRequestLoggingMiddleware(logger);
      const { req, res } = mockReqRes('GET', '/api/v1/health?x=1');
      mw(req, res, () => {});
      (res as unknown as { writeHead: (c: number) => unknown }).writeHead(200);
      res.emit('finish');

      const rec = records.find((r) => r.msg.includes('GET /api/v1/health'));
      expect(rec).toBeDefined();
      expect(rec!.level).toBe('debug');
      expect(rec!.msg).toContain('200');
      expect(rec!.msg).toMatch(/\(\d+ms\)/);
      expect(rec!.requestId).toBeTruthy();
      // query string stripped from the logged path
      expect(rec!.msg).not.toContain('?x=1');
    } finally {
      setLogTap(null);
    }
  });

  it('does NOT emit the request log at info level', () => {
    const records: LogRecord[] = [];
    setLogTap((r) => records.push(r));
    try {
      const logger = createLogger('InternalAPI', { level: 'info', sink: () => {} });
      const mw = createRequestLoggingMiddleware(logger);
      const { req, res } = mockReqRes('GET', '/api/v1/health');
      mw(req, res, () => {});
      (res as unknown as { writeHead: (c: number) => unknown }).writeHead(200);
      res.emit('finish');
      expect(records.find((r) => r.msg.includes('/api/v1/health'))).toBeUndefined();
    } finally {
      setLogTap(null);
    }
  });

  it('establishes a per-request correlation requestId visible inside next()', () => {
    const logger = createLogger('InternalAPI', { level: 'debug', sink: () => {} });
    const mw = createRequestLoggingMiddleware(logger);
    const { req, res } = mockReqRes('POST', '/api/v1/sessions/s1/prompt');
    let seen: string | undefined;
    mw(req, res, () => {
      seen = getCorrelationContext()?.requestId;
    });
    expect(seen).toBeTruthy();
    expect(seen).toMatch(/^req_/);
  });
});
