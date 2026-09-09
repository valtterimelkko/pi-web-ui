import { Router, type Request, type Response } from 'express';
import { cookieAuthMiddleware } from '../middleware/auth.js';
import { getPiService } from '../pi/index.js';
import { WorkerPool } from '../workers/worker-pool.js';
import type { WorkerPoolStats, WorkerInfo } from '@pi-web-ui/shared';
import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import type { SdkType } from '@pi-web-ui/shared';
import { createLogger } from '../logging/logger.js';
import { getSessionRegistry, type RegistryEntry } from '../session-registry.js';
import { config } from '../config.js';
import {
  scanNativeSessions,
  resolveNativeSessionArtifact,
  NATIVE_RUNTIMES,
  type NativeRuntime,
  type NativeScanRoots,
  type NativeKnownSets,
} from '../internal-api/native-sessions.js';
import { resolveClaudeProjectsRoot } from '../internal-api/goal/claude-goal.js';

const logger = createLogger('Sessions');


const router = Router();

// WorkerPool singleton instance
let workerPool: WorkerPool | null = null;

/**
 * Get or create the WorkerPool singleton instance.
 */
export function getWorkerPool(): WorkerPool {
  if (!workerPool) {
    workerPool = new WorkerPool({
      maxWorkers: 15,
      idleTimeoutMs: 30 * 60 * 1000, // 30 minutes
      maxOldSpaceSize: 512,
    });
  }
  return workerPool;
}

// All session routes require authentication
router.use(cookieAuthMiddleware);

// GET /api/sessions - List all sessions
router.get('/', async (req: Request, res: Response) => {
  try {
    const cwd = req.query.cwd as string | undefined;
    const piService = getPiService();
    
    const sessions = cwd 
      ? await piService.listSessions(cwd)
      : await piService.listAllSessions();
    
    res.json({ sessions });
  } catch (error) {
    logger.error('Error listing sessions:', error);
    res.status(500).json({ error: 'Failed to list sessions' });
  }
});

// GET /api/sessions/native - List unmanaged and managed native CLI sessions on disk
router.get('/native', async (req: Request, res: Response) => {
  try {
    const runtimeParam = req.query.runtime as string | undefined;
    let runtimes: NativeRuntime[];
    if (runtimeParam === undefined || runtimeParam.trim() === '') {
      runtimes = [...NATIVE_RUNTIMES];
    } else {
      const parts = runtimeParam.split(',').map((s) => s.trim()).filter(Boolean);
      for (const part of parts) {
        if (part === 'pi') {
          res.status(400).json({
            error: 'Native pi sessions are auto-discovered into the session registry by the SessionWatcher and are already returned by GET /sessions; the native scan covers claude, commandcode, opencode, antigravity',
          });
          return;
        }
        if (!(NATIVE_RUNTIMES as readonly string[]).includes(part)) {
          res.status(400).json({
            error: `Unsupported native runtime: ${part}. Valid runtimes: ${NATIVE_RUNTIMES.join(', ')}`,
          });
          return;
        }
      }
      runtimes = parts as NativeRuntime[];
    }

    let limit = 20;
    const limitParam = req.query.limit as string | undefined;
    if (limitParam !== undefined) {
      const num = parseInt(limitParam, 10);
      if (isNaN(num) || num < 1 || num > 200) {
        res.status(400).json({ error: 'limit must be an integer between 1 and 200' });
        return;
      }
      limit = num;
    }

    let since: Date | undefined;
    if (req.query.since) {
      const parsed = Date.parse(req.query.since as string);
      if (!isNaN(parsed)) since = new Date(parsed);
    }

    let before: Date | undefined;
    if (req.query.before) {
      const parsed = Date.parse(req.query.before as string);
      if (!isNaN(parsed)) before = new Date(parsed);
    }

    const nativeRoots: NativeScanRoots = {
      claudeProjectsDir: resolveClaudeProjectsRoot(),
      commandCodeCliHomeDir: config.commandCodeCliHomeDir,
      commandCodeNativeHomeDir: config.commandCodeNativeHomeDir,
      opencodeStorageDir: config.opencodeStorageDir,
      antigravityConversationsDir: config.antigravityNativeConversationsDir,
    };

    const registry = getSessionRegistry(config.sessionRegistryPath);
    const known: NativeKnownSets = {
      claudeSessionIds: new Map<string, string>(),
      commandCodeNativeSessionIds: new Map<string, string>(),
      opencodeSessionIds: new Map<string, string>(),
      antigravityConversationIds: new Map<string, string>(),
    };
    for (const entry of await registry.listAll()) {
      if (entry.claudeSessionId) known.claudeSessionIds.set(entry.claudeSessionId, entry.id);
      if (entry.commandCodeNativeSessionId) known.commandCodeNativeSessionIds.set(entry.commandCodeNativeSessionId, entry.id);
      if (entry.opencodeSessionId) known.opencodeSessionIds.set(entry.opencodeSessionId, entry.id);
      if (entry.antigravityConversationId) known.antigravityConversationIds.set(entry.antigravityConversationId, entry.id);
    }

    const result = await scanNativeSessions({ runtimes, limit, since, before, roots: nativeRoots, known });
    res.json({
      sessions: result.items,
      truncated: result.truncated,
      scannedRoots: result.scannedRoots,
    });
  } catch (error) {
    logger.error('Error scanning native sessions:', error);
    res.status(500).json({ error: 'Failed to scan native sessions' });
  }
});

