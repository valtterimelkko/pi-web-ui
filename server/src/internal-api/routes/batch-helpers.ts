/**
 * Internal API: Batch helpers
 *
 * Shared session-creation logic used by both POST /sessions and
 * POST /sessions/batch. Extracted so the batch endpoint can create
 * multiple sessions in parallel without duplicating the per-runtime
 * switch statement.
 */

import type { ClaudeService } from '../../claude/claude-service.js';
import type { OpenCodeService } from '../../opencode/opencode-service.js';
import type { AntigravityService } from '../../antigravity/antigravity-service.js';
import type { MultiSessionManager } from '../../pi/multi-session-manager.js';
import type { SessionRegistryManager } from '../../session-registry.js';
import type { PiService } from '../../pi/pi-service.js';
import type { CommandCodeService } from '../../command-code/command-code-service.js';
import type { BatchCreateEntry, SessionRuntime } from '../types.js';
import { unlink } from 'fs/promises';
import { config } from '../../config.js';
import { ErrorCode } from '../error-codes.js';
import {
  assertPiModelAllowed,
  assertResolvedPiModelAllowed,
  PiProviderNotAllowedError,
} from '../pi-provider-policy.js';

/** A runtime-level error with a stable contract code, thrown from batch
 * creation so the batch result surfaces the contracted code (e.g.
 * RUNTIME_UNAVAILABLE) rather than a generic SESSION_CREATE_FAILED. */
export class RuntimeOpError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'RuntimeOpError';
  }
}

export interface BatchCreateDeps {
  claudeService: ClaudeService;
  opencodeService: OpenCodeService;
  antigravityService: AntigravityService;
  multiSessionManager: MultiSessionManager;
  sessionRegistry: SessionRegistryManager;
  piService: PiService;
  internalClientId: string;
  cleanupRejectedSession(sessionId: string): Promise<void>;
  blockedPiProviders?: readonly string[];
  commandCodeService?: CommandCodeService;
}

export interface CreatedSession {
  sessionId: string;
  sessionPath: string;
  runtime: SessionRuntime;
  model?: string;
  modelSelector?: string;
  executionInstanceId?: string;
  cwd: string;
}

