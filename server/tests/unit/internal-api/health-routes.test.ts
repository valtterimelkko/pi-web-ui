import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHealthRoutes } from '../../../src/internal-api/routes/health.js';

function responseCapture() {
  let status = 0;
  let body = '';
  return {
    response: {
      writeHead: vi.fn((code: number) => { status = code; }),
      end: vi.fn((chunk?: string) => { body = chunk ?? ''; }),
    } as unknown as ServerResponse,
    read: () => ({ status, body: JSON.parse(body) as Record<string, unknown> }),
  };
}

describe('Internal API health routes', () => {
  it('adds a unified runtime matrix while optional unavailability stays globally ready', async () => {
    const routes = createHealthRoutes({
      claudeService: {
        isAvailable: vi.fn().mockResolvedValue(false),
        getBackendMode: vi.fn().mockResolvedValue('sdk'),
      } as never,
      opencodeService: { isAvailable: vi.fn().mockRejectedValue(new Error('probe failed')) } as never,
      antigravityService: { isAvailable: vi.fn().mockResolvedValue(false) } as never,
      startTime: Date.now() - 3_000,
      enabled: { claude: true, opencode: true, antigravity: false },
    });
    const capture = responseCapture();

    await routes.handleHealth({} as IncomingMessage, capture.response);
    const result = capture.read();

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      status: 'ok',
      runtimes: {
        pi: 'available',
        claude: 'unavailable',
        opencode: 'unavailable',
        antigravity: 'unavailable',
      },
      runtimeHealth: {
        pi: { enabled: true, available: true, backend: 'native', checkStatus: 'ok' },
        claude: { enabled: true, available: false, backend: 'sdk', checkStatus: 'unavailable' },
        opencode: { enabled: true, available: false, backend: 'server', checkStatus: 'error' },
        antigravity: { enabled: false, available: false, backend: 'subprocess', checkStatus: 'disabled' },
      },
    });
  });
});
