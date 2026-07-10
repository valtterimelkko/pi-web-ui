import fs from 'fs/promises';
import path from 'path';
import type { SessionRegistryManager, RegistryEntry } from '../session-registry.js';
import type { ClaudeService } from '../claude/claude-service.js';
import type { OpenCodeService } from '../opencode/opencode-service.js';
import type { AntigravityService } from '../antigravity/antigravity-service.js';
import { validateTransferRequest, type ValidationResult } from './transfer-validation.js';
import { TRANSFER_ERROR_CODES } from './types.js';
import type { TransferRequest, VisibleTranscriptSource } from './types.js';
import { buildHandoffPayload } from './transfer-framing.js';
import { extractPiTranscript } from './pi-source-adapter.js';
import { extractClaudeTranscript } from './claude-source-adapter.js';
import { extractOpenCodeTranscript } from './opencode-source-adapter.js';
import type { SourceAdapterResult } from './pi-source-adapter.js';
import type { SdkType } from '@pi-web-ui/shared';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('Transfer');


export interface TransferServiceConfig {
  registry: SessionRegistryManager;
  claudeService: ClaudeService | null;
  opencodeService: OpenCodeService | null;
  antigravityService?: AntigravityService | null;
  /** Maximum time to observe target runtime acceptance before failing cleanly. */
  acceptanceTimeoutMs?: number;
  piSessionDir?: string;
  createPiSession?: (cwd: string) => Promise<{ sessionId: string; sessionPath: string }>;
  /** Starts a Pi prompt and forwards its raw/normalized events to `onEvent`. */
  sendPiPrompt?: (sessionPath: string, message: string, onEvent: (event: unknown) => void) => Promise<void>;
}

export interface TransferResult {
  success: boolean;
  sourceSessionId: string;
  targetSessionId: string;
  createdNewSession: boolean;
  targetSessionPath?: string;
  targetSdkType?: SdkType;
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

    let sourceEntry = await this.config.registry.get(request.sourceSessionId);

    if (!sourceEntry) {
      sourceEntry = await this.config.registry.getByPath(request.sourceSessionId);
    }

