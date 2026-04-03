import { Router } from 'express';
import { z } from 'zod';
import { cookieAuthMiddleware } from '../middleware/auth.js';
import { gitService } from '../git/git-service.js';

const router = Router();
router.use(cookieAuthMiddleware);

const CwdSchema = z.object({ cwd: z.string().min(1) });
const PathsSchema = CwdSchema.extend({ paths: z.array(z.string()).min(1) });

// GET /api/git/status?cwd=...
router.get('/status', async (req, res) => {
  try {
    const { cwd } = CwdSchema.parse({ cwd: req.query.cwd });
    const status = await gitService.getStatus(cwd);
    res.json(status);
  } catch (err: unknown) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// GET /api/git/branches?cwd=...
router.get('/branches', async (req, res) => {
  try {
    const { cwd } = CwdSchema.parse({ cwd: req.query.cwd });
    const result = await gitService.getBranches(cwd);
    res.json(result);
  } catch (err: unknown) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// GET /api/git/log?cwd=...&limit=50
router.get('/log', async (req, res) => {
  try {
    const { cwd } = CwdSchema.parse({ cwd: req.query.cwd });
    const limit = parseInt(String(req.query.limit || '50'), 10);
    const log = await gitService.getLog(cwd, limit);
    res.json(log);
  } catch (err: unknown) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// GET /api/git/diff?cwd=...&staged=false&file=...
router.get('/diff', async (req, res) => {
  try {
    const { cwd } = CwdSchema.parse({ cwd: req.query.cwd });
    const staged = req.query.staged === 'true';
    const file = req.query.file as string | undefined;
    const diff = await gitService.getDiff(cwd, { staged, file });
    res.json({ diff });
  } catch (err: unknown) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// POST /api/git/stage
router.post('/stage', async (req, res) => {
  try {
    const { cwd, paths } = PathsSchema.parse(req.body);
    await gitService.stage(cwd, paths);
    res.json({ success: true });
  } catch (err: unknown) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// POST /api/git/unstage
router.post('/unstage', async (req, res) => {
  try {
    const { cwd, paths } = PathsSchema.parse(req.body);
    await gitService.unstage(cwd, paths);
    res.json({ success: true });
  } catch (err: unknown) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// POST /api/git/discard
router.post('/discard', async (req, res) => {
  try {
    const { cwd, paths } = PathsSchema.parse(req.body);
    await gitService.discard(cwd, paths);
    res.json({ success: true });
  } catch (err: unknown) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// POST /api/git/commit
router.post('/commit', async (req, res) => {
  try {
    const { cwd } = CwdSchema.parse(req.body);
    const message = z.string().min(1).parse(req.body.message);
    const result = await gitService.commit(cwd, message);
    res.json({ success: true, output: result });
  } catch (err: unknown) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// POST /api/git/push
router.post('/push', async (req, res) => {
  try {
    const { cwd } = CwdSchema.parse(req.body);
    const remote = req.body.remote || 'origin';
    const branch = req.body.branch;
    const result = await gitService.push(cwd, remote, branch);
    res.json({ success: true, output: result });
  } catch (err: unknown) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// POST /api/git/pull
router.post('/pull', async (req, res) => {
  try {
    const { cwd } = CwdSchema.parse(req.body);
    const result = await gitService.pull(cwd);
    res.json({ success: true, output: result });
  } catch (err: unknown) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// POST /api/git/checkout
router.post('/checkout', async (req, res) => {
  try {
    const { cwd } = CwdSchema.parse(req.body);
    const branch = z.string().min(1).parse(req.body.branch);
    await gitService.checkout(cwd, branch);
    res.json({ success: true });
  } catch (err: unknown) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// POST /api/git/branch (create)
router.post('/branch', async (req, res) => {
  try {
    const { cwd } = CwdSchema.parse(req.body);
    const name = z.string().min(1).parse(req.body.name);
    await gitService.createBranch(cwd, name);
    res.json({ success: true });
  } catch (err: unknown) {
    res.status(400).json({ error: (err as Error).message });
  }
});

export { router as gitRouter };
