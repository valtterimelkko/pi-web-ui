import { Router, type Request, type Response } from 'express';
import { cookieAuthMiddleware } from '../middleware/auth.js';
import { getPiService } from '../pi/index.js';
import { getOpenCodeService } from '../opencode/index.js';
import { getAntigravityService } from '../antigravity/index.js';
import { getClaudeProfiles } from '../claude/index.js';
import { apiLimiter } from '../security/rate-limit.js';

const router = Router();

router.use(cookieAuthMiddleware);
router.use(apiLimiter);

// GET /api/models - List available models
router.get('/', async (req: Request, res: Response) => {
  try {
    const sdkType = typeof req.query.sdkType === 'string' ? req.query.sdkType : 'pi';

    if (sdkType === 'opencode') {
      const opencodeService = getOpenCodeService();
      const models = await opencodeService.getAvailableModels();
      res.json({ models });
      return;
    }

    if (sdkType === 'antigravity') {
      const antigravityService = getAntigravityService();
      const models = await antigravityService.getAvailableModels();
      res.json({ models });
      return;
    }

    if (sdkType === 'claude') {
      // Base alias models, always available for the Claude runtime.
      const models: Array<{ id: string; displayName: string; provider: string }> = [
        { id: 'sonnet', displayName: 'Claude Sonnet', provider: 'anthropic' },
        { id: 'opus', displayName: 'Claude Opus', provider: 'anthropic' },
        { id: 'haiku', displayName: 'Claude Haiku', provider: 'anthropic' },
      ];

      // When provider profiles are enabled, surface each enabled profile as a
      // selectable `profile:<id>` model entry so the browser can choose a
      // backend/provider (e.g. GLM 5.2 via SDK) at session-creation time.
      for (const profile of getClaudeProfiles()) {
        models.push({
          id: `profile:${profile.id}`,
          displayName: profile.label,
          provider: profile.baseUrl?.includes('z.ai') ? 'zai' : 'anthropic',
        });
      }

      res.json({ models });
      return;
    }

    const piService = getPiService();
    const models = await piService.getAvailableModels();
    
    res.json({ models });
  } catch (error) {
    console.error('Error listing models:', error);
    res.status(500).json({ error: 'Failed to list models' });
  }
});

// PUT /api/models/current - Set current model
router.put('/current', async (req: Request, res: Response) => {
  try {
    const { modelId } = req.body;
    
    if (!modelId) {
      res.status(400).json({ error: 'modelId is required' });
      return;
    }
    
    // Parse model ID (format: provider/model-name)
    const [provider, ...modelParts] = modelId.split('/');
    const modelName = modelParts.join('/');
    
    if (!provider || !modelName) {
      res.status(400).json({ error: 'Invalid model ID format. Expected: provider/model-name' });
      return;
    }
    
    // Note: Actual model setting happens per-session via WebSocket
    // This endpoint just validates and returns the model info
    
    res.json({ 
      success: true, 
      modelId,
      provider,
      model: modelName,
    });
  } catch (error) {
    console.error('Error setting model:', error);
    res.status(500).json({ error: 'Failed to set model' });
  }
});

export default router;
