import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Mock the pi service
vi.mock('../../../src/pi/pi-service.js', () => ({
  getPiService: vi.fn().mockReturnValue({
    getAvailableModels: vi.fn().mockResolvedValue([
      { id: 'openai/gpt-4', name: 'GPT-4', provider: 'openai' },
      { id: 'github-copilot/gpt-5.4', name: 'GPT-5.4', provider: 'github-copilot' },
      { id: 'kimi/k2.5', name: 'Kimi K2.5', provider: 'kimi' },
    ]),
  }),
}));

describe('Models API', () => {
  let app: express.Application;
  let mockPiService: {
    getAvailableModels: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    app = express();
    app.use(express.json());

    const { getPiService } = await import('../../../src/pi/pi-service.js');
    mockPiService = getPiService() as unknown as typeof mockPiService;

    // GET /api/models - List available models
    app.get('/api/models', async (_req, res) => {
      try {
        const { getPiService } = await import('../../../src/pi/pi-service.js');
        const models = await getPiService().getAvailableModels();
        res.json({ models });
      } catch (error) {
        console.error('Error listing models:', error);
        res.status(500).json({ error: 'Failed to list models' });
      }
    });

    // PUT /api/models/current - Set current model
    app.put('/api/models/current', async (req, res) => {
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
  });

  describe('GET /api/models', () => {
    it('should return a list of available models', async () => {
      const response = await request(app).get('/api/models').expect(200);

      expect(response.body).toHaveProperty('models');
      expect(Array.isArray(response.body.models)).toBe(true);
      expect(response.body.models.length).toBe(3);
      expect(response.body.models[0]).toHaveProperty('id');
      expect(response.body.models[0]).toHaveProperty('name');
      expect(response.body.models[0]).toHaveProperty('provider');
    });

    it('should handle errors gracefully', async () => {
      mockPiService.getAvailableModels.mockRejectedValue(new Error('Service unavailable'));

      const response = await request(app).get('/api/models').expect(500);

      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toBe('Failed to list models');
    });
  });

  describe('PUT /api/models/current', () => {
    it('should validate modelId is required', async () => {
      const response = await request(app)
        .put('/api/models/current')
        .send({})
        .expect(400);

      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('modelId is required');
    });

    it('should validate model ID format', async () => {
      const response = await request(app)
        .put('/api/models/current')
        .send({ modelId: 'invalid-format' })
        .expect(400);

      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('Invalid model ID format');
    });

    it('should accept valid provider/model format', async () => {
      const response = await request(app)
        .put('/api/models/current')
        .send({ modelId: 'github-copilot/gpt-5.4' })
        .expect(200);

      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('modelId', 'github-copilot/gpt-5.4');
      expect(response.body).toHaveProperty('provider', 'github-copilot');
      expect(response.body).toHaveProperty('model', 'gpt-5.4');
    });

    it('should handle model IDs with multiple slashes', async () => {
      const response = await request(app)
        .put('/api/models/current')
        .send({ modelId: 'provider/sub/model-name' })
        .expect(200);

      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('provider', 'provider');
      expect(response.body).toHaveProperty('model', 'sub/model-name');
    });
  });
});
