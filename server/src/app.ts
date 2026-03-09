import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import authRoutes from './routes/auth.js';

export function createApp(): express.Application {
  const app = express();

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

  // Health check endpoint
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Auth routes
  app.use('/api/auth', authRoutes);

  return app;
}

export default createApp;
