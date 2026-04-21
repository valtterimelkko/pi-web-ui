import { Router, type Request, type Response } from 'express';
import { config } from '../config.js';
import fs from 'fs/promises';
import os from 'os';
import { getWorkerPool } from './sessions.js';
import { getCrashLogger } from '../workers/crash-logger.js';
import { getOpenCodeService } from '../opencode/index.js';

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

  // Check 5: OpenCode Direct availability
  try {
    const opencodeService = getOpenCodeService();
    const available = await opencodeService.isAvailable();
    if (available && config.opencodeServerEnabled) {
      checks.opencode = {
        status: 'ok',
        message: `OpenCode available (port ${config.opencodeServerPort})`,
      };
    } else {
      checks.opencode = {
        status: 'warning',
        message: available ? 'OpenCode available but disabled' : 'OpenCode not installed',
      };
    }
  } catch (error) {
    checks.opencode = {
      status: 'warning',
      message: `OpenCode check failed: ${error instanceof Error ? error.message : 'Unknown'}`,
    };
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

/**
 * GET /api/health/workers - Worker health and crash statistics
 */
router.get('/workers', (_req: Request, res: Response) => {
  try {
    const pool = getWorkerPool();
    const workerStats = pool.getStats();
    const crashStats = pool.getCrashStats();
    
    // Determine health status based on recent crashes
    let status = 'healthy';
    const warnings: string[] = [];
    
    if (crashStats.crashesLastHour > 5) {
      status = 'critical';
      warnings.push(`High crash rate: ${crashStats.crashesLastHour} crashes in the last hour`);
    } else if (crashStats.crashesLastHour > 0) {
      status = 'warning';
      warnings.push(`${crashStats.crashesLastHour} crash(es) in the last hour`);
    }
    
    if (crashStats.oomStats.last24h > 3) {
      status = status === 'critical' ? 'critical' : 'warning';
      warnings.push(`${crashStats.oomStats.last24h} OOM kill(s) in the last 24 hours - consider increasing PI_WORKER_MEMORY`);
    }
    
    if (workerStats.total >= workerStats.maxWorkers * 0.9) {
      warnings.push(`Worker pool near capacity: ${workerStats.total}/${workerStats.maxWorkers}`);
    }
    
    res.json({
      status,
      timestamp: new Date().toISOString(),
      warnings: warnings.length > 0 ? warnings : undefined,
      workerStats,
      crashStats,
    });
  } catch (error) {
    console.error('Error getting worker health:', error);
    res.status(500).json({
      status: 'error',
      timestamp: new Date().toISOString(),
      error: 'Failed to get worker health statistics',
    });
  }
});

export default router;