// POST /api/sessions/import-native - Import unmanaged CLI session into registry
router.post('/import-native', async (req: Request, res: Response) => {
  try {
    const { runtime, nativeId, cwd, parentSessionId } = req.body ?? {};
    if (!runtime || !nativeId) {
      res.status(400).json({ error: 'runtime and nativeId are required' });
      return;
    }

    if (!(NATIVE_RUNTIMES as readonly string[]).includes(runtime)) {
      res.status(400).json({ error: `Unsupported runtime: ${runtime}. Valid runtimes: ${NATIVE_RUNTIMES.join(', ')}` });
      return;
    }

    // nativeId is joined into filesystem paths: accept only bare artefact base
    // names (no separators, no '..'); resolution additionally containment-checks
    // every candidate against the runtime root before any read.
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(nativeId)) {
      res.status(400).json({ error: 'nativeId must be a bare session file base name' });
      return;
    }

    const registry = getSessionRegistry(config.sessionRegistryPath);

    // If parentSessionId provided, verify parent exists
    if (parentSessionId) {
      const parent = await registry.get(parentSessionId);
      if (!parent) {
        res.status(404).json({ error: 'Parent session not found', code: 'SESSION_NOT_FOUND' });
        return;
      }
    }

    // Check if already registered
    let existingEntry: RegistryEntry | undefined;
    if (runtime === 'claude') {
      existingEntry = await registry.getByClaudeSessionId(nativeId);
    } else if (runtime === 'commandcode') {
      existingEntry = await registry.getByCommandCodeNativeSessionId(nativeId);
    } else if (runtime === 'opencode') {
      existingEntry = await registry.getByOpencodeSessionId(nativeId);
    } else if (runtime === 'antigravity') {
      const all = await registry.listAll();
      existingEntry = all.find((e) => e.antigravityConversationId === nativeId);
    }

    if (existingEntry) {
      if (parentSessionId && existingEntry.parentSessionId !== parentSessionId) {
        existingEntry = await registry.upsert({
          ...existingEntry,
          parentSessionId,
        });
      }
      res.json({
        success: true,
        sessionId: existingEntry.id,
        alreadyRegistered: true,
        runtime,
        session: existingEntry,
      });
      return;
    }

    // Not registered yet — resolve the artefact through the same bounded,
    // containment-checked resolver the Internal API adopt-native uses.
    const nativeRoots: NativeScanRoots = {
      claudeProjectsDir: resolveClaudeProjectsRoot(),
      commandCodeCliHomeDir: config.commandCodeCliHomeDir,
      commandCodeNativeHomeDir: config.commandCodeNativeHomeDir,
      opencodeStorageDir: config.opencodeStorageDir,
      antigravityConversationsDir: config.antigravityNativeConversationsDir,
    };

    const resolved = await resolveNativeSessionArtifact({
      runtime,
      nativeId,
      cwd: typeof cwd === 'string' && cwd.trim() ? cwd.trim() : undefined,
      roots: nativeRoots,
    });
    if (!resolved) {
      res.status(404).json({ error: 'Native session artefact not found on disk', code: 'NATIVE_SESSION_NOT_FOUND' });
      return;
    }

    const mtimeIso = new Date(resolved.mtimeMs).toISOString();
    const entry = await registry.upsert({
      sdkType: runtime as SdkType,
      path: resolved.nativePath,
      claudeSessionId: runtime === 'claude' ? nativeId : undefined,
      commandCodeNativeSessionId: runtime === 'commandcode' ? nativeId : undefined,
      opencodeSessionId: runtime === 'opencode' ? nativeId : undefined,
      antigravityConversationId: runtime === 'antigravity' ? nativeId : undefined,
      cwd: (typeof cwd === 'string' && cwd.trim() ? cwd.trim() : resolved.fileCwd) ?? '',
      firstMessage: resolved.preview || 'Native CLI session',
      messageCount: resolved.messageCount ?? 0,
      createdAt: mtimeIso,
      lastActivity: mtimeIso,
      status: 'idle',
      origin: 'native-discovered',
      parentSessionId,
    });

    res.json({
      success: true,
      sessionId: entry.id,
      runtime,
      session: entry,
    });
  } catch (error) {
    logger.error('Error importing native session:', error);
    res.status(500).json({ error: 'Failed to import native session', detail: error instanceof Error ? error.message : String(error) });
  }
});

