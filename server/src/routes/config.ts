import { Router, type Request, type Response } from 'express';
import { cookieAuthMiddleware } from '../middleware/auth.js';
import { config, ServerConfig } from '../config.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('Config');


const router = Router();

// Config routes require authentication
router.use(cookieAuthMiddleware);

/**
 * GET /api/config/validate - Validate current server configuration
 * Returns configuration status and any issues found.
 */
router.get('/validate', (_req: Request, res: Response) => {
  const issues: Array<{ field: string; severity: 'error' | 'warning'; message: string }> = [];
  const warnings: Array<{ field: string; message: string }> = [];
  
  // Check JWT_SECRET
  if (config.nodeEnv === 'production') {
    if (!process.env.JWT_SECRET) {
      issues.push({
        field: 'JWT_SECRET',
        severity: 'error',
        message: 'JWT_SECRET is required in production',
      });
    } else if (process.env.JWT_SECRET.length < 32) {
      warnings.push({
        field: 'JWT_SECRET',
        message: 'JWT_SECRET should be at least 32 characters for security',
      });
    }
  } else {
    if (!process.env.JWT_SECRET) {
      warnings.push({
        field: 'JWT_SECRET',
        message: 'Using default dev secret - set JWT_SECRET for production',
      });
    }
  }

  // Check CSRF_SECRET
  if (config.nodeEnv === 'production') {
    if (!process.env.CSRF_SECRET) {
      issues.push({
        field: 'CSRF_SECRET',
        severity: 'error',
        message: 'CSRF_SECRET is required in production',
      });
    }
  }

  // Check AUTH_PASSWORD
  if (config.nodeEnv === 'production') {
    const authPassword = process.env.AUTH_PASSWORD;
    if (!authPassword) {
      issues.push({
        field: 'AUTH_PASSWORD',
        severity: 'error',
        message: 'AUTH_PASSWORD is required in production',
      });
    } else if (!authPassword.startsWith('$2b$')) {
      issues.push({
        field: 'AUTH_PASSWORD',
        severity: 'error',
        message: 'AUTH_PASSWORD must be a bcrypt hash in production (use: node -e "logger.info(require(\'bcrypt\').hashSync(\'password\', 10))")',
      });
    }
  } else {
    if (!process.env.AUTH_PASSWORD) {
      warnings.push({
        field: 'AUTH_PASSWORD',
        message: 'Using default dev password - set AUTH_PASSWORD for production',
      });
    }
  }

  // Check ALLOWED_ORIGINS
  if (config.nodeEnv === 'production') {
    const defaultOrigins = ['http://localhost:5173', 'http://localhost:3000'];
    const hasDefaultOrigins = config.allowedOrigins.some(o => defaultOrigins.includes(o));
    if (hasDefaultOrigins) {
      warnings.push({
        field: 'ALLOWED_ORIGINS',
        message: 'ALLOWED_ORIGINS contains localhost URLs - ensure this is intended for production',
      });
    }
  }

  // Check rate limiting
  if (config.rateLimitMax > 1000) {
    warnings.push({
      field: 'RATE_LIMIT_MAX',
      message: 'Rate limit is very high (>1000 requests per window) - consider lowering for production',
    });
  }

  // Build response
  const validation = {
    valid: issues.filter(i => i.severity === 'error').length === 0,
    nodeEnv: config.nodeEnv,
    timestamp: new Date().toISOString(),
    issues,
    warnings,
    config: {
      // Safe config values (no secrets)
      port: config.port,
      nodeEnv: config.nodeEnv,
      jwtExpiresIn: config.jwtExpiresIn,
      allowedOrigins: config.allowedOrigins,
      rateLimitWindowMs: config.rateLimitWindowMs,
      rateLimitMax: config.rateLimitMax,
      piAgentDir: config.piAgentDir,
      sessionDir: config.sessionDir,
      hasJwtSecret: !!process.env.JWT_SECRET,
      hasCsrfSecret: !!process.env.CSRF_SECRET,
      hasAuthPassword: !!process.env.AUTH_PASSWORD,
      authPasswordIsHash: process.env.AUTH_PASSWORD?.startsWith('$2b$') ?? false,
    },
  };

  res.json(validation);
});

/**
 * GET /api/config - Get current safe configuration (no secrets)
 */
router.get('/', (_req: Request, res: Response) => {
  res.json({
    port: config.port,
    nodeEnv: config.nodeEnv,
    jwtExpiresIn: config.jwtExpiresIn,
    allowedOrigins: config.allowedOrigins,
    rateLimitWindowMs: config.rateLimitWindowMs,
    rateLimitMax: config.rateLimitMax,
    piAgentDir: config.piAgentDir,
    sessionDir: config.sessionDir,
  });
});

export default router;
