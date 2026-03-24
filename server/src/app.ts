import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import authRoutes from './routes/auth.js';
import sessionsRoutes from './routes/sessions.js';
import modelsRoutes from './routes/models.js';
import filesRoutes from './routes/files.js';
import extensionsRoutes from './routes/extensions.js';
import preferencesRoutes from './routes/preferences.js';
import worktreesRoutes from './routes/worktrees.js';
import healthRoutes from './routes/health.js';
import configRoutes from './routes/config.js';
import usageRoutes from './routes/usage.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface AppWithWs {
  app: express.Application;
  getWebSocketStats: () => { connectedClients: number } | null;
}

export function createApp(): express.Application {
  const app = express();

  // Trust proxy (required for rate limiting behind reverse proxy)
  app.set('trust proxy', 1);

  // Security middleware
  app.use(helmet());

  // CORS configuration
  app.use(cors({
    origin: config.allowedOrigins,
    credentials: true,
  }));

  // Body parsing
  app.use(express.json());

  // Rate limiting
  app.use(rateLimit({
    windowMs: config.rateLimitWindowMs,
    max: config.rateLimitMax,
    message: { error: 'Too many requests, please try again later.' },
  }));

  // Health check endpoints (no auth required)
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });
  app.use('/api/health', healthRoutes);

  // Config validation (requires auth)
  app.use('/api/config', configRoutes);

  // Auth routes
  app.use('/api/auth', authRoutes);

  // Session management routes
  app.use('/api/sessions', sessionsRoutes);

  // Model management routes
  app.use('/api/models', modelsRoutes);

  // File browser routes
  app.use('/api/files', filesRoutes);

  // Extension management routes
  app.use('/api/extensions', extensionsRoutes);

  // Web UI preferences (archive state, etc.)
  app.use('/api/preferences', preferencesRoutes);

  // Parallel orchestration worktrees
  app.use('/api/worktrees', worktreesRoutes);

  // Token usage tracking
  app.use('/api/usage', usageRoutes);

  // Serve static files from client/dist in production
  if (config.nodeEnv === 'production') {
    const staticPath = join(__dirname, '../../client/dist');
    app.use(express.static(staticPath));
    
    // Serve index.html for all non-API routes (SPA support)
    app.get('*', (_req, res) => {
      res.sendFile(join(staticPath, 'index.html'));
    });
  }

  return app;
}

export default createApp;
