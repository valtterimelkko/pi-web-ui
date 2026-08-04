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
import { config } from '../../config.js';

export interface CapabilitiesRoutesDeps {
  claudeService: ClaudeService;
  opencodeService: OpenCodeService;
  antigravityService: AntigravityService;
  blockedPiProviders?: readonly string[];
}

export function createCapabilitiesRoutes(deps: CapabilitiesRoutesDeps) {
  const { claudeService, opencodeService, antigravityService } = deps;
  const blockedPiProviders = [...(deps.blockedPiProviders ?? config.internalApiBlockedPiProviders)];

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
    // Operator enablement is distinct from installed/healthy availability.
    // A disabled-but-installed runtime is advertised as unavailable and its
    // new work is refused rather than silently substituted.
    const opencodeEnabled = opencodeService.isEnabled();

    const body: CapabilitiesResponse = {
      status: 'ok',
      contract: getInternalApiContractInfo(),
      features: {
        retentionLeases: true,
        durableRetention: true,
        residentRetention: true,
        executionAdmission: true,
        runLivenessEvidence: true,
        sessionRecoveryEvidence: true,
        capacityEndpoint: '/api/v1/capacity',
        piProviderPolicy: { blockedProviders: blockedPiProviders },
      },
      runtimes: {
        pi: {
          available: true,
          enabled: true,
          backendMode: 'native',
          supportsFollowUp: true,
          followUpSemantics: 'queue_while_busy',
          supportsSteer: true,
          supportsSteerWhileBusy: true,
          supportsModelSwitch: true,
          supportsThinkingLevel: true,
          supportsPinning: true,
          supportsReplayHistory: false,
          supportsApprovals: false,
          supportsHeartbeat: false,
          supportsInteractiveQuestions: false,
          supportsStructuredQuestionResponse: false,
        },
        claude: {
          available: claudeAvailable,
          enabled: true,
          backendMode: claudeBackendMode,
          supportsFollowUp: true,
          followUpSemantics: 'new_turn',
          supportsSteer: false,
          supportsSteerWhileBusy: false,
          supportsModelSwitch: true,
          supportsThinkingLevel: true,
          supportsPinning: true,
          supportsReplayHistory: true,
          supportsApprovals: claudeBackendMode === 'channel',
          supportsHeartbeat: claudeBackendMode === 'channel',
          supportsInteractiveQuestions: claudeBackendMode === 'sdk',
          supportsStructuredQuestionResponse: claudeBackendMode === 'sdk',
        },
        opencode: {
          available: opencodeEnabled && opencodeAvailable,
          enabled: opencodeEnabled,
          backendMode: 'server',
          supportsFollowUp: true,
          followUpSemantics: 'new_turn',
          supportsSteer: false,
          supportsSteerWhileBusy: false,
          supportsModelSwitch: true,
          supportsThinkingLevel: true,
          supportsPinning: true,
          supportsReplayHistory: true,
          supportsApprovals: true,
          supportsHeartbeat: false,
          supportsInteractiveQuestions: false,
          supportsStructuredQuestionResponse: false,
        },
        antigravity: {
          available: antigravityAvailable,
          enabled: true,
          backendMode: 'subprocess',
          supportsFollowUp: true,
          followUpSemantics: 'new_turn',
          supportsSteer: false,
          supportsSteerWhileBusy: false,
          supportsModelSwitch: true,
          supportsThinkingLevel: false,
          supportsPinning: true,
          supportsReplayHistory: true,
          supportsApprovals: false,
          // Synthetic liveness heartbeat emitted during an in-flight turn (agy is
          // a batch subprocess with no native streaming).
          supportsHeartbeat: true,
          supportsInteractiveQuestions: false,
          supportsStructuredQuestionResponse: false,
        },
      },
    };

    // Expose Claude profiles as extra metadata (non-secret fields only).
    // Added at the top level so automation clients can discover them.
    const claudeProfiles = claudeService.getProfiles();
    if (claudeProfiles.length > 0) {
      (body as CapabilitiesResponse & { claudeProfiles?: unknown }).claudeProfiles = claudeProfiles.map((p) => ({
        id: p.id,
        label: p.label,
        backend: p.backend,
        launcherType: p.launcherType,
        model: p.model,
        provider: p.baseUrl?.includes('z.ai') ? 'zai' : 'anthropic',
        enabled: p.enabled,
      }));
    }

    sendJson(res, 200, body);
  }

  return { handleGetCapabilities };
}

function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}
