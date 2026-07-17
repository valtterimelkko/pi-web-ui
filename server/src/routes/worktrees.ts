/**
 * Worktree API Routes
 *
 * REST API for git worktree management in parallel orchestration.
 *
 * Security: the entire router is behind `cookieAuthMiddleware` and the API rate
 * limiter. `repoPath`/`planPath` are canonicalised with `realpath` and verified
 * to be a git repository / regular file before any filesystem access or git
 * invocation. All git execution happens through `execFile` argument arrays in
 * `WorktreeManager` (no shell interpolation).
 */

import { Router, Request, Response } from 'express';
import { createWorktreeManager, WorktreeManager, WorktreeInfo } from '../pi/parallel/worktree-manager.js';
import { parsePlanFile, validatePlan } from '../pi/parallel/plan-parser.js';
import { z } from 'zod';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { cookieAuthMiddleware } from '../middleware/auth.js';
import { apiLimiter } from '../security/rate-limit.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('Worktrees');


const router = Router();

// The whole browser worktree surface is privileged: require auth + rate limit.
router.use(cookieAuthMiddleware);
router.use(apiLimiter);

// In-memory store for worktree managers (one per repo)
const worktreeManagers = new Map<string, WorktreeManager>();

/**
 * Get or create worktree manager for a repo path
 */
async function getManager(repoPath: string): Promise<WorktreeManager> {
  let manager = worktreeManagers.get(repoPath);
  if (!manager) {
    manager = await createWorktreeManager(repoPath);
    worktreeManagers.set(repoPath, manager);
  }
  return manager;
}

/**
 * ValidationError is a 400-class failure (bad client input); other errors stay
 * 500 so genuine operational failures are not misreported as bad requests.
 */
class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Canonicalise and validate a repository path. Resolves symlinks and traversal
 * (`..`) to the real path and requires the result to be a git work tree.
 *
 * The policy intentionally allows any real local git repository the operator
 * selects (this is a self-hosted, single-operator tool); it only rejects inputs
 * that are missing, not directories, or not git repositories.
 */
async function resolveRepoPath(repoPath: unknown): Promise<string> {
  if (typeof repoPath !== 'string' || repoPath.length === 0 || repoPath.length > 4096) {
    throw new ValidationError('repoPath is required');
  }
  let real: string;
  try {
    real = await fs.realpath(repoPath);
  } catch {
    throw new ValidationError('repoPath does not exist');
  }
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(real);
  } catch {
    throw new ValidationError('repoPath is not accessible');
  }
  if (!stat.isDirectory()) {
    throw new ValidationError('repoPath must be a directory');
  }
  // Verify it is a git work tree (`.git` is a directory for normal repos and a
  // file for linked worktrees).
  try {
    await fs.stat(path.join(real, '.git'));
  } catch {
    throw new ValidationError('repoPath is not a git repository');
  }
  return real;
}

/**
 * Canonicalise and validate a plan-file path. Resolves symlinks/traversal and
 * requires the result to be a regular file.
 */
async function resolvePlanPath(planPath: unknown): Promise<string> {
  if (typeof planPath !== 'string' || planPath.length === 0 || planPath.length > 4096) {
    throw new ValidationError('planPath is required');
  }
  let real: string;
  try {
    real = await fs.realpath(planPath);
  } catch {
    throw new ValidationError('planPath does not exist');
  }
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(real);
  } catch {
    throw new ValidationError('planPath is not accessible');
  }
  if (!stat.isFile()) {
    throw new ValidationError('planPath must be a file');
  }
  return real;
}

// Validation schemas (bounded). taskId/baseBranch are also ref-checked by the
// WorktreeManager before reaching git.
const CreateWorktreeSchema = z.object({
  taskId: z.string().min(1).max(64),
  baseBranch: z.string().min(1).max(200).optional().default('main'),
  taskDescription: z.string().min(1).max(1000),
  repoPath: z.string().min(1).max(4096),
});

const SyncWorktreeSchema = z.object({
  rebase: z.boolean().optional().default(false),
});

const MergeWorktreeSchema = z.object({
  strategy: z.enum(['merge', 'squash', 'rebase']).optional().default('merge'),
  message: z.string().max(2000).optional(),
});

