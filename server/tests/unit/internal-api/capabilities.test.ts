import { describe, it, expect, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';
import { Writable } from 'stream';
import { createCapabilitiesRoutes } from '../../../src/internal-api/routes/capabilities.js';

function createMockReq(url = '/api/v1/capabilities'): IncomingMessage {
  return {
    url,
    method: 'GET',
    headers: {},
  } as unknown as IncomingMessage;
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

describe('createCapabilitiesRoutes', () => {
  it('reports channel-backed Claude features and unavailable OpenCode', async () => {
    const routes = createCapabilitiesRoutes({
      claudeService: {
        isAvailable: vi.fn().mockResolvedValue(true),
        getBackendMode: vi.fn().mockResolvedValue('channel'),
      } as any,
      opencodeService: {
        isAvailable: vi.fn().mockResolvedValue(false),
      } as any,
    });

    const req = createMockReq();
    const res = createMockRes();

    await routes.handleGetCapabilities(req, res);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      status: 'ok',
      runtimes: {
        pi: {
          available: true,
          supportsFollowUp: true,
          supportsSteer: true,
          supportsThinkingLevel: true,
        },
        claude: {
          available: true,
          backendMode: 'channel',
          supportsFollowUp: true,
          supportsSteer: false,
          supportsHeartbeat: true,
          supportsApprovals: true,
          supportsThinkingLevel: true,
        },
        opencode: {
          available: false,
          supportsApprovals: true,
        },
      },
    });
  });

  it('downgrades Claude-specific capability flags in direct mode', async () => {
    const routes = createCapabilitiesRoutes({
      claudeService: {
        isAvailable: vi.fn().mockResolvedValue(true),
        getBackendMode: vi.fn().mockResolvedValue('direct'),
      } as any,
      opencodeService: {
        isAvailable: vi.fn().mockResolvedValue(true),
      } as any,
    });

    const req = createMockReq();
    const res = createMockRes();

    await routes.handleGetCapabilities(req, res);

    const body = JSON.parse(res.body);
    expect(body.runtimes.claude).toMatchObject({
      backendMode: 'direct',
      supportsHeartbeat: false,
      supportsApprovals: false,
      supportsReplayHistory: true,
    });
    expect(body.runtimes.opencode).toMatchObject({
      available: true,
      supportsFollowUp: true,
      supportsModelSwitch: true,
    });
  });
});
