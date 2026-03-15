import { Router, type Request, type Response } from 'express';
import { cookieAuthMiddleware } from '../middleware/auth.js';
import { apiLimiter } from '../security/rate-limit.js';
import fs from 'fs/promises';
import path from 'path';
import { createWriteStream, mkdirSync } from 'fs';
import { randomUUID } from 'crypto';

// Upload directory
const UPLOAD_DIR = '/tmp/pi-uploads';

// Ensure upload directory exists
try {
  mkdirSync(UPLOAD_DIR, { recursive: true });
} catch {
  // Directory may already exist
}

const router = Router();

router.use(cookieAuthMiddleware);
router.use(apiLimiter);

// Allowed directories for file browsing
function getAllowedDirectories(): string[] {
  // Default to cwd and home directory
  return [
    process.cwd(),
    process.env.HOME || '/root',
  ];
}

// Validate path is within allowed directories
async function validatePath(requestedPath: string): Promise<string | null> {
  const allowedDirs = getAllowedDirectories();
  
  try {
    const resolved = path.resolve(requestedPath);
    const real = await fs.realpath(resolved);
    
    for (const allowed of allowedDirs) {
      const allowedReal = await fs.realpath(allowed);
      if (real.startsWith(allowedReal)) {
        return real;
      }
    }
    
    return null;
  } catch {
    return null;
  }
}

// GET /api/files/browse - Browse directory
router.get('/browse', async (req: Request, res: Response) => {
  try {
    const requestedPath = (req.query.path as string) || process.cwd();
    
    const validatedPath = await validatePath(requestedPath);
    if (!validatedPath) {
      res.status(403).json({ error: 'Access denied to this path' });
      return;
    }
    
    const entries = await fs.readdir(validatedPath, { withFileTypes: true });
    
    const items = await Promise.all(
      entries.map(async (entry) => {
        const itemPath = path.join(validatedPath, entry.name);
        let size = 0;
        
        try {
          if (entry.isFile()) {
            const stat = await fs.stat(itemPath);
            size = stat.size;
          }
        } catch {
          // Ignore stat errors
        }
        
        return {
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
          path: itemPath,
          size,
        };
      })
    );
    
    // Sort: directories first, then files, alphabetically
    items.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
    
    res.json({
      path: validatedPath,
      parent: path.dirname(validatedPath),
      items,
    });
  } catch (error) {
    console.error('Error browsing files:', error);
    res.status(500).json({ error: 'Failed to browse directory' });
  }
});

// GET /api/files/read - Read file contents
router.get('/read', async (req: Request, res: Response) => {
  try {
    const requestedPath = req.query.path as string;
    // Note: offset and limit are parsed but not used in this implementation
    // Future versions could support line-based pagination
    const _offset = parseInt(req.query.offset as string) || 1;
    const _limit = parseInt(req.query.limit as string) || 2000;
    
    if (!requestedPath) {
      res.status(400).json({ error: 'path is required' });
      return;
    }
    
    const validatedPath = await validatePath(requestedPath);
    if (!validatedPath) {
      res.status(403).json({ error: 'Access denied to this path' });
      return;
    }
    
    // Check file size
    const stat = await fs.stat(validatedPath);
    const maxSize = 200 * 1024; // Increased to 200KB limit
    
    if (stat.size > maxSize) {
      // For large files, only read the beginning
      const handle = await fs.open(validatedPath, 'r');
      const buffer = Buffer.alloc(maxSize);
      await handle.read(buffer, 0, maxSize, 0);
      await handle.close();
      
      let content = buffer.toString('utf-8');
      // Truncate to last newline
      const lastNewline = content.lastIndexOf('\n');
      if (lastNewline > 0) {
        content = content.substring(0, lastNewline);
      }
      
      res.json({
        content,
        truncated: true,
        totalSize: stat.size,
        readSize: content.length,
      });
      return;
    }
    
    const content = await fs.readFile(validatedPath, 'utf-8');
    
    res.json({
      content,
      truncated: false,
      totalSize: stat.size,
    });
  } catch (error) {
    console.error('Error reading file:', error);
    res.status(500).json({ error: 'Failed to read file' });
  }
});

// POST /api/files/upload - Upload a file to /tmp/pi-uploads/
router.post('/upload', async (req: Request, res: Response) => {
  try {
    const contentType = req.headers['content-type'] || '';
    const fileName = req.headers['x-filename'] as string;

    if (!fileName) {
      res.status(400).json({ error: 'x-filename header is required' });
      return;
    }

    // Sanitize filename (remove path separators and dots at the start)
    const sanitizedName = path.basename(fileName).replace(/^\.+/, '');
    if (!sanitizedName) {
      res.status(400).json({ error: 'Invalid filename' });
      return;
    }

    // Generate unique filename
    const uniqueId = randomUUID().split('-')[0];
    const ext = path.extname(sanitizedName);
    const base = path.basename(sanitizedName, ext);
    const savedName = `${base}-${uniqueId}${ext}`;
    const savedPath = path.join(UPLOAD_DIR, savedName);

    // Ensure upload directory exists
    await fs.mkdir(UPLOAD_DIR, { recursive: true });

    // Stream the request body to file
    await new Promise<void>((resolve, reject) => {
      const writeStream = createWriteStream(savedPath);
      req.on('error', reject);
      writeStream.on('error', reject);
      writeStream.on('finish', resolve);
      req.pipe(writeStream);
    });

    // Get file size
    const stat = await fs.stat(savedPath);

    res.json({
      success: true,
      path: savedPath,
      name: sanitizedName,
      savedName,
      size: stat.size,
      mimeType: contentType.split(';')[0] || 'application/octet-stream',
    });
  } catch (error) {
    console.error('Error uploading file:', error);
    res.status(500).json({ error: 'Failed to upload file' });
  }
});

export default router;