// GET /api/sessions/:id - Get session details
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const piService = getPiService();
    
    // Find session by ID (partial match)
    const allSessions = await piService.listAllSessions();
    const session = allSessions.find(s => s.id.startsWith(id) || s.path.includes(id));
    
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    
    res.json({ session });
  } catch (error) {
    logger.error('Error getting session:', error);
    res.status(500).json({ error: 'Failed to get session' });
  }
});

// DELETE /api/sessions/:id - Delete a session
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const piService = getPiService();
    
    // Find session by ID
    const allSessions = await piService.listAllSessions();
    const session = allSessions.find(s => s.id.startsWith(id) || s.path.includes(id));
    
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    
    await piService.deleteSession(session.path);
    
    res.json({ success: true });
  } catch (error) {
    logger.error('Error deleting session:', error);
    res.status(500).json({ error: 'Failed to delete session' });
  }
});

// GET /api/sessions/:id/export - Export session to various formats
router.get('/:id/export', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const format = (req.query.format as string) || 'html'; // html, markdown, json
    const piService = getPiService();
    
    // Find session
    const allSessions = await piService.listAllSessions();
    const session = allSessions.find(s => s.id.startsWith(id) || s.path.includes(id));
    
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    
    // Read session file
    const content = await fs.readFile(session.path, 'utf-8');
    const lines = content.trim().split('\n');
    
    // Parse entries
    const entries = lines.map(line => JSON.parse(line));
    
    // Export based on format
    switch (format.toLowerCase()) {
      case 'markdown':
      case 'md': {
        const markdown = generateSessionMarkdown(session, entries);
        res.setHeader('Content-Type', 'text/markdown');
        res.setHeader('Content-Disposition', `attachment; filename="session-${id}.md"`);
        res.send(markdown);
        break;
      }
      case 'json': {
        const jsonData = generateSessionJson(session, entries);
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="session-${id}.json"`);
        res.send(JSON.stringify(jsonData, null, 2));
        break;
      }
      case 'html':
      default: {
        const html = generateSessionHtml(session, entries);
        res.setHeader('Content-Type', 'text/html');
        res.setHeader('Content-Disposition', `attachment; filename="session-${id}.html"`);
        res.send(html);
        break;
      }
    }
  } catch (error) {
    logger.error('Error exporting session:', error);
    res.status(500).json({ error: 'Failed to export session' });
  }
});

interface SessionInfo {
  id: string;
  cwd: string;
  path: string;
}

interface SessionEntry {
  type?: string;
  message?: {
    role?: string;
    content?: string | unknown;
  };
}

function generateSessionHtml(session: SessionInfo, entries: SessionEntry[]): string {
  const messages = entries
    .filter((e) => e.type === 'message')
    .map((e) => {
      const role = e.message?.role || 'unknown';
      const content = typeof e.message?.content === 'string' 
        ? e.message.content 
        : JSON.stringify(e.message?.content);
      return `<div class="message ${role}"><strong>${role}:</strong> ${escapeHtml(content)}</div>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html>
<head>
  <title>Session ${session.id}</title>
  <style>
    body { font-family: system-ui; max-width: 800px; margin: 0 auto; padding: 20px; }
    .message { padding: 10px; margin: 5px 0; border-radius: 8px; }
    .user { background: #e3f2fd; }
    .assistant { background: #f5f5f5; }
    pre { white-space: pre-wrap; word-wrap: break-word; }
  </style>
</head>
<body>
  <h1>Session ${session.id}</h1>
  <p><strong>CWD:</strong> ${session.cwd}</p>
  ${messages}
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function generateSessionMarkdown(session: SessionInfo, entries: SessionEntry[]): string {
  const messages = entries
    .filter((e) => e.type === 'message')
    .map((e) => {
      const role = e.message?.role || 'unknown';
      const content = typeof e.message?.content === 'string' 
        ? e.message.content 
        : extractTextContent(e.message?.content);
      return `## ${role.charAt(0).toUpperCase() + role.slice(1)}\n\n${content}\n`;
    })
    .join('\n---\n\n');

  const frontMatter = `---
title: "Session ${session.id}"
cwd: "${session.cwd}"
exported: "${new Date().toISOString()}"
message_count: ${entries.filter(e => e.type === 'message').length}
---

`;

  return `# Session ${session.id}

**Working Directory:** \`${session.cwd}\`
**Exported:** ${new Date().toLocaleString()}

---

${messages}`;
}

function generateSessionJson(session: SessionInfo, entries: SessionEntry[]): object {
  const messages = entries
    .filter((e) => e.type === 'message')
    .map((e, index) => ({
      index,
      role: e.message?.role || 'unknown',
      content: typeof e.message?.content === 'string' 
        ? e.message.content 
        : e.message?.content,
    }));

  return {
    session: {
      id: session.id,
      cwd: session.cwd,
      path: session.path,
      exported: new Date().toISOString(),
    },
    messages,
    metadata: {
      totalMessages: messages.length,
      userMessages: messages.filter(m => m.role === 'user').length,
      assistantMessages: messages.filter(m => m.role === 'assistant').length,
    },
  };
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block: { type?: string; text?: string; thinking?: string }) => {
        if (block.type === 'text' && block.text) return block.text;
        if (block.type === 'thinking' && block.thinking) return `[Thinking]\n${block.thinking}`;
        return '';
      })
      .filter(Boolean)
      .join('\n\n');
  }
  return JSON.stringify(content);
}

// ============================================================================
// Worker Pool Routes
// ============================================================================

// GET /api/sessions/workers - Get worker pool statistics
router.get('/workers', async (_req: Request, res: Response) => {
  try {
    const pool = getWorkerPool();
    const stats: WorkerPoolStats = pool.getStats();
    
    res.json({
      success: true,
      stats,
    });
  } catch (error) {
    logger.error('Error getting worker pool stats:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to get worker pool statistics' 
    });
  }
});

// GET /api/sessions/workers/:sessionPath - Get worker info for a specific session
router.get('/workers/:sessionPath', async (req: Request, res: Response) => {
  try {
    const { sessionPath } = req.params;
    
    if (!sessionPath) {
      res.status(400).json({
        success: false,
        error: 'Session path is required',
      });
      return;
    }
    
    // Decode the session path (it may be URL-encoded)
    const decodedPath = decodeURIComponent(sessionPath);
    
    const pool = getWorkerPool();
    const worker = pool.get(decodedPath);
    
    if (!worker) {
      res.status(404).json({
        success: false,
        error: 'Worker not found for session',
      });
      return;
    }
    
    const workerInfo: WorkerInfo = {
      sessionPath: decodedPath,
      status: worker.status,
      pid: worker.pid,
      lastActivity: worker.lastActivity,
      spawnedAt: Date.now(), // Approximation since worker doesn't expose spawnedAt
    };
    
    res.json({
      success: true,
      worker: workerInfo,
    });
  } catch (error) {
    logger.error('Error getting worker info:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to get worker information' 
    });
  }
});

