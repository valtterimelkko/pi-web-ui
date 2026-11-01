import { Router, type Request, type Response } from 'express';
import { cookieAuthMiddleware } from '../middleware/auth.js';
import { getPiService } from '../pi/index.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('Extensions');


const router = Router();

router.use(cookieAuthMiddleware);

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

// GET /api/extensions/commands - List the slash commands the browser can run
//                                  for ONE session's runtime
//
// B2: this list used to be runtime-blind and advertised `/clear`, `/export` and
// `/help` as Pi built-ins. Pi 1.4.0 has none of them reachable from the browser —
// the composer intercepts `/compact` (CompactModal) and any other built-in is
// sent to the model as plain text, so the palette promised commands that do
// nothing. Built-ins are now per runtime, and only the ones the web UI really
// runs are listed. Skills and extension commands come from the Pi runtime's own
// loader, so a non-pi session is offered none of them.
const BROWSER_BUILTINS: Record<string, Array<{ name: string; description: string }>> = {
  pi: [{ name: 'compact', description: 'Summarize conversation to free context' }],
};

const PI_ONLY_COMMANDS_REASON = 'Pi Web UI cannot run slash commands from the browser for this runtime yet; only a Pi session has any.';

router.get('/commands', async (req: Request, res: Response) => {
  try {
    const requested = typeof req.query.sdkType === 'string' ? req.query.sdkType.trim() : '';
    const sdkType = requested || 'pi';

    if (sdkType !== 'pi') {
      // Fail closed: an unknown runtime gets the same honest answer as a known
      // non-pi one — nothing is offered rather than Pi-only entries that would fail.
      res.json({ commands: [], unavailable: PI_ONLY_COMMANDS_REASON });
      return;
    }

    const piService = getPiService();
    const skills = piService.getSkills();
    const extensionCommands = piService.getExtensionCommands();

    // Build combined list of slash commands
    const commands: Array<{
      name: string;
      description: string;
      type: 'skill' | 'extension' | 'builtin';
    }> = [];

    // Add built-in commands that the browser really runs for this runtime
    for (const cmd of BROWSER_BUILTINS[sdkType] ?? []) {
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
