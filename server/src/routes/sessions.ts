import { Router, type Request, type Response } from 'express';
import { cookieAuthMiddleware } from '../middleware/auth.js';
import { getPiService } from '../pi/index.js';
import { apiLimiter } from '../security/rate-limit.js';
import { WorkerPool } from '../workers/worker-pool.js';
import type { WorkerPoolStats, WorkerInfo } from '@pi-web-ui/shared';
import fs from 'fs/promises';

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
router.use(apiLimiter);

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
    console.error('Error listing sessions:', error);
    res.status(500).json({ error: 'Failed to list sessions' });
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
    console.error('Error getting session:', error);
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
    console.error('Error deleting session:', error);
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
    console.error('Error exporting session:', error);
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
    console.error('Error getting worker pool stats:', error);
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
    console.error('Error getting worker info:', error);
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
    console.error('Error getting crash stats:', error);
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
    console.error('Error getting recent crashes:', error);
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
    console.error('Error getting session crashes:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to get session crash information' 
    });
  }
});

export default router;