    if (!sourceEntry) {
      sourceEntry = await this.resolvePiSessionFallback(request.sourceSessionId);
    }

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
    let targetSessionPath: string | undefined;
    let targetSdkType: SdkType | undefined;

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
      targetSessionPath = createResult.sessionPath;
      createdNewSession = true;
    } else {
      let targetEntry = await this.config.registry.get(targetSessionId)
        || await this.config.registry.getByPath(targetSessionId);
      if (!targetEntry) {
        targetEntry = await this.resolvePiSessionFallback(targetSessionId);
      }
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

      targetSessionPath = targetEntry.path;
      targetSdkType = targetEntry.sdkType;
    }

    const handoff = buildHandoffPayload(sourceResult.transcript);

    const dispatchResult = await this.dispatchToTarget(
      targetSessionId,
      request.createNew ? request.targetSdkType! : targetSdkType!,
      handoff.fullText,
      targetSessionPath,
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
      targetSessionPath,
      targetSdkType: request.createNew ? request.targetSdkType : undefined,
    };
  }

  private async resolvePiSessionFallback(sessionIdOrPath: string): Promise<RegistryEntry | undefined> {
    const piSessionDir = this.config.piSessionDir || path.join(process.env.HOME || '/root', '.pi/agent/sessions');
    try {
      const candidates: string[] = [];
      if (sessionIdOrPath.includes('/') && sessionIdOrPath.endsWith('.jsonl')) {
        candidates.push(sessionIdOrPath);
      }
      if (!sessionIdOrPath.includes('/')) {
        const dirs = await fs.readdir(piSessionDir, { withFileTypes: true });
        for (const dir of dirs) {
          if (!dir.isDirectory()) continue;
          const subDir = path.join(piSessionDir, dir.name);
          const files = await fs.readdir(subDir);
          for (const f of files) {
            if (f.endsWith('.jsonl') && f.includes(sessionIdOrPath)) {
              candidates.push(path.join(subDir, f));
            }
          }
        }
      }
      for (const candidate of candidates) {
        try {
          const stat = await fs.stat(candidate);
          if (!stat.isFile()) continue;
          const dirName = path.basename(path.dirname(candidate));
          const inner = dirName.replace(/^--/, '').replace(/--$/, '');
          const cwd = '/' + inner.replace(/--/g, '/');
          return {
            id: sessionIdOrPath,
            sdkType: 'pi' as const,
            path: candidate,
            cwd,
            firstMessage: '',
            messageCount: 0,
            createdAt: stat.birthtime.toISOString(),
            lastActivity: stat.mtime.toISOString(),
            status: 'idle' as const,
          };
        } catch { /* file not accessible */ }
      }
    } catch { /* session dir not readable */ }
    return undefined;
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

      case 'antigravity':
        if (!this.config.antigravityService) {
          return { transcript: { source, scope: request.scope, itemCount: 0, truncated: false, items: [] }, error: 'Antigravity service unavailable' };
        }
        // Antigravity and OpenCode both expose the normalised replay-event
        // shape consumed by this adapter.
        return extractOpenCodeTranscript(
          this.config.antigravityService,
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
  ): Promise<{ success: true; sessionId: string; sessionPath?: string } | { success: false; sessionId: string; error: { code: string; message: string } }> {
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

      case 'antigravity': {
        if (!this.config.antigravityService) {
          return {
            success: false,
            sessionId: '',
            error: { code: TRANSFER_ERROR_CODES.RUNTIME_UNAVAILABLE, message: 'Antigravity is not available' },
          };
        }
        try {
          const result = await this.config.antigravityService.createSession(cwd);
          // Antigravity's registry path is its session id. Supplying it keeps
          // the WebSocket/UI new-session flow consistent with other runtimes.
          return { success: true, sessionId: result.sessionId, sessionPath: result.sessionId };
        } catch (err) {
          return {
            success: false,
            sessionId: '',
            error: { code: TRANSFER_ERROR_CODES.DISPATCH_FAILED, message: `Failed to create Antigravity session: ${err instanceof Error ? err.message : String(err)}` },
          };
        }
      }

      case 'pi': {
        if (!this.config.createPiSession) {
          return {
            success: false,
            sessionId: '',
            error: { code: TRANSFER_ERROR_CODES.RUNTIME_UNAVAILABLE, message: 'Pi SDK session creation not available in transfer context' },
          };
        }
        try {
          const result = await this.config.createPiSession(cwd);
          return { success: true, sessionId: result.sessionId, sessionPath: result.sessionPath };
        } catch (err) {
          return {
            success: false,
            sessionId: '',
            error: { code: TRANSFER_ERROR_CODES.DISPATCH_FAILED, message: `Failed to create Pi session: ${err instanceof Error ? err.message : String(err)}` },
          };
        }
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
      case 'antigravity':
        return this.config.antigravityService?.isRunning(sessionId) ?? false;
      default:
        return false;
    }
  }

  /**
   * A transfer is complete when the target runtime has accepted the handoff
   * (`agent_start`), not when its entire response has finished. Waiting for
   * `onComplete` held the browser modal open for the full target turn even
   * though the context was already present (and could leave it stale forever
   * after a missed end event).
   */
  private awaitTargetAcceptance(
    start: (onEvent: (event: unknown) => void, onComplete: (error?: Error) => void) => Promise<void> | void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeoutMs = this.config.acceptanceTimeoutMs ?? 15_000;
      const timeout = setTimeout(() => {
        settle(new Error(`Target did not accept the transfer within ${timeoutMs}ms`));
      }, timeoutMs);
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      };

      const onEvent = (event: unknown) => {
        if (typeof event === 'object' && event !== null && (event as { type?: unknown }).type === 'agent_start') {
          settle();
        }
      };
      const onComplete = (error?: Error) => {
        if (error) settle(error);
        else if (!settled) settle(new Error('Target completed before accepting the transfer'));
      };

      try {
        Promise.resolve(start(onEvent, onComplete)).catch((error) => {
          settle(error instanceof Error ? error : new Error(String(error)));
        });
      } catch (error) {
        settle(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private async dispatchToTarget(
    targetSessionId: string,
    sdkType: SdkType,
    handoffText: string,
    directPath?: string,
  ): Promise<{ success: true } | { success: false; error: { code: string; message: string } }> {
    switch (sdkType) {
      case 'claude': {
        if (!this.config.claudeService) {
          return { success: false, error: { code: TRANSFER_ERROR_CODES.RUNTIME_UNAVAILABLE, message: 'Claude service unavailable' } };
        }
        try {
          await this.awaitTargetAcceptance((onEvent, onComplete) =>
            this.config.claudeService!.sendPrompt(targetSessionId, handoffText, onEvent, onComplete),
          );
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
          await this.awaitTargetAcceptance((onEvent, onComplete) =>
            this.config.opencodeService!.sendPrompt(
              targetSessionId,
              handoffText,
              (event) => {
                if (event.type === 'permission_request' && event.data) {
                  const permData = event.data as Record<string, unknown>;
                  const permId = permData.permissionId as string;
                  if (permId) {
                    logger.info(`[Transfer] Auto-approving permission ${permId} for transfer dispatch`);
                    void this.config.opencodeService!.replyPermission(targetSessionId, permId, true);
                  }
                }
                onEvent(event);
              },
              onComplete,
            ),
          );
          return { success: true };
        } catch (err) {
          return { success: false, error: { code: TRANSFER_ERROR_CODES.DISPATCH_FAILED, message: `OpenCode dispatch failed: ${err instanceof Error ? err.message : String(err)}` } };
        }
      }

      case 'antigravity': {
        if (!this.config.antigravityService) {
          return { success: false, error: { code: TRANSFER_ERROR_CODES.RUNTIME_UNAVAILABLE, message: 'Antigravity service unavailable' } };
        }
        try {
          await this.awaitTargetAcceptance((onEvent, onComplete) =>
            this.config.antigravityService!.sendPrompt(targetSessionId, handoffText, onEvent, onComplete),
          );
          return { success: true };
        } catch (err) {
          return { success: false, error: { code: TRANSFER_ERROR_CODES.DISPATCH_FAILED, message: `Antigravity dispatch failed: ${err instanceof Error ? err.message : String(err)}` } };
        }
      }

      case 'pi': {
        try {
          if (this.config.sendPiPrompt && directPath) {
            await this.awaitTargetAcceptance((onEvent, onComplete) =>
              this.config.sendPiPrompt!(directPath, handoffText, onEvent).then(() => onComplete(), onComplete),
            );
            return { success: true };
          }
          let filePath = directPath;
          if (!filePath) {
            const entry = await this.config.registry.get(targetSessionId)
              || await this.config.registry.getByPath(targetSessionId)
              || await this.resolvePiSessionFallback(targetSessionId);
            filePath = entry?.path;
          }
          if (filePath) {
            const record = JSON.stringify({
              type: 'message',
              role: 'user',
              content: handoffText,
              timestamp: Date.now(),
            }) + '\n';
            await fs.appendFile(filePath, record, 'utf-8');
            return { success: true };
          }
          return { success: false, error: { code: TRANSFER_ERROR_CODES.DISPATCH_FAILED, message: 'Pi dispatch failed: could not resolve session file path' } };
        } catch (err) {
          return { success: false, error: { code: TRANSFER_ERROR_CODES.DISPATCH_FAILED, message: `Pi dispatch failed: ${err instanceof Error ? err.message : String(err)}` } };
        }
      }

      default:
        return { success: false, error: { code: TRANSFER_ERROR_CODES.INVALID_REQUEST, message: `Unknown target runtime: ${sdkType}` } };
    }
  }
}