export async function createOneSession(params: {
  entry: BatchCreateEntry;
  deps: BatchCreateDeps;
}): Promise<CreatedSession> {
  const { entry, deps } = params;
  const runtime: SessionRuntime = entry.runtime;
  const cwd = entry.cwd || config.validationDefaultCwd;

  switch (runtime) {
    case 'commandcode': {
      if (!deps.commandCodeService?.isEnabled()) throw new RuntimeOpError(ErrorCode.RUNTIME_UNAVAILABLE, 'Command Code runtime is disabled');
      if (!deps.commandCodeService.isAvailable()) throw new RuntimeOpError(ErrorCode.COMMANDCODE_MODEL_UNAVAILABLE, 'Command Code runtime is not available');
      if (entry.model !== 'qwen/qwen3.8-max' && entry.model !== 'meta/muse-spark-1.2-contributor') {
        throw new RuntimeOpError(ErrorCode.COMMANDCODE_MODEL_UNAVAILABLE, 'Command Code requires one exact allowlisted model id');
      }
      if (entry.invocationRole !== 'conductor-root' && entry.invocationRole !== 'implementation-child') {
        throw new RuntimeOpError(ErrorCode.COMMANDCODE_ROLE_REFUSED, 'Command Code invocationRole is required');
      }
      const created = await deps.commandCodeService.createSession({
        cwd,
        model: entry.model,
        permissionProfile: entry.invocationRole === 'conductor-root' ? 'agent-os-7f-root-readonly' : 'implementation-child-wide',
        invocationRole: entry.invocationRole,
        roleAttestation: entry.commandCodeAttestation,
      });
      return { sessionId: created.sessionId, sessionPath: created.sessionId, runtime: 'commandcode', model: created.modelSelector, modelSelector: created.modelSelector, executionInstanceId: created.executionInstanceId, cwd: created.cwd };
    }

    case 'claude': {
      if (!(await deps.claudeService.isAvailable())) {
        throw new Error('Claude runtime is not available');
      }
      const requestedModel = entry.model || 'sonnet';
      const profileId = requestedModel.startsWith('profile:')
        ? requestedModel.slice('profile:'.length)
        : undefined;
      const model = profileId !== undefined ? 'sonnet' : requestedModel;
      const { sessionId } = await deps.claudeService.createSession(cwd, model, entry.thinkingLevel, profileId);
      if (profileId !== undefined) {
        const resolved = await deps.sessionRegistry.get(sessionId);
        if (!resolved
          || resolved.sdkType !== 'claude'
          || resolved.claudeProfileId !== profileId
          || !resolved.claudeProfileBackend
          || !resolved.claudeProviderId) {
          await deps.cleanupRejectedSession(sessionId);
          throw new Error(`Explicit Claude profile '${profileId}' did not resolve to the requested concrete session binding.`);
        }
      }
      return {
        sessionId,
        sessionPath: sessionId,
        runtime: 'claude',
        model: requestedModel,
        ...(profileId !== undefined ? { modelSelector: requestedModel, executionInstanceId: profileId } : {}),
        cwd,
      };
    }

    case 'opencode': {
      if (!deps.opencodeService.isEnabled()) {
        throw new RuntimeOpError(ErrorCode.RUNTIME_UNAVAILABLE, 'OpenCode runtime is disabled (OPENCODE_ENABLED=false)');
      }
      if (!(await deps.opencodeService.isAvailable())) {
        throw new RuntimeOpError(ErrorCode.RUNTIME_UNAVAILABLE, 'OpenCode runtime is not available');
      }
      const { sessionId } = await deps.opencodeService.createSession(cwd);
      if (entry.model) {
        await deps.opencodeService.setModel?.(sessionId, entry.model).catch(() => { /* non-fatal */ });
      }
      if (entry.thinkingLevel) {
        await deps.opencodeService.setThinkingLevel(sessionId, entry.thinkingLevel);
      }
      return { sessionId, sessionPath: sessionId, runtime: 'opencode', model: entry.model, cwd };
    }

    case 'antigravity': {
      if (!(await deps.antigravityService.isAvailable())) {
        throw new Error('Antigravity runtime is not available');
      }
      const { sessionId } = await deps.antigravityService.createSession(cwd, entry.model);
      return { sessionId, sessionPath: sessionId, runtime: 'antigravity', model: entry.model, cwd };
    }

    case 'pi': {
      try {
        assertPiModelAllowed(entry.model, deps.blockedPiProviders ?? config.internalApiBlockedPiProviders);
      } catch (error) {
        if (error instanceof PiProviderNotAllowedError) {
          throw new RuntimeOpError(error.code, error.message);
        }
        throw error;
      }
      const status = await deps.multiSessionManager.createAndSubscribe(deps.internalClientId, cwd);
      await deps.sessionRegistry.upsert({
        id: status.sessionId,
        sdkType: 'pi',
        path: status.sessionPath,
        cwd,
        firstMessage: '',
        messageCount: 0,
        status: 'idle',
      });
      if (entry.model) {
        await deps.piService.setModel(status.sessionId, entry.model).catch(() => { /* non-fatal */ });
      }
      const effectiveModel = deps.multiSessionManager.getAgentSession(status.sessionPath)?.model;
      try {
        assertResolvedPiModelAllowed(
          effectiveModel ? `${effectiveModel.provider}/${effectiveModel.id}` : entry.model,
          deps.blockedPiProviders ?? config.internalApiBlockedPiProviders,
        );
      } catch (error) {
        deps.multiSessionManager.unsubscribeClient(deps.internalClientId, status.sessionPath);
        deps.multiSessionManager.disposeLoadedSession(status.sessionPath);
        await unlink(status.sessionPath).catch(() => undefined);
        await deps.sessionRegistry.delete(status.sessionId);
        if (error instanceof PiProviderNotAllowedError) {
          throw new RuntimeOpError(error.code, error.message);
        }
        throw error;
      }
      if (entry.thinkingLevel) {
        const agentSession = deps.multiSessionManager.getAgentSession(status.sessionPath);
        if (!agentSession) {
          throw new Error('Pi session not loaded');
        }
        agentSession.setThinkingLevel(entry.thinkingLevel);
      }
      return {
        sessionId: status.sessionId,
        sessionPath: status.sessionPath,
        runtime: 'pi',
        model: entry.model,
        cwd,
      };
    }

    default: {
      // createOneSession is only called after batchCreateBodySchema validation,
      // which restricts runtime to the four supported values. Reject explicitly
      // rather than falling back to Pi for an unknown runtime.
      throw new Error(`Unsupported runtime: ${runtime}`);
    }
  }
}
