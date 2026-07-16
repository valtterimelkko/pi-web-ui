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
import type { BatchCreateEntry, SessionRuntime } from '../types.js';
import { config } from '../../config.js';

export interface BatchCreateDeps {
  claudeService: ClaudeService;
  opencodeService: OpenCodeService;
  antigravityService: AntigravityService;
  multiSessionManager: MultiSessionManager;
  sessionRegistry: SessionRegistryManager;
  piService: PiService;
  internalClientId: string;
}

export interface CreatedSession {
  sessionId: string;
  sessionPath: string;
  runtime: SessionRuntime;
  model?: string;
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
    case 'claude': {
      if (!(await deps.claudeService.isAvailable())) {
        throw new Error('Claude runtime is not available');
      }
      const { sessionId } = await deps.claudeService.createSession(cwd, entry.model || 'sonnet', entry.thinkingLevel);
      return { sessionId, sessionPath: sessionId, runtime: 'claude', model: entry.model || 'sonnet', cwd };
    }

    case 'opencode': {
      if (!(await deps.opencodeService.isAvailable())) {
        throw new Error('OpenCode runtime is not available');
      }
      const { sessionId } = await deps.opencodeService.createSession(cwd);
      if (entry.model) {
        await deps.opencodeService.setModel?.(sessionId, entry.model).catch(() => { /* non-fatal */ });
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

    case 'pi':
    default: {
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
      return {
        sessionId: status.sessionId,
        sessionPath: status.sessionPath,
        runtime: 'pi',
        model: entry.model,
        cwd,
      };
    }
  }
}
