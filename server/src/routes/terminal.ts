import { Router } from 'express';
import { cookieAuthMiddleware } from '../middleware/auth.js';
import { terminalManager } from '../terminal/terminal-manager.js';

const router = Router();
router.use(cookieAuthMiddleware);

// GET /api/terminal/status
router.get('/status', (_req, res) => {
  res.json({
    available: terminalManager.isAvailable(),
    terminals: terminalManager.list(),
  });
});

// DELETE /api/terminal/:clientId
router.delete('/:clientId', (req, res) => {
  const { clientId } = req.params;
  terminalManager.destroy(clientId);
  res.json({ success: true });
});

export { router as terminalRouter };
