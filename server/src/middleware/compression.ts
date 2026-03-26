import compression from 'compression';
import { Request, Response, NextFunction } from 'express';

/**
 * Performance metrics interface for compression monitoring
 */
export interface CompressionMetrics {
  originalSize: number;
  compressedSize: number;
  ratio: number;
}

/**
 * Compression middleware for reducing response payload sizes.
 * 
 * Configuration:
 * - threshold: 1KB minimum response size to compress
 * - level: 6 (balanced between CPU usage and compression ratio)
 * - filter: Custom logic to skip images, videos, and unsupported clients
 */
export const compressionMiddleware = compression({
  // Only compress responses larger than 1KB
  threshold: 1024,

  // Compression level (1-9, 6 is default, 9 is max compression)
  level: 6,

  // Filter to decide what to compress
  filter: (req: Request, res: Response) => {
    // Don't compress if client doesn't accept gzip
    if (req.headers['accept-encoding']?.includes('gzip') === false) {
      return false;
    }

    // Don't compress already compressed content (images, videos, etc.)
    const contentType = res.getHeader('Content-Type');
    if (contentType) {
      const contentTypeStr = String(contentType);
      if (
        contentTypeStr.includes('image') ||
        contentTypeStr.includes('video') ||
        contentTypeStr.includes('audio') ||
        contentTypeStr.includes('application/zip') ||
        contentTypeStr.includes('application/gzip') ||
        contentTypeStr.includes('application/x-gzip')
      ) {
        return false;
      }
    }

    // Use default filter for everything else
    return compression.filter(req, res);
  },
});
