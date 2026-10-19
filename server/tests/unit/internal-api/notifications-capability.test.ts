import { describe, it, expect, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';
import { Writable } from 'stream';
import { createCapabilitiesRoutes, type CapabilitiesRoutesDeps } from '../../../src/internal-api/routes/capabilities.js';
import {
  NOTIFICATION_ACTION_HANDLER_TIMEOUT_MS,
} from '../../../src/notifications/action-handlers.js';
import { NOTIFICATION_ACTION_LIMITS } from '../../../src/notifications/types.js';

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
  return res;
}

function routesWith(over: Partial<CapabilitiesRoutesDeps> = {}) {
  return createCapabilitiesRoutes({
    claudeService: {
      isAvailable: vi.fn().mockResolvedValue(false),
      getBackendMode: vi.fn().mockResolvedValue('direct'),
      getProfiles: vi.fn().mockReturnValue([]),
    } as unknown as CapabilitiesRoutesDeps['claudeService'],
    opencodeService: {
      isAvailable: vi.fn().mockResolvedValue(false),
      isEnabled: vi.fn().mockReturnValue(false),
    } as unknown as CapabilitiesRoutesDeps['opencodeService'],
    antigravityService: {
      isAvailable: vi.fn().mockResolvedValue(false),
    } as unknown as CapabilitiesRoutesDeps['antigravityService'],
    ...over,
  });
}

describe('capabilities — features.notificationActions (contract 1.66.0)', () => {
  it('advertises the action limits and the registered handler names', async () => {
    const routes = routesWith({
      notificationActionHandlers: ['agent-os-channel', 'agent-os-inbox'],
    });
    const res = createMockRes();
    await routes.handleGetCapabilities({ url: '/api/v1/capabilities', method: 'GET', headers: {} } as unknown as IncomingMessage, res);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      features: { notificationActions?: Record<string, unknown> };
    };
    expect(body.features.notificationActions).toEqual({
      maxActions: NOTIFICATION_ACTION_LIMITS.maxActions,
      actionIdMaxLength: NOTIFICATION_ACTION_LIMITS.actionIdMaxLength,
      actionLabelMaxLength: NOTIFICATION_ACTION_LIMITS.actionLabelMaxLength,
      actionRefMaxLength: NOTIFICATION_ACTION_LIMITS.actionRefMaxLength,
      handlerTimeoutMs: NOTIFICATION_ACTION_HANDLER_TIMEOUT_MS,
      handlers: ['agent-os-channel', 'agent-os-inbox'],
    });
  });

  it('advertises an empty handler list when none are registered', async () => {
    const routes = routesWith();
    const res = createMockRes();
    await routes.handleGetCapabilities({ url: '/api/v1/capabilities', method: 'GET', headers: {} } as unknown as IncomingMessage, res);
    const body = JSON.parse(res.body) as { features: { notificationActions?: { handlers: string[] } } };
    expect(body.features.notificationActions?.handlers).toEqual([]);
  });
});
