import { Router, type Request, type Response } from 'express';
import { config } from '../config.js';
import fs from 'fs/promises';
import os from 'os';
import { getWorkerPool } from './sessions.js';

const router = Router();

/**
 * GET /api/health/live - Liveness probe (is the server running?)
 * Used by Kubernetes/Docker to know if the container should be restarted.
 */
router.get('/live', (_req: Request, res: Response) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

/**
 * GET /api/health/ready - Readiness probe (is the server ready to accept traffic?)
 * Checks if critical dependencies are available:
 * - Pi agent directory exists
 * - Environment configuration is valid
 * - Worker pool has capacity
 */
router.get('/ready', async (_req: Request, res: Response) => {
  const checks: Record<string, { status: 'ok' | 'error' | 'warning'; message?: string }> = {};
  let allHealthy = true;

  // Check 1: Pi agent directory exists and is accessible
  try {
    const stat = await fs.stat(config.piAgentDir);
    if (!stat.isDirectory()) {
      throw new Error('Not a directory');
    }
    checks.piAgentDir = { status: 'ok', message: config.piAgentDir };
  } catch (error) {
    checks.piAgentDir = { 
      status: 'error', 
      message: `Pi agent directory not accessible: ${config.piAgentDir}` 
    };
    allHealthy = false;
  }

  // Check 2: Required environment variables in production
  if (config.nodeEnv === 'production') {
    const requiredVars = ['JWT_SECRET', 'CSRF_SECRET', 'AUTH_PASSWORD'];
    const missing = requiredVars.filter(v => !process.env[v]);
    if (missing.length > 0) {
      checks.envConfig = { 
        status: 'error', 
        message: `Missing required env vars: ${missing.join(', ')}` 
      };
      allHealthy = false;
    } else {
      checks.envConfig = { status: 'ok', message: 'All required env vars set' };
    }
  } else {
    checks.envConfig = { status: 'ok', message: 'Development mode - env vars optional' };
  }

  // Check 3: Memory usage (warn if > 90%)
  const memUsage = process.memoryUsage();
  const totalMem = os.totalmem();
  const heapUsedPercent = (memUsage.heapUsed / memUsage.heapTotal) * 100;
  
  checks.memory = {
    status: heapUsedPercent > 90 ? 'error' : 'ok',
    message: `Heap usage: ${heapUsedPercent.toFixed(1)}% (${(memUsage.heapUsed / 1024 / 1024).toFixed(1)}MB / ${(memUsage.heapTotal / 1024 / 1024).toFixed(1)}MB)`,
  };
  
  if (heapUsedPercent > 90) {
    allHealthy = false;
  }

  // Check 4: Worker pool status
  let workerStats = null;
  try {
    const pool = getWorkerPool();
    workerStats = pool.getStats();
    
    const hasCapacity = workerStats.total < workerStats.maxWorkers;
    const atMaxCapacity = workerStats.total >= workerStats.maxWorkers;
    
    if (atMaxCapacity) {
      checks.workerPool = {
        status: 'error',
        message: `Worker pool at max capacity (${workerStats.total}/${workerStats.maxWorkers} workers)`,
      };
      allHealthy = false;
    } else if (workerStats.total >= workerStats.maxWorkers * 0.8) {
      // Warning if at 80% capacity
      checks.workerPool = {
        status: 'warning',
        message: `Worker pool near capacity (${workerStats.total}/${workerStats.maxWorkers} workers, ${workerStats.active} active)`,
      };
    } else {
      checks.workerPool = {
        status: 'ok',
        message: `Worker pool healthy (${workerStats.total}/${workerStats.maxWorkers} workers, ${workerStats.active} active, ${workerStats.idle} idle)`,
      };
    }
  } catch (error) {
    checks.workerPool = {
      status: 'error',
      message: `Worker pool unavailable: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
    allHealthy = false;
  }

  const response: {
    status: string;
    timestamp: string;
    uptime: number;
    version: string;
    nodeEnv: string;
    checks: typeof checks;
    workerStats?: typeof workerStats;
  } = {
    status: allHealthy ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: process.env.npm_package_version || 'unknown',
    nodeEnv: config.nodeEnv,
    checks,
  };

  // Include worker stats in response when available
  if (workerStats) {
    response.workerStats = workerStats;
  }

  res.status(allHealthy ? 200 : 503).json(response);
});

/**
 * GET /api/health - General health check (legacy + comprehensive)
 */
router.get('/', (_req: Request, res: Response) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: process.env.npm_package_version || 'unknown',
    nodeEnv: config.nodeEnv,
  });
});

export default router;
