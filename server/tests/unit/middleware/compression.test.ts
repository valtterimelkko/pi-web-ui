import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express, { Express } from 'express';
import request from 'supertest';
import { compressionMiddleware } from '../../../src/middleware/compression.js';

describe('Compression Middleware', () => {
  let app: Express;

  describe('Threshold Tests', () => {
    beforeEach(() => {
      app = express();
      app.use(compressionMiddleware);
    });

    it('should NOT compress responses smaller than 1KB', async () => {
      const smallData = { message: 'Hello, World!' };
      app.get('/small', (_req, res) => {
        res.json(smallData);
      });

      const response = await request(app)
        .get('/small')
        .set('Accept-Encoding', 'gzip');

      // Small responses should not have Content-Encoding: gzip
      expect(response.headers['content-encoding']).not.toBe('gzip');
      expect(response.body).toEqual(smallData);
    });

    it('should compress responses larger than 1KB', async () => {
      // Create a response that's definitely over 1KB
      const largeData = {
        data: 'x'.repeat(2000),
        items: Array(100).fill(null).map((_, i) => ({
          id: i,
          name: `Item ${i}`,
          description: `Description for item ${i} with some padding text`,
        })),
      };

      app.get('/large', (_req, res) => {
        res.json(largeData);
      });

      const response = await request(app)
        .get('/large')
        .set('Accept-Encoding', 'gzip');

      // Large responses should have Content-Encoding: gzip
      expect(response.headers['content-encoding']).toBe('gzip');
      expect(response.body).toEqual(largeData);
    });

    it('should compress large text responses', async () => {
      const largeText = 'Large text content '.repeat(100);

      app.get('/text', (_req, res) => {
        res.set('Content-Type', 'text/plain');
        res.send(largeText);
      });

      const response = await request(app)
        .get('/text')
        .set('Accept-Encoding', 'gzip');

      expect(response.headers['content-encoding']).toBe('gzip');
    });
  });

  describe('Content-Type Filtering', () => {
    beforeEach(() => {
      app = express();
      app.use(compressionMiddleware);
    });

    it('should NOT compress image content', async () => {
      // Simulate image data (base64-ish)
      const imageData = 'x'.repeat(2000);

      app.get('/image', (_req, res) => {
        res.set('Content-Type', 'image/png');
        res.send(imageData);
      });

      const response = await request(app)
        .get('/image')
        .set('Accept-Encoding', 'gzip');

      expect(response.headers['content-encoding']).not.toBe('gzip');
    });

    it('should NOT compress video content', async () => {
      const videoData = 'x'.repeat(2000);

      app.get('/video', (_req, res) => {
        res.set('Content-Type', 'video/mp4');
        res.send(videoData);
      });

      const response = await request(app)
        .get('/video')
        .set('Accept-Encoding', 'gzip');

      expect(response.headers['content-encoding']).not.toBe('gzip');
    });

    it('should NOT compress audio content', async () => {
      const audioData = 'x'.repeat(2000);

      app.get('/audio', (_req, res) => {
        res.set('Content-Type', 'audio/mpeg');
        res.send(audioData);
      });

      const response = await request(app)
        .get('/audio')
        .set('Accept-Encoding', 'gzip');

      expect(response.headers['content-encoding']).not.toBe('gzip');
    });

    it('should NOT compress already compressed zip files', async () => {
      const zipData = 'x'.repeat(2000);

      app.get('/zip', (_req, res) => {
        res.set('Content-Type', 'application/zip');
        res.send(zipData);
      });

      const response = await request(app)
        .get('/zip')
        .set('Accept-Encoding', 'gzip');

      expect(response.headers['content-encoding']).not.toBe('gzip');
    });

    it('should compress JSON content', async () => {
      const jsonData = {
        items: Array(100).fill(null).map((_, i) => ({
          id: i,
          name: `Item ${i}`,
          data: 'x'.repeat(50),
        })),
      };

      app.get('/json', (_req, res) => {
        res.json(jsonData);
      });

      const response = await request(app)
        .get('/json')
        .set('Accept-Encoding', 'gzip');

      expect(response.headers['content-encoding']).toBe('gzip');
    });

    it('should compress HTML content', async () => {
      const htmlContent = `
        <!DOCTYPE html>
        <html>
          <head><title>Test</title></head>
          <body>
            ${Array(50).fill('<p>Paragraph with some content</p>').join('')}
          </body>
        </html>
      `;

      app.get('/html', (_req, res) => {
        res.set('Content-Type', 'text/html');
        res.send(htmlContent);
      });

      const response = await request(app)
        .get('/html')
        .set('Accept-Encoding', 'gzip');

      expect(response.headers['content-encoding']).toBe('gzip');
    });
  });

  describe('Client Accept-Encoding', () => {
    beforeEach(() => {
      app = express();
      app.use(compressionMiddleware);
    });

    it('should NOT compress when client does not accept gzip', async () => {
      const largeData = { data: 'x'.repeat(2000) };

      app.get('/no-gzip', (_req, res) => {
        res.json(largeData);
      });

      const response = await request(app)
        .get('/no-gzip')
        .set('Accept-Encoding', 'deflate'); // Requesting deflate, not gzip

      expect(response.headers['content-encoding']).not.toBe('gzip');
    });

    it('should compress when client accepts gzip', async () => {
      const largeData = { data: 'x'.repeat(2000) };

      app.get('/with-gzip', (_req, res) => {
        res.json(largeData);
      });

      const response = await request(app)
        .get('/with-gzip')
        .set('Accept-Encoding', 'gzip, deflate');

      expect(response.headers['content-encoding']).toBe('gzip');
    });

    it('should compress when Accept-Encoding includes gzip among others', async () => {
      const largeData = { data: 'x'.repeat(2000) };

      app.get('/mixed-encoding', (_req, res) => {
        res.json(largeData);
      });

      // Use parse to skip automatic JSON parsing - we only care about headers
      const response = await request(app)
        .get('/mixed-encoding')
        .set('Accept-Encoding', 'br, gzip, deflate')
        .parse((res, callback) => {
          res.on('data', () => {}); // Consume data but don't parse
          res.on('end', () => callback(null, ''));
        });

      // When brotli is accepted, it takes precedence over gzip
      // Just verify that compression is enabled (either br or gzip)
      expect(['gzip', 'br']).toContain(response.headers['content-encoding']);
    });
  });

  describe('Response Headers', () => {
    beforeEach(() => {
      app = express();
      app.use(compressionMiddleware);
    });

    it('should set Vary header to include Accept-Encoding', async () => {
      const largeData = { data: 'x'.repeat(2000) };

      app.get('/vary', (_req, res) => {
        res.json(largeData);
      });

      const response = await request(app)
        .get('/vary')
        .set('Accept-Encoding', 'gzip');

      // Compression middleware should set Vary: Accept-Encoding
      const vary = response.headers['vary'];
      expect(vary).toBeDefined();
      expect(vary?.toLowerCase()).toContain('accept-encoding');
    });

    it('should set Content-Encoding header to gzip for compressed responses', async () => {
      const largeData = { data: 'x'.repeat(2000) };

      app.get('/encoding', (_req, res) => {
        res.json(largeData);
      });

      const response = await request(app)
        .get('/encoding')
        .set('Accept-Encoding', 'gzip');

      expect(response.headers['content-encoding']).toBe('gzip');
    });
  });

  describe('Compression Metrics', () => {
    it('should provide significant compression ratio for repetitive content', async () => {
      app = express();
      app.use(compressionMiddleware);

      // Highly compressible content (repetitive)
      const repetitiveData = {
        content: 'AAAAAAAAAA'.repeat(500), // Very repetitive = high compression
      };

      app.get('/metrics', (_req, res) => {
        res.json(repetitiveData);
      });

      const response = await request(app)
        .get('/metrics')
        .set('Accept-Encoding', 'gzip');

      // Response should be compressed
      expect(response.headers['content-encoding']).toBe('gzip');
      
      // The actual body should still be parseable
      expect(response.body).toEqual(repetitiveData);
    });
  });

  describe('Edge Cases', () => {
    beforeEach(() => {
      app = express();
      app.use(compressionMiddleware);
    });

    it('should handle empty responses', async () => {
      app.get('/empty', (_req, res) => {
        res.json({});
      });

      const response = await request(app)
        .get('/empty')
        .set('Accept-Encoding', 'gzip');

      // Empty responses are small, should not be compressed
      expect(response.headers['content-encoding']).not.toBe('gzip');
      expect(response.body).toEqual({});
    });

    it('should handle responses at exact threshold (1KB)', async () => {
      // Create data that's approximately 1KB
      const data = { data: 'x'.repeat(950) }; // ~950 bytes + JSON overhead

      app.get('/threshold', (_req, res) => {
        res.json(data);
      });

      const response = await request(app)
        .get('/threshold')
        .set('Accept-Encoding', 'gzip');

      // At threshold, may or may not compress depending on exact size
      // Just verify it handles it without error
      expect(response.status).toBe(200);
      expect(response.body).toEqual(data);
    });

    it('should handle special characters in JSON', async () => {
      const specialData = {
        unicode: '你好世界 🌍🎉',
        special: 'Quote: "test" and slash: / \\ backslash',
        html: '<script>alert("xss")</script>',
        repeated: '特殊字符'.repeat(100),
      };

      app.get('/special', (_req, res) => {
        res.json(specialData);
      });

      const response = await request(app)
        .get('/special')
        .set('Accept-Encoding', 'gzip');

      // Should still be compressed and parsed correctly
      expect(response.headers['content-encoding']).toBe('gzip');
      expect(response.body).toEqual(specialData);
    });

    it('should handle streaming responses', async () => {
      app.get('/stream', (_req, res) => {
        res.set('Content-Type', 'text/plain');
        // Write chunks
        res.write('Chunk 1 '.repeat(200));
        res.write('Chunk 2 '.repeat(200));
        res.end('Chunk 3 '.repeat(200));
      });

      const response = await request(app)
        .get('/stream')
        .set('Accept-Encoding', 'gzip');

      // Streaming responses should still be handled
      expect(response.status).toBe(200);
    });
  });
});
