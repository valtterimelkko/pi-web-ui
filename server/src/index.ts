import dotenv from 'dotenv';
dotenv.config();

import { createApp } from './app.js';
import { config } from './config.js';

const app = createApp();

const server = app.listen(config.port, () => {
  console.log(`Pi Web UI Server running on port ${config.port}`);
  console.log(`Health check: http://localhost:${config.port}/health`);
  console.log(`Allowed origins: ${config.allowedOrigins.join(', ')}`);
});

export { app, server };
