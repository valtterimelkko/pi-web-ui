/**
 * Internal API: Health Route
 *
 * Reports API health and runtime availability.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { getInternalApiContractInfo, type HealthResponse } from '../types.js';
import type { ClaudeService } from '../../claude/claude-service.js';
import type { OpenCodeService } from '../../opencode/opencode-service.js';
import type { AntigravityService } from '../../antigravity/antigravity-service.js';
import { RuntimeHealthMonitor } from '../../observability/runtime-health.js';

export interface HealthRoutesDeps {
  claudeService: ClaudeService;
  opencodeService: OpenCodeService;
  antigravityService: AntigravityService;
  startTime: number;
  enabled?: { claude: boolean; opencode: boolean; antigravity: boolean };
}

export function createHealthRoutes(deps: HealthRoutesDeps) {
  const { claudeService, opencodeService, antigravityService, startTime } = deps;
  const monitor = new RuntimeHealthMonitor();

  async function handleHealth(
    _req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const claudeBackend = await claudeService.getBackendMode().catch(() => 'direct' as const);
    const enabled = deps.enabled ?? { claude: true, opencode: true, antigravity: true };
    const runtimeHealth = await monitor.check({
      pi: { enabled: true, backend: 'native', probe: async () => true },
      claude: { enabled: enabled.claude, backend: claudeBackend, probe: () => claudeService.isAvailable() },
      opencode: { enabled: enabled.opencode, backend: 'server', probe: () => opencodeService.isAvailable() },
      antigravity: {
        enabled: enabled.antigravity,
        backend: 'subprocess',
        probe: () => antigravityService.isAvailable(),
      },
    });

    const runtimes = {
      pi: runtimeHealth.pi.available ? 'available' as const : 'unavailable' as const,
      claude: runtimeHealth.claude.available ? 'available' as const : 'unavailable' as const,
      opencode: runtimeHealth.opencode.available ? 'available' as const : 'unavailable' as const,
      antigravity: runtimeHealth.antigravity.available ? 'available' as const : 'unavailable' as const,
    };

    const overallStatus: HealthResponse['status'] =
      (runtimes.pi === 'available') ? 'ok' : 'degraded';

    const uptime = Math.floor((Date.now() - startTime) / 1000);

    sendJson(res, 200, {
      status: overallStatus,
      contract: getInternalApiContractInfo(),
      runtimes,
      runtimeHealth,
      uptime,
    } satisfies HealthResponse);
  }

  return { handleHealth };
}

function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}
