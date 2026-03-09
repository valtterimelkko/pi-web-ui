import { Router, type Request, type Response } from 'express';
import { cookieAuthMiddleware } from '../middleware/auth.js';
import { apiLimiter } from '../security/rate-limit.js';
import fs from 'fs/promises';
import path from 'path';
import { config } from '../config.js';

const router = Router();

router.use(cookieAuthMiddleware);
router.use(apiLimiter);

// GET /api/extensions - List loaded extensions
router.get('/', async (req: Request, res: Response) => {
  try {
    const extensionsDir = path.join(config.piAgentDir, 'extensions');
    const extensions: Array<{
      name: string;
      path: string;
      enabled: boolean;
    }> = [];
    
    try {
      const entries = await fs.readdir(extensionsDir, { withFileTypes: true });
      
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const indexPath = path.join(extensionsDir, entry.name, 'index.ts');
          const directPath = path.join(extensionsDir, `${entry.name}.ts`);
          
          try {
            await fs.access(indexPath);
            extensions.push({
              name: entry.name,
              path: indexPath,
              enabled: true, // TODO: Track enabled/disabled state
            });
          } catch {
            try {
              await fs.access(directPath);
              extensions.push({
                name: entry.name,
                path: directPath,
                enabled: true,
              });
            } catch {
              // Not a valid extension
            }
          }
        } else if (entry.isFile() && entry.name.endsWith('.ts')) {
          extensions.push({
            name: entry.name.replace('.ts', ''),
            path: path.join(extensionsDir, entry.name),
            enabled: true,
          });
        }
      }
    } catch {
      // Extensions directory doesn't exist
    }
    
    res.json({ extensions });
  } catch (error) {
    console.error('Error listing extensions:', error);
    res.status(500).json({ error: 'Failed to list extensions' });
  }
});

// POST /api/extensions/:name/toggle - Toggle extension on/off
router.post('/:name/toggle', async (req: Request, res: Response) => {
  try {
    const { name } = req.params;
    const { enabled } = req.body;
    
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled must be a boolean' });
      return;
    }
    
    // TODO: Implement extension state persistence
    // For now, just return success
    
    res.json({ 
      success: true, 
      name,
      enabled,
      message: 'Extension toggling requires server restart',
    });
  } catch (error) {
    console.error('Error toggling extension:', error);
    res.status(500).json({ error: 'Failed to toggle extension' });
  }
});

// GET /api/extensions/skills - List loaded skills
router.get('/skills', async (req: Request, res: Response) => {
  try {
    const skillsDir = path.join(config.piAgentDir, 'skills');
    const skills: Array<{
      name: string;
      path: string;
    }> = [];
    
    try {
      const entries = await fs.readdir(skillsDir, { withFileTypes: true });
      
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const skillPath = path.join(skillsDir, entry.name, 'SKILL.md');
          try {
            await fs.access(skillPath);
            skills.push({
              name: entry.name,
              path: skillPath,
            });
          } catch {
            // Not a valid skill
          }
        }
      }
    } catch {
      // Skills directory doesn't exist
    }
    
    res.json({ skills });
  } catch (error) {
    console.error('Error listing skills:', error);
    res.status(500).json({ error: 'Failed to list skills' });
  }
});

export default router;
