import type { SessionRegistryManager, RegistryEntry } from '../session-registry.js';
import type { ClaudeService } from '../claude/claude-service.js';
import type { OpenCodeService } from '../opencode/opencode-service.js';
import { validateTransferRequest, type ValidationResult } from './transfer-validation.js';
import { TRANSFER_ERROR_CODES } from './types.js';
import type { TransferRequest, VisibleTranscriptSource } from './types.js';
import { buildHandoffPayload } from './transfer-framing.js';
import { extractPiTranscript } from './pi-source-adapter.js';
import { extractClaudeTranscript } from './claude-source-adapter.js';
import { extractOpenCodeTranscript } from './opencode-source-adapter.js';
import type { SourceAdapterResult } from './pi-source-adapter.js';
import type { SdkType } from '@pi-web-ui/shared';

export interface TransferServiceConfig {
  registry: SessionRegistryManager;
  claudeService: ClaudeService | null;
  opencodeService: OpenCodeService | null;
  piSessionDir?: string;
}

export interface TransferResult {
  success: boolean;
  sourceSessionId: string;
  targetSessionId: string;
  createdNewSession: boolean;
  error?: {
    code: string;
    message: string;
  };
}

export class TransferService {
  private config: TransferServiceConfig;

  constructor(config: TransferServiceConfig) {
    this.config = config;
  }

  async executeTransfer(request: TransferRequest): Promise<TransferResult> {
    const validation = validateTransferRequest(request);
    if (!validation.valid) {
      return {
        success: false,
        sourceSessionId: request.sourceSessionId,
        targetSessionId: request.targetSessionId ?? '',
        createdNewSession: false,
        error: {
          code: validation.errorCode ?? TRANSFER_ERROR_CODES.INVALID_REQUEST,
          message: validation.message ?? 'Invalid transfer request',
        },
      };
    }

    const sourceEntry = await this.config.registry.get(request.sourceSessionId);
    if (!sourceEntry) {
      return {
        success: false,
        sourceSessionId: request.sourceSessionId,
        targetSessionId: request.targetSessionId ?? '',
        createdNewSession: false,
        error: {
          code: TRANSFER_ERROR_CODES.SOURCE_NOT_FOUND,
          message: 'Source session not found',
        },
      };
    }

    const sourceResult = await this.extractSource(sourceEntry, request);
    if (sourceResult.error) {
      return {
        success: false,
        sourceSessionId: request.sourceSessionId,
        targetSessionId: '',
        createdNewSession: false,
        error: {
          code: TRANSFER_ERROR_CODES.EMPTY_SOURCE,
          message: sourceResult.error,
        },
      };
    }

    let targetSessionId = request.targetSessionId ?? '';
    let createdNewSession = false;

    if (request.createNew) {
      const createResult = await this.createTargetSession(request);
      if (!createResult.success) {
        return {
          success: false,
          sourceSessionId: request.sourceSessionId,
          targetSessionId: createResult.sessionId,
          createdNewSession: false,
          error: createResult.error,
        };
      }
      targetSessionId = createResult.sessionId;
      createdNewSession = true;
    } else {
      const targetEntry = await this.config.registry.get(targetSessionId);
      if (!targetEntry) {
        return {
          success: false,
          sourceSessionId: request.sourceSessionId,
          targetSessionId,
          createdNewSession: false,
          error: {
            code: TRANSFER_ERROR_CODES.TARGET_NOT_FOUND,
            message: 'Target session not found',
          },
        };
      }

      if (this.isTargetBusy(targetSessionId, targetEntry.sdkType)) {
        return {
          success: false,
          sourceSessionId: request.sourceSessionId,
          targetSessionId,
          createdNewSession: false,
          error: {
            code: TRANSFER_ERROR_CODES.TARGET_BUSY,
            message: 'Target session is busy/streaming. Cannot transfer into an active session.',
          },
        };
      }
    }

    const handoff = buildHandoffPayload(sourceResult.transcript);

    const dispatchResult = await this.dispatchToTarget(
      targetSessionId,
      request.createNew ? request.targetSdkType! : (await this.config.registry.get(targetSessionId))!.sdkType,
      handoff.fullText,
    );

    if (!dispatchResult.success) {
      return {
        success: false,
        sourceSessionId: request.sourceSessionId,
        targetSessionId,
        createdNewSession,
        error: dispatchResult.error,
      };
    }

    return {
      success: true,
      sourceSessionId: request.sourceSessionId,
      targetSessionId,
      createdNewSession,
    };
  }

  private async extractSource(entry: RegistryEntry, request: TransferRequest): Promise<SourceAdapterResult> {
    const source: VisibleTranscriptSource = {
      sessionId: entry.id,
      displayName: request.sourceDisplayName ?? entry.firstMessage?.slice(0, 50) ?? entry.id,
      sdkType: entry.sdkType,
      cwd: entry.cwd,
      createdAt: entry.createdAt,
      lastActivity: entry.lastActivity,
    };

    switch (entry.sdkType) {
      case 'pi':
        return extractPiTranscript(entry.path, source, request.scope);

      case 'claude':
        if (!this.config.claudeService) {
          return { transcript: { source, scope: request.scope, itemCount: 0, truncated: false, items: [] }, error: 'Claude service unavailable' };
        }
        return extractClaudeTranscript(
          (sid) => this.config.claudeService!.loadSessionHistory(sid),
          entry.id,
          source,
          request.scope,
        );

      case 'opencode':
        if (!this.config.opencodeService) {
          return { transcript: { source, scope: request.scope, itemCount: 0, truncated: false, items: [] }, error: 'OpenCode service unavailable' };
        }
        return extractOpenCodeTranscript(
          this.config.opencodeService,
          entry.id,
          source,
          request.scope,
        );

      default:
        return { transcript: { source, scope: request.scope, itemCount: 0, truncated: false, items: [] }, error: `Unknown runtime: ${entry.sdkType}` };
    }
  }

