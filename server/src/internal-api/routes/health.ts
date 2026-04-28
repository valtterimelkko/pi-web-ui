/**
 * Internal API: Health Route
 *
 * Reports API health and runtime availability.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import type { HealthResponse } from '../types.js';
import type { ClaudeService } from '../../claude/claude-service.js';
import type { OpenCodeService } from '../../opencode/opencode-service.js';

export interface HealthRoutesDeps {
  claudeService: ClaudeService;
  opencodeService: OpenCodeService;
  startTime: number;
}

export function createHealthRoutes(deps: HealthRoutesDeps) {
  const { claudeService, opencodeService, startTime } = deps;

  async function handleHealth(
    _req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const [claudeAvailable, opencodeAvailable] = await Promise.all([
      claudeService.isAvailable().catch(() => false),
      opencodeService.isAvailable().catch(() => false),
    ]);

    const runtimes = {
      pi: 'available' as const, // Pi SDK is always available (core)
      claude: claudeAvailable ? 'available' as const : 'unavailable' as const,
      opencode: opencodeAvailable ? 'available' as const : 'unavailable' as const,
    };

    const overallStatus: HealthResponse['status'] =
      (runtimes.pi === 'available') ? 'ok' : 'degraded';

    const uptime = Math.floor((Date.now() - startTime) / 1000);

    sendJson(res, 200, {
      status: overallStatus,
      runtimes,
      uptime,
    } satisfies HealthResponse);
  }

  return { handleHealth };
}

function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}
