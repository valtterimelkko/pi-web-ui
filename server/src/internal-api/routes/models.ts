/**
 * Internal API: Models Route
 *
 * Lists available models across all runtimes. Always queries live —
 * new models appear immediately without restart.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import type { ModelsResponse, ModelInfo, SessionRuntime } from '../types.js';
import type { ClaudeService } from '../../claude/claude-service.js';
import type { OpenCodeService } from '../../opencode/opencode-service.js';
import type { AntigravityService } from '../../antigravity/antigravity-service.js';
import type { PiService } from '../../pi/pi-service.js';

export interface ModelsRoutesDeps {
  piService: PiService;
  claudeService: ClaudeService;
  opencodeService: OpenCodeService;
  antigravityService: AntigravityService;
}

export function createModelsRoutes(deps: ModelsRoutesDeps) {
  const { piService, claudeService, opencodeService, antigravityService } = deps;

  async function handleListModels(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      const runtimeFilter = url.searchParams.get('runtime') as SessionRuntime | null;

      const result: ModelsResponse['models'] & { antigravity: ModelInfo[] } = {
        pi: [],
        claude: [],
        opencode: [],
        antigravity: [],
      };

      // Pi SDK models
      if (!runtimeFilter || runtimeFilter === 'pi') {
        try {
          const piModels = await piService.getAvailableModels();
          result.pi = piModels.map((m) => ({
            id: m.id,
            displayName: m.name || m.id,
            provider: m.provider,
          }));
        } catch {
          // Pi SDK may not be available — return empty list
        }
      }

      // Claude models
      if (!runtimeFilter || runtimeFilter === 'claude') {
        if (await claudeService.isAvailable()) {
          result.claude = [
            { id: 'sonnet', displayName: 'Claude Sonnet 4', provider: 'anthropic' },
            { id: 'opus', displayName: 'Claude Opus 4', provider: 'anthropic' },
            { id: 'haiku', displayName: 'Claude Haiku 3.5', provider: 'anthropic' },
          ];
        }
      }

      // OpenCode models
      if (!runtimeFilter || runtimeFilter === 'opencode') {
        if (await opencodeService.isAvailable()) {
          try {
            const ocModels = await opencodeService.getAvailableModels();
            result.opencode = ocModels.map((m) => ({
              id: m.id,
              displayName: m.name || m.id,
              provider: m.provider,
              contextWindow: m.contextWindow,
              reasoning: m.reasoning,
            }));
          } catch {
            // OpenCode may not respond — return empty
          }
        }
      }

      // Antigravity models
      if (!runtimeFilter || runtimeFilter === 'antigravity') {
        if (await antigravityService.isAvailable()) {
          try {
            const agModels = await antigravityService.getAvailableModels();
            result.antigravity = agModels.map((m) => ({
              id: m.id,
              displayName: m.name || m.id,
              provider: m.provider,
            }));
          } catch {
            // agy models may not respond — return empty
          }
        }
      }

      sendJson(res, 200, { models: result });
    } catch (err) {
      console.error('[InternalAPI] Failed to list models:', err);
      sendJson(res, 500, { error: 'Failed to list models', code: 'INTERNAL_ERROR' });
    }
  }

  /**
   * POST /api/v1/models/refresh
   *
   * Refresh the OpenCode model catalogue (warm cache + idle-aware recycle) and
   * return a snapshot diff. Drives the weekly automation; safe to call ad hoc.
   * Body (optional): { warmCache?: boolean, recycle?: boolean }.
   */
  async function handleRefreshModels(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    try {
      const body = await readJsonBody(req);
      const warmCache = typeof body.warmCache === 'boolean' ? body.warmCache : undefined;
      const recycle = typeof body.recycle === 'boolean' ? body.recycle : undefined;

      if (!(await opencodeService.isAvailable())) {
        sendJson(res, 503, { error: 'OpenCode is not available', code: 'OPENCODE_UNAVAILABLE' });
        return;
      }

      const result = await opencodeService.refreshModels({ warmCache, recycle });
      sendJson(res, 200, result);
    } catch (err) {
      console.error('[InternalAPI] Failed to refresh OpenCode models:', err);
      sendJson(res, 500, { error: 'Failed to refresh models', code: 'INTERNAL_ERROR' });
    }
  }

  return { handleListModels, handleRefreshModels };
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        resolve(parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}