/**
 * GET /api/worktrees
 * List all worktrees for a repository
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const repoPath = await resolveRepoPath(req.query.repoPath);

    const manager = await getManager(repoPath);
    const worktrees = await manager.listWorktrees();

    res.json({ worktrees });
  } catch (error) {
    if (error instanceof ValidationError) {
      return res.status(400).json({ error: error.message });
    }
    logger.error('[Worktrees] List error:', error);
    res.status(500).json({
      error: 'Failed to list worktrees',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/worktrees/:id
 * Get a specific worktree
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const repoPath = await resolveRepoPath(req.query.repoPath);

    const manager = await getManager(repoPath);
    const worktree = await manager.getWorktree(id);

    if (!worktree) {
      return res.status(404).json({ error: 'Worktree not found' });
    }

    res.json({ worktree });
  } catch (error) {
    if (error instanceof ValidationError) {
      return res.status(400).json({ error: error.message });
    }
    logger.error('[Worktrees] Get error:', error);
    res.status(500).json({
      error: 'Failed to get worktree',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/worktrees
 * Create a new worktree
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const data = CreateWorktreeSchema.parse(req.body);
    const repoPath = await resolveRepoPath(data.repoPath);

    const manager = await getManager(repoPath);
    const worktree = await manager.createWorktree({ ...data, repoPath });

    logger.info(`[Worktrees] Created worktree ${worktree.id} at ${worktree.path}`);
    res.status(201).json({ worktree });
  } catch (error) {
    if (error instanceof ValidationError) {
      return res.status(400).json({ error: error.message });
    }
    logger.error('[Worktrees] Create error:', error);
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation error', details: error.errors });
    }
    res.status(500).json({
      error: 'Failed to create worktree',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * PATCH /api/worktrees/:id/status
 * Update worktree status
 */