// ============================================================================
// Worker Crash Monitoring Routes
// ============================================================================

// GET /api/sessions/workers/crashes/stats - Get crash statistics
router.get('/workers/crashes/stats', async (_req: Request, res: Response) => {
  try {
    const pool = getWorkerPool();
    const stats = pool.getCrashStats();
    
    res.json({
      success: true,
      stats,
    });
  } catch (error) {
    logger.error('Error getting crash stats:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to get crash statistics' 
    });
  }
});

// GET /api/sessions/workers/crashes/recent - Get recent crash records
router.get('/workers/crashes/recent', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 10;
    const pool = getWorkerPool();
    const crashes = pool.getRecentCrashes(Math.min(limit, 100));
    
    res.json({
      success: true,
      crashes,
    });
  } catch (error) {
    logger.error('Error getting recent crashes:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to get recent crashes' 
    });
  }
});

// GET /api/sessions/workers/crashes/by-session/:sessionPath - Get crashes for specific session
router.get('/workers/crashes/by-session/:sessionPath', async (req: Request, res: Response) => {
  try {
    const { sessionPath } = req.params;
    
    if (!sessionPath) {
      res.status(400).json({
        success: false,
        error: 'Session path is required',
      });
      return;
    }
    
    const decodedPath = decodeURIComponent(sessionPath);
    const pool = getWorkerPool();
    const crashCount = pool.getSessionCrashCount(decodedPath);
    
    // Import getCrashLogger directly to get records for this session
    const { getCrashLogger } = await import('../workers/crash-logger.js');
    const crashes = getCrashLogger().getRecords({ sessionPath: decodedPath });
    
    res.json({
      success: true,
      sessionPath: decodedPath,
      crashCount,
      crashes,
    });
  } catch (error) {
    logger.error('Error getting session crashes:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to get session crash information' 
    });
  }
});

export default router;
