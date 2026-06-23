import { Router, type Request, type Response } from 'express';
import { cookieAuthMiddleware } from '../middleware/auth.js';
import { apiLimiter } from '../security/rate-limit.js';
import { getPiService } from '../pi/index.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('Extensions');


const router = Router();

router.use(cookieAuthMiddleware);
router.use(apiLimiter);

// GET /api/extensions - List loaded extensions with their commands
router.get('/', async (req: Request, res: Response) => {
  try {
    const piService = getPiService();
    const commands = piService.getExtensionCommands();
    
    // Group commands by extension
    const extensionsMap = new Map<string, {
      name: string;
      commands: Array<{ name: string; description: string }>;
    }>();
    
    for (const cmd of commands) {
      const extName = cmd.extension.split('/').pop()?.replace('.ts', '') || cmd.extension;
      if (!extensionsMap.has(extName)) {
        extensionsMap.set(extName, {
          name: extName,
          commands: [],
        });
      }
      extensionsMap.get(extName)!.commands.push({
        name: cmd.name,
        description: cmd.description,
      });
    }
    
    res.json({ 
      extensions: Array.from(extensionsMap.values()),
      commands,
    });
  } catch (error) {
    logger.error('Error listing extensions:', error);
    res.status(500).json({ error: 'Failed to list extensions' });
  }
});

// GET /api/extensions/skills - List loaded skills from resource loader
router.get('/skills', async (req: Request, res: Response) => {
  try {
    const piService = getPiService();
    const skills = piService.getSkills();
    
    res.json({ skills });
  } catch (error) {
    logger.error('Error listing skills:', error);
    res.status(500).json({ error: 'Failed to list skills' });
  }
});

// GET /api/extensions/commands - List all slash commands (skills + extension commands)
router.get('/commands', async (req: Request, res: Response) => {
  try {
    const piService = getPiService();
    const skills = piService.getSkills();
    const extensionCommands = piService.getExtensionCommands();
    
    // Build combined list of slash commands
    const commands: Array<{
      name: string;
      description: string;
      type: 'skill' | 'extension' | 'builtin';
    }> = [];
    
    // Add built-in commands
    const builtinCommands = [
      { name: 'compact', description: 'Summarize conversation to free context' },
      { name: 'clear', description: 'Clear the current conversation' },
      { name: 'export', description: 'Export session to file' },
      { name: 'help', description: 'Show available commands' },
    ];
    
    for (const cmd of builtinCommands) {
      commands.push({
        name: `/${cmd.name}`,
        description: cmd.description,
        type: 'builtin',
      });
    }
    
    // Add skills as /skill:name commands
    for (const skill of skills) {
      commands.push({
        name: `/skill:${skill.name}`,
        description: skill.description,
        type: 'skill',
      });
    }
    
    // Add extension commands
    for (const cmd of extensionCommands) {
      commands.push({
        name: `/${cmd.name}`,
        description: cmd.description,
        type: 'extension',
      });
    }
    
    res.json({ commands });
  } catch (error) {
    logger.error('Error listing commands:', error);
    res.status(500).json({ error: 'Failed to list commands' });
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
    logger.error('Error toggling extension:', error);
    res.status(500).json({ error: 'Failed to toggle extension' });
  }
});

export default router;
