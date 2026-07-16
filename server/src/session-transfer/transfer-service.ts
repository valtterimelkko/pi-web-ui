import fs from 'fs/promises';
import { constants as fsConstants } from 'fs';
import path from 'path';
import type { SessionRegistryManager, RegistryEntry } from '../session-registry.js';
import type { ClaudeService } from '../claude/claude-service.js';
import type { OpenCodeService } from '../opencode/opencode-service.js';
import type { AntigravityService } from '../antigravity/antigravity-service.js';
import { validateTransferRequest, type ValidationResult } from './transfer-validation.js';
import { TRANSFER_ERROR_CODES } from './types.js';
import type { TransferRequest, VisibleTranscriptSource } from './types.js';
import { buildHandoffPayload } from './transfer-framing.js';
import { extractPiTranscriptFromRaw } from './pi-source-adapter.js';
import { extractClaudeTranscript } from './claude-source-adapter.js';
import { extractOpenCodeTranscript } from './opencode-source-adapter.js';
import type { SourceAdapterResult } from './pi-source-adapter.js';
import type { SdkType } from '@pi-web-ui/shared';
import { createLogger } from '../logging/logger.js';
import { detectPromptInjection } from '../security/prompt-injection.js';

const logger = createLogger('Transfer');
const MAX_PI_HEADER_BYTES = 16 * 1024;
const MAX_CWD_LENGTH = 4096;
const MAX_PI_SOURCE_FILE_BYTES = 64 * 1024 * 1024;
const MAX_HANDOFF_BYTES = 1024 * 1024;
const reservedTargetIds = new Set<string>();

class TargetAcceptanceError extends Error {
  constructor(message: string, readonly startRejected = false) {
    super(message);
    this.name = 'TargetAcceptanceError';
  }
}

interface SafePiCandidate {
  path: string;
  stat: Awaited<ReturnType<typeof fs.stat>>;
  header: { id?: unknown; cwd?: unknown } | null;
}

