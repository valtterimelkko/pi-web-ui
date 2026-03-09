import { Router, type Request, type Response } from 'express';
import { cookieAuthMiddleware } from '../middleware/auth.js';
import { getPiService } from '../pi/index.js';
import { apiLimiter } from '../security/rate-limit.js';
import fs from 'fs/promises';

const router = Router();

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

// GET /api/sessions/:id/export - Export session to HTML
router.get('/:id/export', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
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
    
    // Generate simple HTML export
    const html = generateSessionHtml(session, entries);
    
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Disposition', `attachment; filename="session-${id}.html"`);
    res.send(html);
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

export default router;
