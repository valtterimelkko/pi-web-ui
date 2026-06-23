import { Router, type Request, type Response } from 'express';
import { cookieAuthMiddleware } from '../middleware/auth.js';
import { apiLimiter } from '../security/rate-limit.js';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('Usage');


const router = Router();

// Usage data file path
const USAGE_FILE = path.join(os.homedir(), '.pi', 'agent', 'web-ui-usage.json');

interface UsageRecord {
  sessionId: string;
  sessionPath: string;
  cwd: string;
  timestamp: string;
  model: string;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
  messageCount: number;
}

interface UsageData {
  records: UsageRecord[];
  lastUpdated: string;
}

// All usage routes require authentication
router.use(cookieAuthMiddleware);
router.use(apiLimiter);

/**
 * Load usage data from file
 */
async function loadUsageData(): Promise<UsageData> {
  try {
    const content = await fs.readFile(USAGE_FILE, 'utf-8');
    return JSON.parse(content);
  } catch {
    return { records: [], lastUpdated: new Date().toISOString() };
  }
}

/**
 * Save usage data to file
 */
async function saveUsageData(data: UsageData): Promise<void> {
  data.lastUpdated = new Date().toISOString();
  await fs.mkdir(path.dirname(USAGE_FILE), { recursive: true });
  await fs.writeFile(USAGE_FILE, JSON.stringify(data, null, 2));
}

/**
 * POST /api/usage/record - Record usage for a session
 */
router.post('/record', async (req: Request, res: Response) => {
  try {
    const { sessionId, sessionPath, cwd, model, tokens, cost, messageCount } = req.body;

    if (!sessionId || !tokens) {
      res.status(400).json({ error: 'Missing required fields: sessionId, tokens' });
      return;
    }

    const data = await loadUsageData();
    
    // Check if we already have a recent record for this session (within 1 minute)
    const recentRecord = data.records.find(
      r => r.sessionId === sessionId && 
      Date.now() - new Date(r.timestamp).getTime() < 60000
    );

    if (recentRecord) {
      // Update existing record
      recentRecord.tokens = tokens;
      recentRecord.cost = cost;
      recentRecord.messageCount = messageCount;
      recentRecord.model = model;
      recentRecord.timestamp = new Date().toISOString();
    } else {
      // Add new record
      data.records.push({
        sessionId,
        sessionPath,
        cwd,
        model,
        tokens,
        cost,
        messageCount,
        timestamp: new Date().toISOString(),
      });
    }

    // Keep only last 1000 records to prevent file bloat
    if (data.records.length > 1000) {
      data.records = data.records.slice(-1000);
    }

    await saveUsageData(data);

    res.json({ success: true });
  } catch (error) {
    logger.error('Error recording usage:', error);
    res.status(500).json({ error: 'Failed to record usage' });
  }
});

/**
 * GET /api/usage - Get usage statistics
 */
router.get('/', async (_req: Request, res: Response) => {
  try {
    const data = await loadUsageData();

    // Calculate aggregates
    const totals = data.records.reduce(
      (acc, r) => ({
        input: acc.input + r.tokens.input,
        output: acc.output + r.tokens.output,
        cacheRead: acc.cacheRead + r.tokens.cacheRead,
        cacheWrite: acc.cacheWrite + r.tokens.cacheWrite,
        total: acc.total + r.tokens.total,
        cost: acc.cost + r.cost,
        sessions: acc.sessions + 1,
        messages: acc.messages + (r.messageCount || 0),
      }),
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0, sessions: 0, messages: 0 }
    );

    // Group by model
    const byModel: Record<string, { count: number; tokens: number; cost: number }> = {};
    for (const r of data.records) {
      if (!byModel[r.model]) {
        byModel[r.model] = { count: 0, tokens: 0, cost: 0 };
      }
      byModel[r.model].count++;
      byModel[r.model].tokens += r.tokens.total;
      byModel[r.model].cost += r.cost;
    }

    // Group by day (last 7 days)
    const last7Days: Record<string, { tokens: number; cost: number; sessions: number }> = {};
    const now = Date.now();
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
    
    for (const r of data.records) {
      const timestamp = new Date(r.timestamp).getTime();
      if (timestamp >= sevenDaysAgo) {
        const day = new Date(r.timestamp).toISOString().split('T')[0];
        if (!last7Days[day]) {
          last7Days[day] = { tokens: 0, cost: 0, sessions: 0 };
        }
        last7Days[day].tokens += r.tokens.total;
        last7Days[day].cost += r.cost;
        last7Days[day].sessions++;
      }
    }

    // Group by project (cwd)
    const byProject: Record<string, { tokens: number; cost: number; sessions: number }> = {};
    for (const r of data.records) {
      const project = r.cwd?.split('/').pop() || 'unknown';
      if (!byProject[project]) {
        byProject[project] = { tokens: 0, cost: 0, sessions: 0 };
      }
      byProject[project].tokens += r.tokens.total;
      byProject[project].cost += r.cost;
      byProject[project].sessions++;
    }

    res.json({
      totals,
      byModel,
      byProject,
      last7Days,
      recentRecords: data.records.slice(-20).reverse(),
      lastUpdated: data.lastUpdated,
    });
  } catch (error) {
    logger.error('Error getting usage stats:', error);
    res.status(500).json({ error: 'Failed to get usage stats' });
  }
});

/**
 * DELETE /api/usage - Clear usage history
 */
router.delete('/', async (_req: Request, res: Response) => {
  try {
    await saveUsageData({ records: [], lastUpdated: new Date().toISOString() });
    res.json({ success: true });
  } catch (error) {
    logger.error('Error clearing usage:', error);
    res.status(500).json({ error: 'Failed to clear usage' });
  }
});

export default router;