  private async createTargetSession(
    request: TransferRequest,
  ): Promise<{ success: true; sessionId: string } | { success: false; sessionId: string; error: { code: string; message: string } }> {
    const sdkType = request.targetSdkType!;
    const cwd = request.targetCwd!;

    switch (sdkType) {
      case 'claude': {
        if (!this.config.claudeService) {
          return {
            success: false,
            sessionId: '',
            error: { code: TRANSFER_ERROR_CODES.RUNTIME_UNAVAILABLE, message: 'Claude Direct is not available' },
          };
        }
        try {
          const result = await this.config.claudeService.createSession(cwd);
          return { success: true, sessionId: result.sessionId };
        } catch (err) {
          return {
            success: false,
            sessionId: '',
            error: { code: TRANSFER_ERROR_CODES.DISPATCH_FAILED, message: `Failed to create Claude session: ${err instanceof Error ? err.message : String(err)}` },
          };
        }
      }

      case 'opencode': {
        if (!this.config.opencodeService) {
          return {
            success: false,
            sessionId: '',
            error: { code: TRANSFER_ERROR_CODES.RUNTIME_UNAVAILABLE, message: 'OpenCode Direct is not available' },
          };
        }
        try {
          const result = await this.config.opencodeService.createSession(cwd);
          return { success: true, sessionId: result.sessionId };
        } catch (err) {
          return {
            success: false,
            sessionId: '',
            error: { code: TRANSFER_ERROR_CODES.DISPATCH_FAILED, message: `Failed to create OpenCode session: ${err instanceof Error ? err.message : String(err)}` },
          };
        }
      }

      case 'pi': {
        return {
          success: false,
          sessionId: '',
          error: { code: TRANSFER_ERROR_CODES.RUNTIME_UNAVAILABLE, message: 'Creating new Pi SDK sessions via transfer is not yet supported' },
        };
      }

      default:
        return {
          success: false,
          sessionId: '',
          error: { code: TRANSFER_ERROR_CODES.INVALID_REQUEST, message: `Unknown target runtime: ${sdkType}` },
        };
    }
  }

  private isTargetBusy(sessionId: string, sdkType: SdkType): boolean {
    switch (sdkType) {
      case 'claude':
        return this.config.claudeService?.isRunning(sessionId) ?? false;
      case 'opencode':
        return this.config.opencodeService?.isRunning(sessionId) ?? false;
      case 'pi':
        return false;
      default:
        return false;
    }
  }

  private async dispatchToTarget(
    targetSessionId: string,
    sdkType: SdkType,
    handoffText: string,
  ): Promise<{ success: true } | { success: false; error: { code: string; message: string } }> {
    switch (sdkType) {
      case 'claude': {
        if (!this.config.claudeService) {
          return { success: false, error: { code: TRANSFER_ERROR_CODES.RUNTIME_UNAVAILABLE, message: 'Claude service unavailable' } };
        }
        try {
          await new Promise<void>((resolve, reject) => {
            this.config.claudeService!.sendPrompt(
              targetSessionId,
              handoffText,
              () => {},
              (err) => {
                if (err) reject(err);
                else resolve();
              },
            );
          });
          return { success: true };
        } catch (err) {
          return { success: false, error: { code: TRANSFER_ERROR_CODES.DISPATCH_FAILED, message: `Claude dispatch failed: ${err instanceof Error ? err.message : String(err)}` } };
        }
      }

      case 'opencode': {
        if (!this.config.opencodeService) {
          return { success: false, error: { code: TRANSFER_ERROR_CODES.RUNTIME_UNAVAILABLE, message: 'OpenCode service unavailable' } };
        }
        try {
          await new Promise<void>((resolve, reject) => {
            this.config.opencodeService!.sendPrompt(
              targetSessionId,
              handoffText,
              () => {},
              (err) => {
                if (err) reject(err);
                else resolve();
              },
            );
          });
          return { success: true };
        } catch (err) {
          return { success: false, error: { code: TRANSFER_ERROR_CODES.DISPATCH_FAILED, message: `OpenCode dispatch failed: ${err instanceof Error ? err.message : String(err)}` } };
        }
      }

      case 'pi': {
        return { success: false, error: { code: TRANSFER_ERROR_CODES.RUNTIME_UNAVAILABLE, message: 'Pi SDK target dispatch not yet supported' } };
      }

      default:
        return { success: false, error: { code: TRANSFER_ERROR_CODES.INVALID_REQUEST, message: `Unknown target runtime: ${sdkType}` } };
    }
  }
}
