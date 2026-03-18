import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import extensionsRouter from '../../../src/routes/extensions.js';
import { getPiService } from '../../../src/pi/index.js';

// Mock PiService
vi.mock('../../../src/pi/index.js', () => ({
  getPiService: vi.fn(),
}));

// Mock auth middleware
vi.mock('../../../src/middleware/auth.js', () => ({
  cookieAuthMiddleware: (req: any, res: any, next: any) => {
    req.user = { userId: 'test-user' };
    next();
  },
}));

// Mock rate limiter
vi.mock('../../../src/security/rate-limit.js', () => ({
  apiLimiter: (req: any, res: any, next: any) => next(),
}));

describe('Extensions Routes', () => {
  let app: express.Application;

  const mockPiService = {
    getSkills: vi.fn(),
    getExtensionCommands: vi.fn(),
  };

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/extensions', extensionsRouter);
    
    vi.mocked(getPiService).mockReturnValue(mockPiService as any);
    
    mockPiService.getSkills.mockReset();
    mockPiService.getExtensionCommands.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /api/extensions', () => {
    it('should return extension commands grouped by extension', async () => {
      mockPiService.getExtensionCommands.mockReturnValue([
        { name: 'plan', description: 'Create a plan', extension: '/path/to/enhanced-plan-mode/index.ts' },
        { name: 'todos', description: 'View todos', extension: '/path/to/todo/index.ts' },
      ]);

      const response = await request(app)
        .get('/api/extensions')
        .expect(200);

      expect(response.body).toHaveProperty('extensions');
      expect(response.body).toHaveProperty('commands');
      expect(response.body.commands).toHaveLength(2);
    });
  });

  describe('GET /api/extensions/skills', () => {
    it('should return skills from resource loader', async () => {
      mockPiService.getSkills.mockReturnValue([
        { name: 'deep-research', description: 'Comprehensive research', path: '/path/to/skill.md', disableModelInvocation: false },
        { name: 'web-search', description: 'Search the web', path: '/path/to/skill2.md', disableModelInvocation: false },
      ]);

      const response = await request(app)
        .get('/api/extensions/skills')
        .expect(200);

      expect(response.body.skills).toHaveLength(2);
      expect(response.body.skills[0].name).toBe('deep-research');
      expect(response.body.skills[0].description).toBe('Comprehensive research');
    });

    it('should return empty array when no skills loaded', async () => {
      mockPiService.getSkills.mockReturnValue([]);

      const response = await request(app)
        .get('/api/extensions/skills')
        .expect(200);

      expect(response.body.skills).toHaveLength(0);
    });
  });

  describe('GET /api/extensions/commands', () => {
    it('should return combined list of all slash commands', async () => {
      mockPiService.getSkills.mockReturnValue([
        { name: 'deep-research', description: 'Research skill', path: '/path/to/skill.md', disableModelInvocation: false },
      ]);
      mockPiService.getExtensionCommands.mockReturnValue([
        { name: 'plan', description: 'Plan command', extension: '/path/to/ext.ts' },
      ]);

      const response = await request(app)
        .get('/api/extensions/commands')
        .expect(200);

      expect(response.body.commands).toHaveLength(6); // 4 builtin + 1 skill + 1 extension
      
      // Check builtin commands
      const builtinCommands = response.body.commands.filter((c: any) => c.type === 'builtin');
      expect(builtinCommands).toHaveLength(4);
      
      // Check skill command
      const skillCommands = response.body.commands.filter((c: any) => c.type === 'skill');
      expect(skillCommands).toHaveLength(1);
      expect(skillCommands[0].name).toBe('/skill:deep-research');
      
      // Check extension command
      const extCommands = response.body.commands.filter((c: any) => c.type === 'extension');
      expect(extCommands).toHaveLength(1);
      expect(extCommands[0].name).toBe('/plan');
    });

    it('should include proper command name format for skills', async () => {
      mockPiService.getSkills.mockReturnValue([
        { name: 'my-skill', description: 'Test skill', path: '/path/to/skill.md', disableModelInvocation: false },
      ]);
      mockPiService.getExtensionCommands.mockReturnValue([]);

      const response = await request(app)
        .get('/api/extensions/commands')
        .expect(200);

      const skillCmd = response.body.commands.find((c: any) => c.type === 'skill');
      expect(skillCmd.name).toBe('/skill:my-skill');
      expect(skillCmd.description).toBe('Test skill');
    });
  });
});