router.patch('/:id/status', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { status, sessionId } = req.body;
    const repoPath = await resolveRepoPath(req.body?.repoPath);

    const validStatuses = ['idle', 'running', 'completed', 'error', 'merged'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        error: 'Invalid status',
        validStatuses,
      });
    }

    const manager = await getManager(repoPath);
    await manager.updateWorktreeStatus(id, status, sessionId);

    const worktree = await manager.getWorktree(id);
    res.json({ worktree });
  } catch (error) {
    if (error instanceof ValidationError) {
      return res.status(400).json({ error: error.message });
    }
    logger.error('[Worktrees] Update status error:', error);
    res.status(500).json({
      error: 'Failed to update worktree status',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * DELETE /api/worktrees/:id
 * Delete a worktree
 */
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const repoPath = await resolveRepoPath(req.query.repoPath);
    const deleteBranch = req.query.deleteBranch === 'true';

    const manager = await getManager(repoPath);
    await manager.deleteWorktree(id, deleteBranch);

    logger.info(`[Worktrees] Deleted worktree ${id}`);
    res.json({ success: true, message: 'Worktree deleted' });
  } catch (error) {
    if (error instanceof ValidationError) {
      return res.status(400).json({ error: error.message });
    }
    logger.error('[Worktrees] Delete error:', error);
    res.status(500).json({
      error: 'Failed to delete worktree',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/worktrees/:id/sync
 * Sync worktree with base branch
 */
router.post('/:id/sync', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const repoPath = await resolveRepoPath(req.query.repoPath);
    const { rebase } = SyncWorktreeSchema.parse(req.body);

    const manager = await getManager(repoPath);
    const result = await manager.syncWorktree(id, rebase);

    res.json(result);
  } catch (error) {
    if (error instanceof ValidationError) {
      return res.status(400).json({ error: error.message });
    }
    logger.error('[Worktrees] Sync error:', error);
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation error', details: error.errors });
    }
    res.status(500).json({
      error: 'Failed to sync worktree',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/worktrees/:id/diff
 * Get diff between worktree and base branch
 */
router.get('/:id/diff', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const repoPath = await resolveRepoPath(req.query.repoPath);

    const manager = await getManager(repoPath);
    const diff = await manager.getWorktreeDiff(id);

    res.json({ diff });
  } catch (error) {
    if (error instanceof ValidationError) {
      return res.status(400).json({ error: error.message });
    }
    logger.error('[Worktrees] Diff error:', error);
    res.status(500).json({
      error: 'Failed to get worktree diff',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/worktrees/:id/conflicts
 * Get conflicts between worktree and base branch
 */
router.get('/:id/conflicts', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const repoPath = await resolveRepoPath(req.query.repoPath);

    const manager = await getManager(repoPath);
    const conflicts = await manager.getConflicts(id);

    res.json({ conflicts });
  } catch (error) {
    if (error instanceof ValidationError) {
      return res.status(400).json({ error: error.message });
    }
    logger.error('[Worktrees] Conflicts error:', error);
    res.status(500).json({
      error: 'Failed to get conflicts',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/worktrees/:id/merge
 * Merge worktree into base branch
 */
router.post('/:id/merge', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const repoPath = await resolveRepoPath(req.query.repoPath);
    const { strategy, message } = MergeWorktreeSchema.parse(req.body);

    const manager = await getManager(repoPath);
    const result = await manager.mergeWorktree(id, strategy, message);

    if (result.success) {
      logger.info(`[Worktrees] Merged worktree ${id} into base branch`);
    } else {
      logger.warn(`[Worktrees] Merge failed for ${id}: ${result.message}`);
    }

    res.json(result);
  } catch (error) {
    if (error instanceof ValidationError) {
      return res.status(400).json({ error: error.message });
    }
    logger.error('[Worktrees] Merge error:', error);
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation error', details: error.errors });
    }
    res.status(500).json({
      error: 'Failed to merge worktree',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// ============= Plan Parsing Endpoints =============

/**
 * POST /api/worktrees/parse-plan
 * Parse a plan file and return parallelizable tasks
 */
router.post('/parse-plan', async (req: Request, res: Response) => {
  try {
    const planPath = await resolvePlanPath(req.body?.planPath);

    const plan = await parsePlanFile(planPath);
    const validation = validatePlan(plan);

    res.json({
      plan: {
        title: plan.title,
        description: plan.description,
        tasks: plan.tasks,
        parallelGroups: plan.parallelGroups.map(group =>
          group.map(t => ({ id: t.id, title: t.title }))
        ),
      },
      validation,
    });
  } catch (error) {
    if (error instanceof ValidationError) {
      return res.status(400).json({ error: error.message });
    }
    logger.error('[Worktrees] Parse plan error:', error);
    res.status(500).json({
      error: 'Failed to parse plan',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/worktrees/orchestrate
 * Start an orchestration from a plan
 */
router.post('/orchestrate', async (req: Request, res: Response) => {
  try {
    const planPath = await resolvePlanPath(req.body?.planPath);
    const repoPath = await resolveRepoPath(req.body?.repoPath);
    const options = req.body?.options ?? {};

    // Parse the plan
    const plan = await parsePlanFile(planPath);
    const validation = validatePlan(plan);

    if (!validation.valid) {
      return res.status(400).json({
        error: 'Invalid plan',
        issues: validation.issues,
      });
    }

    // Create worktree manager
    const manager = await getManager(repoPath);

    // Create worktrees for first parallel group
    const firstGroup = plan.parallelGroups[0] || [];
    const worktrees: WorktreeInfo[] = [];

    for (const task of firstGroup) {
      const worktree = await manager.createWorktree({
        taskId: task.id,
        taskDescription: task.title,
        repoPath,
        baseBranch: options?.baseBranch || 'main',
      });
      worktrees.push(worktree);
    }

    const orchestrationId = `orch-${Date.now()}`;

    logger.info(`[Worktrees] Started orchestration ${orchestrationId} with ${worktrees.length} worktrees`);

    res.json({
      orchestrationId,
      plan: {
        title: plan.title,
        totalTasks: plan.tasks.length,
        parallelGroups: plan.parallelGroups.length,
      },
      worktrees,
      nextGroup: plan.parallelGroups[1]?.map(t => ({ id: t.id, title: t.title })) || [],
    });
  } catch (error) {
    if (error instanceof ValidationError) {
      return res.status(400).json({ error: error.message });
    }
    logger.error('[Worktrees] Orchestrate error:', error);
    res.status(500).json({
      error: 'Failed to start orchestration',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
