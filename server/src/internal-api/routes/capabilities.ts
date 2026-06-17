/**
 * Internal API: Capabilities Route
 *
 * Reports runtime/backend feature availability so automation clients can
 * decide which live-validation scenarios are meaningful on the current host.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { getInternalApiContractInfo, type CapabilitiesResponse } from '../types.js';
import type { ClaudeService } from '../../claude/claude-service.js';
import type { OpenCodeService } from '../../opencode/opencode-service.js';
import type { AntigravityService } from '../../antigravity/antigravity-service.js';

export interface CapabilitiesRoutesDeps {
  claudeService: ClaudeService;
  opencodeService: OpenCodeService;
  antigravityService: AntigravityService;
}

export function createCapabilitiesRoutes(deps: CapabilitiesRoutesDeps) {
  const { claudeService, opencodeService, antigravityService } = deps;

  async function handleGetCapabilities(
    _req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const [claudeAvailable, claudeBackendMode, opencodeAvailable, antigravityAvailable] = await Promise.all([
      claudeService.isAvailable().catch(() => false),
      claudeService.getBackendMode().catch(() => 'direct' as const),
      opencodeService.isAvailable().catch(() => false),
      antigravityService.isAvailable().catch(() => false),
    ]);

    const body: CapabilitiesResponse = {
      status: 'ok',
      contract: getInternalApiContractInfo(),
      runtimes: {
        pi: {
          available: true,
          backendMode: 'native',
          supportsFollowUp: true,
          supportsSteer: true,
          supportsModelSwitch: true,
          supportsThinkingLevel: true,
          supportsPinning: true,
          supportsReplayHistory: false,
          supportsApprovals: false,
          supportsHeartbeat: false,
        },
        claude: {
          available: claudeAvailable,
          backendMode: claudeBackendMode,
          supportsFollowUp: true,
          supportsSteer: false,
          supportsModelSwitch: true,
          supportsThinkingLevel: true,
          supportsPinning: true,
          supportsReplayHistory: true,
          supportsApprovals: claudeBackendMode === 'channel',
          supportsHeartbeat: claudeBackendMode === 'channel',
        },
        opencode: {
          available: opencodeAvailable,
          backendMode: 'server',
          supportsFollowUp: true,
          supportsSteer: false,
          supportsModelSwitch: true,
          supportsThinkingLevel: true,
          supportsPinning: true,
          supportsReplayHistory: true,
          supportsApprovals: true,
          supportsHeartbeat: false,
        },
        antigravity: {
          available: antigravityAvailable,
          backendMode: 'subprocess',
          supportsFollowUp: true,
          supportsSteer: false,
          supportsModelSwitch: true,
          supportsThinkingLevel: false,
          supportsPinning: true,
          supportsReplayHistory: true,
          supportsApprovals: false,
          supportsHeartbeat: false,
        },
      },
    };

    sendJson(res, 200, body);
  }

  return { handleGetCapabilities };
}

function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}