function safeHeaderCwd(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_CWD_LENGTH) return fallback;
  // Deliberately reject ASCII control characters in filesystem metadata.
  // eslint-disable-next-line no-control-regex
  if (!path.isAbsolute(value) || /[\u0000-\u001f\u007f]/u.test(value)) return fallback;
  return path.normalize(value);
}

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
  sendPiPrompt?: (sessionPath: string, message: string, onEvent: (event: unknown) => void, cwd?: string) => Promise<void>;
  /** Reports whether a resolved Pi target is currently busy or streaming. */
  isPiSessionBusy?: (sessionPath: string, sessionId: string) => boolean;
  /** Cancels a Pi transfer prompt that failed before acceptance or timed out. */
  abortPiPrompt?: (sessionPath: string) => Promise<void> | void;
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

    const sourceEntry = await this.resolveSessionEntry(request.sourceSessionId);

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
          code: sourceResult.error.includes('safety limit')
            ? TRANSFER_ERROR_CODES.SOURCE_TOO_LARGE
            : TRANSFER_ERROR_CODES.EMPTY_SOURCE,
          message: sourceResult.error,
        },
      };
    }

    const handoff = buildHandoffPayload(sourceResult.transcript);
    if (Buffer.byteLength(handoff.fullText, 'utf8') > MAX_HANDOFF_BYTES) {
      return {
        success: false,
        sourceSessionId: request.sourceSessionId,
        targetSessionId: request.targetSessionId ?? '',
        createdNewSession: false,
        error: {
          code: TRANSFER_ERROR_CODES.SOURCE_TOO_LARGE,
          message: `Transferred context exceeds the ${MAX_HANDOFF_BYTES}-byte safety limit`,
        },
      };
    }
    const injection = detectPromptInjection(handoff.fullText);
    if (injection.recommendation === 'block') {
      return {
        success: false,
        sourceSessionId: request.sourceSessionId,
        targetSessionId: request.targetSessionId ?? '',
        createdNewSession: false,
        error: {
          code: TRANSFER_ERROR_CODES.PROMPT_INJECTION,
          message: 'Transferred context was blocked by the prompt-injection safety filter',
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
      const targetEntry = await this.resolveSessionEntry(targetSessionId);
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

      if (this.isSameResolvedSession(sourceEntry, targetEntry)) {
        return {
          success: false,
          sourceSessionId: request.sourceSessionId,
          targetSessionId: targetEntry.id,
          createdNewSession: false,
          error: {
            code: TRANSFER_ERROR_CODES.SELF_TRANSFER,
            message: 'Cannot transfer a session into itself',
          },
        };
      }

      targetSessionId = targetEntry.id;
      if (this.isTargetBusy(targetSessionId, targetEntry.sdkType, targetEntry.path)) {
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

    const resolvedTargetType = request.createNew ? request.targetSdkType! : targetSdkType!;
    if (reservedTargetIds.has(targetSessionId)
      || (!createdNewSession && this.isTargetBusy(targetSessionId, resolvedTargetType, targetSessionPath))) {
      return {
        success: false,
        sourceSessionId: request.sourceSessionId,
        targetSessionId,
        createdNewSession,
        error: {
          code: TRANSFER_ERROR_CODES.TARGET_BUSY,
          message: 'Target session is busy/streaming. Cannot transfer into an active session.',
        },
      };
    }

    reservedTargetIds.add(targetSessionId);
    let dispatchResult: Awaited<ReturnType<TransferService['dispatchToTarget']>>;
    try {
      dispatchResult = await this.dispatchToTarget(
        targetSessionId,
        resolvedTargetType,
        handoff.fullText,
        targetSessionPath,
      );
    } finally {
      reservedTargetIds.delete(targetSessionId);
    }

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

  private async resolveSessionEntry(sessionIdOrPath: string): Promise<RegistryEntry | undefined> {
    const registered = await this.config.registry.get(sessionIdOrPath)
      || await this.config.registry.getByPath(sessionIdOrPath);
    if (!registered) return this.resolvePiSessionFallback(sessionIdOrPath);
    if (registered.sdkType !== 'pi') return registered;

    const safe = await this.resolveSafePiCandidate(registered.path);
    if (!safe) return undefined;
    if (safe.header && Object.prototype.hasOwnProperty.call(safe.header, 'id')
      && (typeof safe.header.id !== 'string' || !safe.header.id || safe.header.id !== registered.id)) return undefined;
    const dirName = path.basename(path.dirname(safe.path));
    const inner = dirName.replace(/^--/, '').replace(/--$/, '');
    const fallbackCwd = '/' + inner.replace(/--/g, '/');
    return {
      ...registered,
      id: registered.id,
      path: safe.path,
      cwd: safeHeaderCwd(safe.header?.cwd ?? registered.cwd, fallbackCwd),
    };
  }

  private isSameResolvedSession(source: RegistryEntry, target: RegistryEntry): boolean {
    if (source.sdkType !== target.sdkType) return false;
    if (source.sdkType === 'pi') return source.path === target.path;
    return source.id === target.id;
  }

  private piSessionDir(): string {
    return this.config.piSessionDir || path.join(process.env.HOME || '/root', '.pi/agent/sessions');
  }

  private async resolveSafePiCandidate(candidatePath: string): Promise<SafePiCandidate | undefined> {
    if (!path.isAbsolute(candidatePath) || !candidatePath.endsWith('.jsonl')) return undefined;
    try {
      const [root, candidate, lstat] = await Promise.all([
        fs.realpath(this.piSessionDir()),
        fs.realpath(candidatePath),
        fs.lstat(candidatePath),
      ]);
      const relative = path.relative(root, candidate);
      if (relative === '' || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) return undefined;
      if (lstat.isSymbolicLink()) return undefined;
      const stat = await fs.stat(candidate);
      if (!stat.isFile()) return undefined;

      let header: SafePiCandidate['header'] = null;
      const handle = await fs.open(candidate, 'r');
      try {
        const buffer = Buffer.alloc(MAX_PI_HEADER_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const text = buffer.toString('utf8', 0, bytesRead);
        const newline = text.indexOf('\n');
        if (newline >= 0 || bytesRead < buffer.length) {
          const firstLine = newline >= 0 ? text.slice(0, newline) : text;
          const parsed = JSON.parse(firstLine) as unknown;
          if (typeof parsed === 'object' && parsed !== null) header = parsed as SafePiCandidate['header'];
        }
      } catch {
        // Legacy or partial files can still be used when their filesystem path is safe.
      } finally {
        await handle.close();
      }
      return { path: candidate, stat, header };
    } catch {
      return undefined;
    }
  }

  private async resolvePiSessionFallback(sessionIdOrPath: string): Promise<RegistryEntry | undefined> {
    try {
      let matches: SafePiCandidate[] = [];
      if (sessionIdOrPath.includes('/')) {
        const direct = await this.resolveSafePiCandidate(sessionIdOrPath);
        if (direct) matches = [direct];
      } else {
        const dirs = await fs.readdir(this.piSessionDir(), { withFileTypes: true });
        const candidatePaths: string[] = [];
        for (const dir of dirs) {
          if (!dir.isDirectory() || dir.isSymbolicLink()) continue;
          const subDir = path.join(this.piSessionDir(), dir.name);
          const files = await fs.readdir(subDir, { withFileTypes: true });
          for (const file of files) {
            if (!file.isFile() || file.isSymbolicLink() || !file.name.endsWith('.jsonl') || !file.name.includes(sessionIdOrPath)) continue;
            candidatePaths.push(path.join(subDir, file.name));
          }
        }
        const resolved = await Promise.all(candidatePaths.map((candidate) => this.resolveSafePiCandidate(candidate)));
        matches = resolved.filter((candidate): candidate is SafePiCandidate =>
          candidate !== undefined && candidate.header?.id === sessionIdOrPath,
        );
        // A bare ID must resolve uniquely; filesystem ordering must never choose.
        if (matches.length !== 1) return undefined;
      }

      const match = matches[0];
      if (!match) return undefined;
      const dirName = path.basename(path.dirname(match.path));
      const inner = dirName.replace(/^--/, '').replace(/--$/, '');
      const fallbackCwd = '/' + inner.replace(/--/g, '/');
      const cwd = safeHeaderCwd(match.header?.cwd, fallbackCwd);
      return {
        id: typeof match.header?.id === 'string' ? match.header.id : sessionIdOrPath,
        sdkType: 'pi',
        path: match.path,
        cwd,
        firstMessage: '',
        messageCount: 0,
        createdAt: match.stat.birthtime.toISOString(),
        lastActivity: match.stat.mtime.toISOString(),
        status: 'idle',
      };
    } catch {
      return undefined;
    }
  }

  private async extractSource(entry: RegistryEntry, request: TransferRequest): Promise<SourceAdapterResult> {
    const entryId = typeof entry.id === 'string' && entry.id ? entry.id : request.sourceSessionId;
    const firstMessage = typeof entry.firstMessage === 'string' ? entry.firstMessage.slice(0, 50) : '';
    const source: VisibleTranscriptSource = {
      sessionId: entryId,
      displayName: (request.sourceDisplayName ?? firstMessage) || entryId,
      sdkType: entry.sdkType,
      cwd: safeHeaderCwd(entry.cwd, process.cwd()),
      createdAt: entry.createdAt,
      lastActivity: entry.lastActivity,
    };

    switch (entry.sdkType) {
      case 'pi': {
        const candidate = await this.resolveSafePiCandidate(entry.path);
        if (!candidate) {
          return { transcript: { source, scope: request.scope, itemCount: 0, truncated: false, items: [] }, error: 'Unsafe Pi session file path' };
        }
        let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
        try {
          const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
          handle = await fs.open(candidate.path, fsConstants.O_RDONLY | noFollow);
          const opened = await handle.stat();
          if (!opened.isFile() || opened.dev !== candidate.stat.dev || opened.ino !== candidate.stat.ino) {
            return { transcript: { source, scope: request.scope, itemCount: 0, truncated: false, items: [] }, error: 'Pi session file changed during validation' };
          }
          if (opened.size > MAX_PI_SOURCE_FILE_BYTES) {
            return { transcript: { source, scope: request.scope, itemCount: 0, truncated: false, items: [] }, error: `Pi session file exceeds the ${MAX_PI_SOURCE_FILE_BYTES}-byte safety limit` };
          }
          const raw = await handle.readFile({ encoding: 'utf8' });
          return extractPiTranscriptFromRaw(raw, source, request.scope);
        } catch {
          return { transcript: { source, scope: request.scope, itemCount: 0, truncated: false, items: [] }, error: 'Failed to read Pi session file safely' };
        } finally {
          await handle?.close().catch(() => undefined);
        }
      }

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

  private isTargetBusy(sessionId: string, sdkType: SdkType, sessionPath?: string): boolean {
    switch (sdkType) {
      case 'claude':
        return this.config.claudeService?.isRunning(sessionId) ?? false;
      case 'opencode':
        return this.config.opencodeService?.isRunning(sessionId) ?? false;
      case 'pi':
        return sessionPath ? (this.config.isPiSessionBusy?.(sessionPath, sessionId) ?? false) : false;
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
        settle(new TargetAcceptanceError(`Target did not accept the transfer within ${timeoutMs}ms`));
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
          settle(new TargetAcceptanceError(error instanceof Error ? error.message : String(error), true));
        });
      } catch (error) {
        settle(new TargetAcceptanceError(error instanceof Error ? error.message : String(error), true));
      }
    });
  }

  private async dispatchToTarget(
    targetSessionId: string,
    sdkType: SdkType,
    handoffText: string,
    directPath: string | undefined,
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
          if (!(err instanceof TargetAcceptanceError && err.startRejected)) this.config.claudeService.abort?.(targetSessionId);
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
          if (!(err instanceof TargetAcceptanceError && err.startRejected)) this.config.opencodeService.abort?.(targetSessionId);
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
          if (!(err instanceof TargetAcceptanceError && err.startRejected)) this.config.antigravityService.abort?.(targetSessionId);
          return { success: false, error: { code: TRANSFER_ERROR_CODES.DISPATCH_FAILED, message: `Antigravity dispatch failed: ${err instanceof Error ? err.message : String(err)}` } };
        }
      }

      case 'pi': {
        try {
          if (this.config.sendPiPrompt && directPath) {
            const safeTarget = await this.resolveSafePiCandidate(directPath);
            if (!safeTarget) {
              return { success: false, error: { code: TRANSFER_ERROR_CODES.DISPATCH_FAILED, message: 'Pi dispatch failed: unsafe session file path' } };
            }
            const targetCwd = safeHeaderCwd(safeTarget.header?.cwd, path.dirname(safeTarget.path));
            await this.awaitTargetAcceptance((onEvent, onComplete) =>
              this.config.sendPiPrompt!(safeTarget.path, handoffText, onEvent, targetCwd).then(() => onComplete(), onComplete),
            );
            return { success: true };
          }
          return {
            success: false,
            error: {
              code: TRANSFER_ERROR_CODES.RUNTIME_UNAVAILABLE,
              message: 'Pi dispatch failed: active runtime prompt integration is unavailable',
            },
          };
        } catch (err) {
          if (!(err instanceof TargetAcceptanceError && err.startRejected) && directPath) await this.config.abortPiPrompt?.(directPath);
          return { success: false, error: { code: TRANSFER_ERROR_CODES.DISPATCH_FAILED, message: `Pi dispatch failed: ${err instanceof Error ? err.message : String(err)}` } };
        }
      }

      default:
        return { success: false, error: { code: TRANSFER_ERROR_CODES.INVALID_REQUEST, message: `Unknown target runtime: ${sdkType}` } };
    }
  }
}
